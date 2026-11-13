import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { createBeeperReader, type MediaReader, type MediaRef } from "../plans/beeper";
import { createPlansTables } from "../plans/schema";
import { addStance, insertPlan, type Plan } from "../plans/store";
import { dayKey } from "../telegram/time";
import { createGraphClient, GraphError, type GraphClient } from "./graph";
import { checkFile, sniff } from "./media";
import { chatFolderName, eventFolderName, formatEventDate, mediaFileName, sanitizeName } from "./names";
import { OneDriveAuth, OneDriveAuthError } from "./onedrive-auth";
import { runPhotos, type PhotoDeps } from "./pipeline";
import { createPhotosTables } from "./schema";
import { SWEEP_PAGES } from "./settings";
import { folderPathFromInput } from "./setup-cli";
import { countsForPlan, getPhotoPlan, getState, photoPlanFor, setState } from "./store";
import { findRuns, isEligible, photoWindow, planForMedia, type MediaItem, type WindowedPlan } from "./window";

const MIN = 60_000;
const GB = 1024 ** 3;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

const count = (db: Database.Database, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

function newDb(): Database.Database {
  const db = new Database(":memory:");
  createPlansTables(db);
  createPhotosTables(db);
  return db;
}

// ---------------------------------------------------------------- run counting, windows, assignment (pure)

const item = (over: Partial<MediaItem> & { min?: number } = {}): MediaItem => ({
  chatId: "G", messageId: over.messageId ?? `m${Math.random()}`, attachmentId: over.attachmentId ?? `mxc://x/${Math.random()}`, index: 0, senderId: "sam",
  ts: new Date(Date.UTC(2026, 6, 19, 6, 0, 0) + (over.min ?? 0) * MIN).toISOString(), kind: "IMAGE", mime: "image/jpeg", size: 1000, ...over,
});
const items = (senderId: string, mins: number[]) => mins.map((min, i) => item({ senderId, min, messageId: `${senderId}${i}`, attachmentId: `a-${senderId}-${i}` }));

describe("what counts as a run", () => {
  it("needs 4 or more: 3 is not a run, 4 is", () => {
    assert.equal(findRuns(items("sam", [0, 1, 2]), 4, 10 * MIN).length, 0);
    assert.equal(findRuns(items("sam", [0, 1, 2, 3]), 4, 10 * MIN).length, 1);
  });
  it("the 4 and the 10 minutes are settings", () => {
    assert.equal(findRuns(items("sam", [0, 1, 2]), 3, 10 * MIN).length, 1);
    assert.equal(findRuns(items("sam", [0, 6, 12, 18]), 4, 5 * MIN).length, 0);
    assert.equal(findRuns(items("sam", [0, 6, 12, 18]), 4, 6 * MIN).length, 1);
  });
  it("must be the same sender: two people with 2 each is not a run", () => {
    assert.equal(findRuns([...items("sam", [0, 1]), ...items("alex", [0, 1])], 4, 10 * MIN).length, 0);
  });
  it("another person's photos in between do not break a run (or count towards it)", () => {
    const sam = items("sam", [0, 2, 4, 6]);
    const alex = items("alex", [1, 3]);
    const runs = findRuns([...sam, ...alex], 4, 10 * MIN);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].map((i) => i.senderId), ["sam", "sam", "sam", "sam"]);
  });
  it("text messages in between do not matter: only media is looked at, and exactly 10 minutes apart still joins", () => {
    // Four photos with long text conversations between them (none of it appears here): 10 minutes apart each.
    assert.equal(findRuns(items("sam", [0, 10, 20, 30]), 4, 10 * MIN).length, 1);
  });
  it("a gap over 10 minutes ends the run: 3 + 3 is nothing, 4 + 2 saves the 4", () => {
    assert.equal(findRuns(items("sam", [0, 1, 2, 13, 14, 15]), 4, 10 * MIN).length, 0);
    const runs = findRuns(items("sam", [0, 1, 2, 3, 20, 21]), 4, 10 * MIN);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].length, 4);
  });
  it("an album: one message with several attachments counts every attachment", () => {
    const album = [0, 1, 2, 3].map((index) => item({ messageId: "one-message", attachmentId: `a${index}`, index }));
    assert.equal(findRuns(album, 4, 10 * MIN).length, 1);
    assert.equal(findRuns(album.slice(0, 3), 4, 10 * MIN).length, 0, "3 attachments in one message is still 3");
  });
  it("a run that keeps growing returns all of it, including the first items", () => {
    assert.equal(findRuns(items("sam", [0, 1, 2, 3]), 4, 10 * MIN)[0].length, 4);
    assert.equal(findRuns(items("sam", [0, 1, 2, 3, 8, 15]), 4, 10 * MIN)[0].length, 6);
  });
});

const plan = (over: Partial<Plan> = {}): Plan => ({ date: "2026-07-19", start_time: "13:00", end_time: "16:00", plan_status: "confirmed", my_stance: "committed", archived_at: null, ...over }) as Plan;

describe("the photo window (Sydney time)", () => {
  it("default: from the plan's END to END + 24 hours; sweep 30 minutes later", () => {
    const w = photoWindow(plan(), "end")!;
    assert.equal(w.from.toISOString(), "2026-07-19T06:00:00.000Z"); // 4pm AEST
    assert.equal(w.to.toISOString(), "2026-07-20T06:00:00.000Z");
    assert.equal(w.sweepAt.toISOString(), "2026-07-20T06:30:00.000Z");
  });
  it("PHOTO_WINDOW_START=start also catches photos sent during the event", () => {
    const w = photoWindow(plan(), "start")!;
    assert.equal(w.from.toISOString(), "2026-07-19T03:00:00.000Z"); // 1pm
    assert.equal(w.to.toISOString(), "2026-07-20T06:00:00.000Z");
  });
  it("no end time: the plan is assumed to last 2 hours", () => {
    const w = photoWindow(plan({ end_time: null }), "end")!;
    assert.equal(w.end.toISOString(), "2026-07-19T05:00:00.000Z"); // 3pm
    assert.equal(w.to.toISOString(), "2026-07-20T05:00:00.000Z");
  });
  it("an end time past midnight belongs to the next day", () => {
    const w = photoWindow(plan({ start_time: "22:00", end_time: "01:00" }), "end")!;
    assert.equal(w.end.toISOString(), "2026-07-19T15:00:00.000Z"); // 1am on the 20th, Sydney
  });
  it("no date or no start time: no window", () => {
    assert.equal(photoWindow(plan({ date: null }), "end"), null);
    assert.equal(photoWindow(plan({ start_time: null }), "end"), null);
  });
  it("24 hours means the next day at the same time, across a daylight-saving change (23 or 25 real hours)", () => {
    // DST starts Sun 4 Oct 2026 at 2am: Sat 22:00 AEST (12:00Z) -> Sun 22:00 AEDT (11:00Z) = 23 real hours.
    const spring = photoWindow(plan({ date: "2026-10-03", start_time: "19:00", end_time: "22:00" }), "end")!;
    assert.equal(spring.end.toISOString(), "2026-10-03T12:00:00.000Z");
    assert.equal(spring.to.toISOString(), "2026-10-04T11:00:00.000Z");
    // DST ends Sun 5 Apr 2026 at 3am: Sat 22:00 AEDT (11:00Z) -> Sun 22:00 AEST (12:00Z) = 25 real hours.
    const autumn = photoWindow(plan({ date: "2026-04-04", start_time: "19:00", end_time: "22:00" }), "end")!;
    assert.equal(autumn.end.toISOString(), "2026-04-04T11:00:00.000Z");
    assert.equal(autumn.to.toISOString(), "2026-04-05T12:00:00.000Z");
  });
  it("only confirmed plans I committed to are eligible", () => {
    assert.equal(isEligible(plan()), true);
    for (const my_stance of ["declined", "unsure", "none"] as const) assert.equal(isEligible(plan({ my_stance })), false, my_stance);
    for (const plan_status of ["proposed", "cancelled"] as const) assert.equal(isEligible(plan({ plan_status })), false, plan_status);
  });
});

describe("which plan a photo belongs to", () => {
  const w = (id: number, endIso: string, chatIds = ["G"]): WindowedPlan => {
    const end = new Date(endIso);
    return { id, chatIds, window: { start: new Date(end.getTime() - 3 * 60 * MIN), end, from: end, to: new Date(end.getTime() + 24 * 60 * MIN), sweepAt: new Date(end.getTime() + 54 * 60 * MIN) } };
  };
  const at = (iso: string) => ({ chatId: "G", ts: iso });

  it("both ends of the window are inside", () => {
    const p = w(1, "2026-07-19T06:00:00Z");
    p.window.to = new Date("2026-07-20T06:00:00Z");
    assert.equal(planForMedia(at("2026-07-19T05:59:59Z"), [p]).plan, null, "before the end");
    assert.equal(planForMedia(at("2026-07-19T06:00:00Z"), [p]).plan?.id, 1, "exactly at the end");
    assert.equal(planForMedia(at("2026-07-20T06:00:00Z"), [p]).plan?.id, 1, "exactly 24 hours later");
    assert.equal(planForMedia(at("2026-07-20T06:00:01Z"), [p]).plan, null, "just after");
  });
  it("only the plan's own chat (or a linked chat) counts", () => {
    const p = w(1, "2026-07-19T06:00:00Z", ["G", "LINKED"]);
    assert.equal(planForMedia({ chatId: "LINKED", ts: "2026-07-19T07:00:00Z" }, [p]).plan?.id, 1);
    assert.equal(planForMedia({ chatId: "OTHER", ts: "2026-07-19T07:00:00Z" }, [p]).plan, null);
  });
  it("two overlapping plans: the one that ended most recently gets it, and it is flagged as ambiguous", () => {
    const early = w(1, "2026-07-19T04:00:00Z");
    const late = w(2, "2026-07-19T06:00:00Z");
    const r = planForMedia(at("2026-07-19T07:00:00Z"), [early, late]);
    assert.equal(r.plan?.id, 2);
    assert.equal(r.ambiguous, true);
    assert.equal(planForMedia(at("2026-07-19T05:00:00Z"), [early, late]).plan?.id, 1, "plan 2 has not ended yet and is not open yet");
  });
});

// ---------------------------------------------------------------- names

describe("folder and file names", () => {
  it('the date is "DD Month YYYY" with two digits', () => {
    assert.equal(formatEventDate("2026-07-09"), "09 July 2026");
    assert.equal(formatEventDate("2026-07-19"), "19 July 2026");
    assert.equal(formatEventDate("2026-12-01"), "01 December 2026");
    assert.equal(formatEventDate("2026-02-30"), null);
    assert.equal(formatEventDate("nonsense"), null);
    assert.equal(eventFolderName("Ice skating", "2026-07-19"), "Ice skating 19 July 2026");
    assert.equal(eventFolderName("Ice skating", "2026-07-09"), "Ice skating 09 July 2026");
  });
  it("forbidden characters are replaced, trailing dots and spaces trimmed", () => {
    assert.equal(sanitizeName('a"b*c:d<e>f?g/h\\i|j'), "a-b-c-d-e-f-g-h-i-j");
    assert.equal(sanitizeName("  Badminton Crew.. . "), "Badminton Crew");
    assert.equal(sanitizeName("Line\nbreak\u0000here"), "Line break here");
    assert.equal(sanitizeName("../../etc"), "-..-etc", "slashes can never make a path");
    assert.ok(!sanitizeName("../..").includes("/"));
  });
  it("empty, reserved and hidden-style names get a safe fallback", () => {
    assert.equal(sanitizeName("   "), "Untitled");
    assert.equal(sanitizeName("..."), "Untitled");
    assert.equal(sanitizeName("CON"), "_CON");
    assert.equal(sanitizeName("nul"), "_nul");
    assert.equal(sanitizeName("~$secret"), "secret");
    assert.equal(chatFolderName(""), "Chat");
  });
  it("length is capped without cutting an emoji in half, and the date always survives", () => {
    const long = "x".repeat(300);
    assert.ok(sanitizeName(long).length <= 80);
    const emoji = sanitizeName("🎉".repeat(100));
    assert.ok(!/[\ud800-\udbff]$/.test(emoji) && Array.from(emoji).length <= 80);
    const folder = eventFolderName(long, "2026-07-19");
    assert.ok(folder.endsWith(" 19 July 2026") && folder.length <= 80);
  });
  it("file names come from the message's Sydney time and a counter, never the sender's name", () => {
    assert.equal(mediaFileName(new Date("2026-07-19T04:30:05Z"), 2, "jpg"), "2026-07-19_143005_2.jpg");
    assert.equal(mediaFileName(new Date("2026-07-19T04:30:05Z"), 1, "../x"), "2026-07-19_143005_1.x");
  });
  it("chat rename does not create a second folder, and a plan title change does not rename an existing folder", () => {
    const db = newDb();
    const now = new Date("2026-07-19T10:00:00Z");
    const a = { id: 1, title: "Ice skating", date: "2026-07-19", source_chat_id: "G", source_chat_name: "Badminton Crew" };
    assert.equal(photoPlanFor(db, a, now).chat_folder, "Badminton Crew");
    const b = { id: 2, title: "Bowling", date: "2026-08-02", source_chat_id: "G", source_chat_name: "Renamed Group!" };
    assert.equal(photoPlanFor(db, b, now).chat_folder, "Badminton Crew", "same chat id, first name kept");
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_chat_folders`), 1);
    assert.equal(photoPlanFor(db, { ...a, title: "Ice skating (cancelled?)" }, now).event_folder, "Ice skating 19 July 2026", "title change later: same folder");
  });
});

// ---------------------------------------------------------------- what a file really is

describe("only photos and videos are accepted", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "photos-media-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, bytes: Buffer) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  };
  const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(20)]);

  it("recognises jpeg, png, heic, mp4 and mov by their bytes, not their name", () => {
    assert.equal(sniff(JPEG)?.ext, "jpg");
    assert.equal(sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]))?.ext, "png");
    assert.equal(sniff(ftyp("heic"))?.category, "image");
    assert.equal(sniff(ftyp("isom"))?.ext, "mp4");
    assert.equal(sniff(ftyp("qt  "))?.ext, "mov");
  });
  it("a text file, a script, a PDF, a GIF and an executable are rejected, whatever they claim to be", () => {
    for (const [name, bytes] of [["a.jpg", Buffer.from("#!/bin/sh\nrm -rf ~\n")], ["b.jpg", Buffer.from("%PDF-1.7 ....")], ["c.png", Buffer.from("GIF89a....")], ["d.mp4", Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])]] as const) {
      assert.equal(checkFile(write(name, bytes), "image/jpeg").ok, false, name);
    }
  });
  it("a declared type that is not image/* or video/* is rejected, and a declared type that disagrees with the bytes too", () => {
    assert.deepEqual(checkFile(write("e.jpg", JPEG), "application/pdf").ok, false);
    assert.equal(checkFile(write("f.jpg", JPEG), "video/mp4").ok, false);
    assert.equal(checkFile(write("g.jpg", JPEG), "image/jpeg").ok, true);
    assert.equal(checkFile(write("h.jpg", JPEG), null).ok, true, "no declared type: the bytes decide");
  });
});

// ---------------------------------------------------------------- the pipeline (fake Beeper, fake OneDrive)

class FakeMedia implements MediaReader {
  items: MediaRef[] = [];
  files = new Map<string, string>();
  downloads: string[] = [];
  reads: number[] = [];
  /** Messages that only a deep (sweep) read can see. */
  deepOnly = new Set<string>();
  async recentMedia(chatId: string, sinceIso: string, maxPages: number) {
    this.reads.push(maxPages);
    return this.items.filter((i) => i.chatId === chatId && i.ts > sinceIso && !(maxPages < SWEEP_PAGES && this.deepOnly.has(i.messageId)));
  }
  async downloadMedia(url: string) {
    this.downloads.push(url);
    const f = this.files.get(url);
    if (!f) throw new Error("no such file");
    return f;
  }
}
class FakeGraph implements GraphClient {
  folders = new Map<string, string>();
  created: string[] = [];
  items = new Map<string, string>();
  uploads: { parent: string; name: string; size: number }[] = [];
  failNext = 0;
  remaining = 100 * GB;
  async quota() {
    return { remaining: this.remaining, total: 105 * GB, used: 5 * GB };
  }
  async ensureFolder(parent: string, name: string) {
    const key = `${parent}/${name}`;
    if (!this.folders.has(key)) {
      this.folders.set(key, `folder${this.folders.size + 1}`);
      this.created.push(name);
    }
    return { id: this.folders.get(key)!, name };
  }
  async uploadFile(parent: string, name: string, filePath: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("503 service unavailable");
    }
    assert.ok(fs.existsSync(filePath), "the temp file exists while uploading");
    const key = `${parent}/${name}`;
    if (this.items.has(key)) return this.items.get(key)!; // like Graph's 409 for the same file
    const id = `item${this.items.size + 1}`;
    this.items.set(key, id);
    this.uploads.push({ parent, name, size: fs.statSync(filePath).size });
    return id;
  }
}

// Plan: Ice skating, Sun 19 Jul 2026 1pm-4pm Sydney in chat G ("Badminton Crew"). Window: 06:00Z Jul 19 -> 06:00Z Jul 20.
const END = Date.parse("2026-07-19T06:00:00Z");
const AFTER_EVENT = new Date(END + 90 * MIN);
const AFTER_SWEEP = new Date(END + 24 * 60 * MIN + 31 * MIN);

describe("the photos job", () => {
  let db: Database.Database;
  let dir: string;
  let media: FakeMedia;
  let graph: FakeGraph;
  let sent: { text: string; options?: unknown }[];
  let planId: number;

  beforeEach(() => {
    db = newDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "photos-job-"));
    media = new FakeMedia();
    graph = new FakeGraph();
    sent = [];
    planId = seedPlan();
    setState(db, "uni_events_id", "ROOT");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function seedPlan(o: { stance?: "committed" | "declined" | "unsure"; status?: "confirmed" | "proposed" | "cancelled"; chat?: string; name?: string; title?: string; date?: string; start?: string; end?: string } = {}): number {
    const id = insertPlan(db, {
      title: o.title ?? "Ice skating", plan_status: o.status ?? "confirmed", source_chat_id: o.chat ?? "G", source_chat_name: o.name ?? "Badminton Crew",
      raised_at: "2026-07-10T00:00:00Z", date: o.date ?? "2026-07-19", start_time: o.start ?? "13:00", end_time: o.end ?? "16:00", confidence: 0.9, date_certainty: "exact",
    }, new Date("2026-07-10T00:00:00Z"));
    addStance(db, id, { stance: o.stance ?? "committed", message_id: `s${id}`, chat_id: "G", ts: "2026-07-10T01:00:00Z" }, new Date("2026-07-10T01:00:00Z"));
    return id;
  }
  /** A photo from `sender`, `min` minutes after the plan ended. */
  function photo(n: string, min: number, o: Partial<MediaRef> & { content?: Buffer } = {}): MediaRef {
    const ref: MediaRef = {
      chatId: "G", messageId: `msg-${n}`, attachmentId: `mxc://beeper/${n}`, index: 0, senderId: o.senderId ?? "sam", ts: new Date(END + min * MIN).toISOString(),
      kind: o.kind ?? "IMAGE", mime: o.mime === undefined ? "image/jpeg" : o.mime, size: o.size === undefined ? 500 : o.size,
    };
    const file = path.join(dir, `cache-${n}`);
    fs.writeFileSync(file, o.content ?? JPEG);
    media.files.set(ref.attachmentId, file);
    media.items.push(ref);
    return ref;
  }
  const run4 = (prefix = "p") => [1, 2, 3, 4].forEach((i) => photo(`${prefix}${i}`, 10 + i));

  function deps(now: Date, over: Partial<PhotoDeps> = {}): PhotoDeps {
    return {
      db, reader: media, graph, notify: (text, options) => void sent.push({ text, options }), dryRun: false, windowStart: "end", minRun: 4, gapMs: 10 * MIN,
      tmpDir: path.join(dir, "tmp"), now, log: () => {}, freeDisk: () => 500 * GB, ...over,
    };
  }
  const saved = () => db.prepare(`SELECT status, COUNT(*) AS n FROM media_saved GROUP BY status`).all() as { status: string; n: number }[];
  const tmpLeft = () => (fs.existsSync(path.join(dir, "tmp")) ? fs.readdirSync(path.join(dir, "tmp")) : []);

  it("only confirmed plans I committed to are watched", async () => {
    db.exec(`DELETE FROM plans`);
    seedPlan({ stance: "declined" });
    seedPlan({ stance: "unsure" });
    seedPlan({ status: "proposed" });
    seedPlan({ status: "cancelled" });
    run4();
    const r = await runPhotos(deps(AFTER_EVENT));
    assert.equal(r.plans, 0);
    assert.equal(media.reads.length, 0, "no chat was even read");
  });

  it("DRY RUN: logs what it would save, downloads and uploads nothing, sends no Telegram message", async () => {
    run4();
    photo("odd", 200); // a lone photo much later: not a run
    const r = await runPhotos(deps(AFTER_EVENT, { dryRun: true, graph: null }));
    assert.equal(r.wouldSave, 4);
    const log = db.prepare(`SELECT detail, dry_run FROM photo_log`).all() as { detail: string; dry_run: number }[];
    assert.deepEqual(log, [{ detail: "would save 4 items to Uni Events / Badminton Crew / Ice skating 19 July 2026", dry_run: 1 }]);
    assert.equal(media.downloads.length, 0);
    assert.equal(graph.uploads.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM media_saved`), 0);
    await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 5 * MIN), { dryRun: true, graph: null }));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_log`), 1, "the same line is not logged twice");
  });

  it("3 photos is not a run: nothing is logged or saved", async () => {
    [1, 2, 3].forEach((i) => photo(`t${i}`, 10 + i));
    await runPhotos(deps(AFTER_EVENT, { dryRun: true, graph: null }));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_log`), 0);
  });

  it("nothing before the window opens, and with the default (the plan's END) photos sent DURING the event are not counted", async () => {
    run4();
    await runPhotos(deps(new Date(END - 30 * MIN), { dryRun: true, graph: null }));
    assert.equal(media.reads.length, 0, "the window has not opened: no chat is read");
    media.items = [];
    [1, 2, 3, 4].forEach((i) => photo(`d${i}`, -60 + i)); // sent DURING the event
    await runPhotos(deps(AFTER_EVENT, { dryRun: true, graph: null }));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_log`), 0);
  });

  it("PHOTO_WINDOW_START=start also catches photos sent during the event", async () => {
    [1, 2, 3, 4].forEach((i) => photo(`d${i}`, -60 + i));
    await runPhotos(deps(AFTER_EVENT, { dryRun: true, graph: null, windowStart: "start" }));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_log`), 1);
  });

  it("LIVE: makes the folders once, saves the whole run, tells you once at the start and once at the end", async () => {
    run4();
    let r = await runPhotos(deps(AFTER_EVENT));
    assert.equal(r.saved, 4);
    assert.deepEqual(graph.created, ["Badminton Crew", "Ice skating 19 July 2026"]);
    assert.deepEqual(graph.uploads.map((u) => u.name), ["2026-07-19_161100_1.jpg", "2026-07-19_161200_1.jpg", "2026-07-19_161300_1.jpg", "2026-07-19_161400_1.jpg"]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^📷 Saving photos from Badminton Crew to Uni Events \/ Badminton Crew \/ Ice skating 19 July 2026$/);
    assert.deepEqual(tmpLeft(), [], "no temp files left behind");

    r = await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 5 * MIN)));
    assert.equal(sent.length, 1, "the folder message is not sent again");

    await runPhotos(deps(AFTER_SWEEP));
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /^📷 Saved 4 photos to Uni Events \/ Badminton Crew \/ Ice skating 19 July 2026$/);
    await runPhotos(deps(new Date(AFTER_SWEEP.getTime() + 10 * MIN)));
    assert.equal(sent.length, 2, "one summary only");
    assert.equal(countsForPlan(db, planId).photos, 4);
    assert.equal(getPhotoPlan(db, planId)?.folder_item_id, "folder2", "the folder id is kept on the plan");
  });

  it("the Telegram messages hold extracted fields only (folder names and counts), nothing from the chat text", async () => {
    run4();
    await runPhotos(deps(AFTER_EVENT));
    await runPhotos(deps(AFTER_SWEEP));
    for (const s of sent) assert.match(s.text, /^📷 (Saving photos from|Saved \d+)/);
  });

  it("no duplicate uploads after a restart, even if the database missed the success", async () => {
    run4();
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(graph.uploads.length, 4);
    await runPhotos(deps(AFTER_EVENT, { reader: media })); // "restart": fresh deps, same database
    assert.equal(graph.uploads.length, 4);
    assert.equal(media.downloads.length, 4, "nothing downloaded twice");
    // A crash after OneDrive took the file but before the row was updated:
    db.prepare(`UPDATE media_saved SET status = 'pending', saved_at = NULL, onedrive_item_id = NULL WHERE message_id = 'msg-p1'`).run();
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(graph.uploads.length, 4, "OneDrive already had it (same name and size): treated as saved");
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM media_saved`), 4);
    assert.equal(countsForPlan(db, planId).photos, 4);
  });

  it("a failed upload stays pending and is retried with a growing wait", async () => {
    run4();
    graph.failNext = 1;
    await runPhotos(deps(AFTER_EVENT));
    const row = db.prepare(`SELECT status, attempts, next_attempt_at, error FROM media_saved WHERE status = 'pending'`).get() as { status: string; attempts: number; next_attempt_at: string; error: string };
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, new Date(AFTER_EVENT.getTime() + 5 * MIN).toISOString());
    assert.match(row.error, /503/);
    assert.equal(countsForPlan(db, planId).photos, 3);
    await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 1 * MIN)));
    assert.equal(countsForPlan(db, planId).photos, 3, "not yet: it is still waiting");
    await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 6 * MIN)));
    assert.equal(countsForPlan(db, planId).photos, 4, "retried and saved");
    assert.deepEqual(tmpLeft(), []);
  });

  it("gives up after repeated failures, and says so", async () => {
    run4();
    graph.failNext = 1000;
    let t = AFTER_EVENT.getTime();
    for (let i = 0; i < 12; i++) {
      await runPhotos(deps(new Date(t)));
      t += 13 * 60 * MIN;
    }
    assert.equal(countsForPlan(db, planId).failed, 4);
    assert.ok(sent.some((s) => /gave up on a file/.test(s.text)));
  });

  it("a file over 1 GB is skipped, never downloaded, and you are told", async () => {
    [1, 2, 3].forEach((i) => photo(`b${i}`, 10 + i));
    photo("big", 14, { kind: "VIDEO", mime: "video/mp4", size: 2 * GB });
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(countsForPlan(db, planId).photos, 3);
    assert.equal(countsForPlan(db, planId).skipped, 1);
    assert.ok(!media.downloads.includes("mxc://beeper/big"));
    assert.ok(sent.some((s) => /skipped a file over 1 GB/.test(s.text)));
  });

  it("a file that turns out bigger than 1 GB after download is skipped before it is copied or uploaded", async () => {
    [1, 2, 3].forEach((i) => photo(`c${i}`, 10 + i));
    photo("liar", 14, { size: 100 }); // claims 100 bytes
    const file = media.files.get("mxc://beeper/liar")!;
    fs.truncateSync(file, 1024 ** 3 + 1); // sparse 1 GB + 1 byte file
    fs.writeSync(fs.openSync(file, "r+"), JPEG, 0, JPEG.length, 0);
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(countsForPlan(db, planId).skipped, 1);
    assert.equal(graph.uploads.length, 3);
    assert.deepEqual(tmpLeft(), []);
  });

  it("a file that is not a photo or video is rejected and never uploaded", async () => {
    [1, 2, 3].forEach((i) => photo(`r${i}`, 10 + i));
    photo("evil", 14, { content: Buffer.from("#!/bin/sh\necho hi\n"), mime: "image/jpeg" });
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(countsForPlan(db, planId).rejected, 1);
    assert.equal(graph.uploads.length, 3);
    assert.deepEqual(tmpLeft(), []);
  });

  it("stops for the day above 5 GB and says so; the rest waits", async () => {
    run4();
    setState(db, `bytes:${dayKey(AFTER_EVENT)}`, String(5 * GB));
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(graph.uploads.length, 0);
    assert.equal(countsForPlan(db, planId).pending, 4);
    assert.ok(sent.some((s) => /5 GB uploaded today/.test(s.text)));
    await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 24 * 60 * MIN)));
    assert.equal(graph.uploads.length, 4, "the next day it carries on");
  });

  it("checks free disk space first and stops if it is low", async () => {
    run4();
    await runPhotos(deps(AFTER_EVENT, { freeDisk: () => 100 * 1024 ** 2 }));
    assert.equal(graph.uploads.length, 0);
    assert.equal(media.downloads.length, 0);
    assert.ok(sent.some((s) => /disk space/.test(s.text)));
  });

  it("alerts when OneDrive is nearly full", async () => {
    run4();
    graph.remaining = 500 * 1024 ** 2;
    await runPhotos(deps(AFTER_EVENT));
    assert.ok(sent.some((s) => /OneDrive has only/.test(s.text)));
  });

  it("the final sweep (window end + 30 minutes) finds runs the normal reads missed, and is not repeated", async () => {
    [1, 2, 3].forEach((i) => photo(`s${i}`, 10 + i));
    photo("s4", 14);
    media.deepOnly.add("msg-s4"); // normal reads cannot see it; only a deep read can
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(countsForPlan(db, planId).photos, 0, "3 visible: not a run yet");
    await runPhotos(deps(AFTER_SWEEP));
    assert.equal(countsForPlan(db, planId).photos, 4, "the sweep saved the whole run");
    const readsBefore = media.reads.length;
    await runPhotos(deps(new Date(AFTER_SWEEP.getTime() + 10 * MIN)));
    assert.equal(media.reads.length, readsBefore, "a finished sweep is not read again");
  });

  it("a run that keeps growing keeps being saved, and nothing is saved twice", async () => {
    run4();
    await runPhotos(deps(new Date(END + 16 * MIN)));
    assert.equal(countsForPlan(db, planId).photos, 4);
    photo("g5", 17);
    photo("g6", 24);
    await runPhotos(deps(new Date(END + 30 * MIN)));
    assert.equal(countsForPlan(db, planId).photos, 6);
    assert.equal(graph.uploads.length, 6);
  });

  it("an album (several attachments in one message) is saved with distinct names", async () => {
    const files = [0, 1, 2, 3].map((index) => {
      const ref = photo(`alb${index}`, 10);
      ref.messageId = "album-message";
      ref.index = index;
      return ref;
    });
    assert.equal(files.length, 4);
    await runPhotos(deps(AFTER_EVENT));
    assert.equal(countsForPlan(db, planId).photos, 4);
    assert.equal(new Set(graph.uploads.map((u) => u.name)).size, 4, "same second, four different file names");
  });

  it("videos are counted and saved too, with the right extension and a mixed summary", async () => {
    [1, 2, 3].forEach((i) => photo(`v${i}`, 10 + i));
    photo("vid", 14, { kind: "VIDEO", mime: "video/mp4", content: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(40)]) });
    await runPhotos(deps(AFTER_EVENT));
    await runPhotos(deps(AFTER_SWEEP));
    assert.ok(graph.uploads.some((u) => u.name.endsWith(".mp4")));
    assert.match(sent[sent.length - 1].text, /Saved 3 photos and 1 video to/);
  });

  it("two overlapping plans in one chat: photos go to the one that ended most recently, and it is logged", async () => {
    const earlier = seedPlan({ title: "Lunch", start: "11:00", end: "13:30" }); // ended 3.5h before plan 1
    run4();
    await runPhotos(deps(AFTER_EVENT, { dryRun: true, graph: null }));
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM photo_plans WHERE plan_id = ?`, earlier), 0, "the earlier plan got none");
    assert.equal(getPhotoPlan(db, planId)?.event_folder, "Ice skating 19 July 2026");
    assert.ok(count(db, `SELECT COUNT(*) AS n FROM photo_log WHERE kind = 'overlap'`) >= 1);
  });

  it("while OneDrive is not ready nothing is lost: files wait, and the reason is visible", async () => {
    run4();
    const logs: string[] = [];
    await runPhotos(deps(AFTER_EVENT, { graph: null, graphProblem: "OneDrive sign-in expired", log: (m) => logs.push(m) }));
    assert.equal(countsForPlan(db, planId).pending, 4);
    assert.ok(logs.some((l) => /sign-in expired/.test(l)));
    await runPhotos(deps(new Date(AFTER_EVENT.getTime() + 5 * MIN)));
    assert.equal(countsForPlan(db, planId).photos, 4, "saved once it is back");
  });
});

// ---------------------------------------------------------------- Beeper media reading (a fake Beeper Server)

describe("reading media from Beeper", () => {
  let server: http.Server;
  let dir: string;
  let root: string;
  let other: string;
  const calls: { method: string; url: string }[] = [];
  let reader: ReturnType<typeof createBeeperReader>;

  const chat = (id: string, accountID: string) => ({ id, accountID, network: "x", title: id, type: "group", participants: { items: [], hasMore: false, total: 0 } });
  const att = (over: Record<string, unknown>) => ({ id: "mxc://b/1", type: "img", mimeType: "image/jpeg", ...over });
  const message = (id: string, type: string, attachments?: unknown[]) => ({ id, chatID: "ig1", accountID: "instagramgo.1", senderID: "sam", timestamp: "2026-07-19T07:00:00.000Z", sortKey: id, type, attachments });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "photos-beeper-"));
    root = path.join(dir, "beeper");
    other = path.join(dir, "elsewhere");
    fs.mkdirSync(root);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(root, "good.jpg"), JPEG);
    fs.writeFileSync(path.join(other, "secret.txt"), "secret");
    fs.symlinkSync(path.join(other, "secret.txt"), path.join(root, "link.jpg"));
    calls.length = 0;
    server = http.createServer((req, res) => {
      calls.push({ method: req.method ?? "", url: req.url ?? "" });
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";
      if (url.startsWith("/v1/accounts")) return void res.end("[]");
      if (url.startsWith("/v1/assets/download")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const wanted = JSON.parse(body).url as string;
          const file = wanted.endsWith("good") ? path.join(root, "good.jpg") : wanted.endsWith("link") ? path.join(root, "link.jpg") : path.join(other, "secret.txt");
          res.end(JSON.stringify({ srcURL: `file://${file}` }));
        });
        return;
      }
      if (/^\/v1\/chats\/[^/]+\/messages/.test(url)) {
        return void res.end(JSON.stringify({ hasMore: false, items: [
          message("m1", "IMAGE", [att({ id: "mxc://b/photo" })]),
          message("m2", "VIDEO", [att({ id: "mxc://b/video", type: "video", mimeType: "video/mp4" })]),
          message("m3", "IMAGE", [att({ id: "mxc://b/gif", isGif: true })]),
          message("m4", "STICKER", [att({ id: "mxc://b/sticker", isSticker: true })]),
          message("m5", "VOICE", [att({ id: "mxc://b/voice", type: "audio", mimeType: "audio/ogg", isVoiceNote: true })]),
          message("m6", "IMAGE", [att({ id: undefined })]),
          message("m7", "TEXT", [att({ id: "mxc://b/text-with-attachment" })]),
          message("m8", "IMAGE", [att({ id: "mxc://b/a1" }), att({ id: "mxc://b/a2" })]),
        ] }));
      }
      res.end(JSON.stringify({ items: [chat("ig1", "instagramgo.1"), chat("wa1", "whatsapp.1")], hasMore: false }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    reader = createBeeperReader({ accessToken: "test-token-123", baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, mediaRoot: root });
    await reader.listChats();
  });
  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns only real photos and videos: not GIFs, stickers, voice notes, text, or attachments without an id; albums count each attachment", async () => {
    const found = await reader.recentMedia("ig1", "2026-07-01T00:00:00Z", 1);
    assert.deepEqual(found.map((f) => f.attachmentId), ["mxc://b/photo", "mxc://b/video", "mxc://b/a1", "mxc://b/a2"]);
    assert.deepEqual(found.map((f) => f.kind), ["IMAGE", "VIDEO", "IMAGE", "IMAGE"]);
    assert.deepEqual(found.filter((f) => f.messageId === "m8").map((f) => f.index), [0, 1]);
    assert.ok(found.every((f) => !("text" in f)), "no message text is carried");
  });
  it("never reads a chat on another network", async () => {
    await assert.rejects(reader.recentMedia("wa1", "2026-07-01T00:00:00Z", 1), /not on an allowed network/);
    assert.ok(!calls.some((c) => c.url.includes("/wa1/messages")));
  });
  it("only ever GETs, apart from asking for a file download (a local cache fill, not a message)", async () => {
    await reader.recentMedia("ig1", "2026-07-01T00:00:00Z", 1);
    await reader.downloadMedia("mxc://b/good");
    const posts = calls.filter((c) => c.method !== "GET");
    assert.ok(posts.length > 0 && posts.every((c) => c.method === "POST" && c.url.startsWith("/v1/assets/download")));
  });
  it("only accepts a downloaded file that is a plain file inside Beeper's data folder", async () => {
    assert.equal(await reader.downloadMedia("mxc://b/good"), fs.realpathSync(path.join(root, "good.jpg")));
    await assert.rejects(reader.downloadMedia("mxc://b/elsewhere"), /outside Beeper's data folder/);
    await assert.rejects(reader.downloadMedia("mxc://b/link"), /outside Beeper's data folder/, "a link pointing out of the folder is refused");
    await assert.rejects(reader.downloadMedia("https://evil.example/x.jpg"), /not a Beeper media url/);
    await assert.rejects(reader.downloadMedia("file:///etc/passwd"), /not a Beeper media url/);
  });
});

// ---------------------------------------------------------------- Microsoft sign-in (fake Microsoft)

describe("OneDrive sign-in", () => {
  let db: Database.Database;
  let clock: Date;
  let calls: { url: string; body: URLSearchParams }[];
  let queue: { status: number; json: Record<string, unknown> }[];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init.body)) });
    const next = queue.shift()!;
    return new Response(JSON.stringify(next.json), { status: next.status });
  }) as unknown as typeof fetch;
  const make = () => new OneDriveAuth(db, "client-id-123456", fetchFn, "https://login.example/oauth2/v2.0", () => clock);
  const tokens = (access = "ACCESS-1", refresh = "REFRESH-1") => ({ status: 200, json: { access_token: access, refresh_token: refresh, expires_in: 3600, scope: "Files.ReadWrite offline_access" } });

  beforeEach(() => {
    db = newDb();
    clock = new Date("2026-07-19T00:00:00Z");
    calls = [];
    queue = [];
  });

  it("device code flow: waits while pending, slows down when told, then keeps the tokens", async () => {
    queue.push({ status: 200, json: { device_code: "DEV", user_code: "ABCD1234", verification_uri: "https://microsoft.com/link", expires_in: 900, interval: 5 } });
    const auth = make();
    const dc = await auth.startDeviceCode();
    assert.equal(dc.user_code, "ABCD1234");
    assert.equal(calls[0].body.get("scope"), "Files.ReadWrite offline_access");
    assert.equal(calls[0].body.get("client_id"), "client-id-123456");
    assert.ok(!calls[0].body.has("client_secret"), "a public client: no secret");
    queue.push({ status: 400, json: { error: "authorization_pending" } }, { status: 400, json: { error: "slow_down" } }, tokens());
    const waits: number[] = [];
    await auth.finishDeviceCode(dc, async (ms) => void waits.push(ms));
    assert.deepEqual(waits, [5000, 5000, 10000]);
    assert.equal(auth.status().connected, true);
    assert.equal(await auth.getAccessToken(), "ACCESS-1");
    assert.equal(calls.length, 4, "no extra request while the token is fresh");
  });
  it("refreshes when the access token is about to expire, and keeps the newest refresh token", async () => {
    queue.push(tokens());
    const auth = make();
    await auth.finishDeviceCode({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 900, interval: 1 }, async () => {});
    clock = new Date(clock.getTime() + 3600_000);
    queue.push(tokens("ACCESS-2", "REFRESH-2"));
    assert.equal(await auth.getAccessToken(), "ACCESS-2");
    assert.equal(calls[calls.length - 1].body.get("refresh_token"), "REFRESH-1");
    clock = new Date(clock.getTime() + 3600_000);
    queue.push(tokens("ACCESS-3", "REFRESH-3"));
    await auth.getAccessToken();
    assert.equal(calls[calls.length - 1].body.get("refresh_token"), "REFRESH-2", "the rotated token is used next time");
  });
  it("a revoked or expired login is reported as needing sign-in, not retried forever, and no token is in the message", async () => {
    queue.push(tokens());
    const auth = make();
    await auth.finishDeviceCode({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 900, interval: 1 }, async () => {});
    queue.push({ status: 400, json: { error: "invalid_grant", error_description: "refresh token REFRESH-1 is dead" } });
    await assert.rejects(auth.getAccessToken(true), (e: Error) => e instanceof OneDriveAuthError && e.code === "needs_login" && !/REFRESH|ACCESS/.test(e.message));
    const st = auth.status();
    assert.equal(st.needsLogin, true);
    assert.equal(st.connected, false);
    assert.ok(!/REFRESH|ACCESS/.test(st.lastError ?? ""));
    const before = calls.length;
    await assert.rejects(auth.getAccessToken(), /expired or was revoked/);
    assert.equal(calls.length, before, "it does not hammer Microsoft");
  });
  it("a temporary failure is not 'needs sign-in'", async () => {
    queue.push(tokens());
    const auth = make();
    await auth.finishDeviceCode({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 900, interval: 1 }, async () => {});
    queue.push({ status: 503, json: { error: "temporarily_unavailable" } });
    await assert.rejects(auth.getAccessToken(true), /temporarily_unavailable/);
    assert.equal(auth.status().needsLogin, false);
    assert.equal(auth.status().connected, true);
  });
  it("shows how long the sign-in has left if it went unused (90 days from the last refresh)", async () => {
    queue.push(tokens());
    const auth = make();
    await auth.finishDeviceCode({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 900, interval: 1 }, async () => {});
    assert.equal(auth.status().daysLeft, 90);
    clock = new Date(clock.getTime() + 80 * 86_400_000);
    assert.equal(auth.status().daysLeft, 10);
  });
  it("refuses a sign-in that did not grant Files.ReadWrite", async () => {
    queue.push({ status: 200, json: { access_token: "A", refresh_token: "R", expires_in: 3600, scope: "User.Read" } });
    await assert.rejects(make().finishDeviceCode({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 900, interval: 1 }, async () => {}), /Files\.ReadWrite/);
  });
  it("is not usable without an app id", async () => {
    const auth = new OneDriveAuth(db, "", fetchFn);
    assert.equal(auth.isConfigured(), false);
    await assert.rejects(auth.startDeviceCode(), /MS_CLIENT_ID/);
  });
});

// ---------------------------------------------------------------- Microsoft Graph client (a fake OneDrive)

describe("the Graph client only writes under Uni Events", () => {
  let dir: string;
  let calls: { method: string; url: string; auth: string | null }[];
  let folders: Map<string, { id: string; parent: string; name: string }>;
  let files: Map<string, { id: string; size: number }>;
  let sessions: Map<string, { key: string; received: number; size: number }>;
  let idCounter: number;
  let failPuts: number;

  const resp = (status: number, json: unknown = {}) => new Response(JSON.stringify(json), { status });
  const fakeFetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, auth: headers.Authorization ?? null });
    const u = new URL(url);
    if (u.host === "upload.example") {
      const s = sessions.get(u.pathname)!;
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers["Content-Range"])!;
      assert.equal(+m[1], s.received, "chunks arrive in order");
      assert.equal((+m[1]) % (320 * 1024), 0, "chunk starts on a 320 KiB boundary");
      s.received = +m[2] + 1;
      if (s.received >= s.size) {
        files.set(s.key, { id: `big${++idCounter}`, size: s.size });
        return resp(201, { id: files.get(s.key)!.id });
      }
      return resp(202, { nextExpectedRanges: [`${s.received}-`] });
    }
    const path = decodeURIComponent(u.pathname.replace("/v1.0", ""));
    if (path === "/me/drive") return resp(200, { quota: { remaining: 50 * GB, total: 100 * GB, used: 50 * GB } });
    let m = /^\/me\/drive\/items\/([^/:]+)\/children$/.exec(path);
    if (m && method === "POST") {
      const body = JSON.parse(String(init.body));
      const key = `${m[1]}/${body.name}`;
      if (folders.has(key)) return resp(409, { error: { code: "nameAlreadyExists" } });
      folders.set(key, { id: `folder${++idCounter}`, parent: m[1], name: body.name });
      return resp(201, { id: folders.get(key)!.id, name: body.name });
    }
    m = /^\/me\/drive\/items\/([^/:]+):\/([^:]+)(:\/(content|createUploadSession))?$/.exec(path);
    if (m) {
      const key = `${m[1]}/${m[2]}`;
      if (!m[3] && method === "GET") {
        if (folders.has(key)) return resp(200, { id: folders.get(key)!.id, name: m[2], folder: {} });
        if (files.has(key)) return resp(200, { id: files.get(key)!.id, name: m[2], size: files.get(key)!.size });
        return resp(404, { error: { code: "itemNotFound" } });
      }
      if (m[4] === "content" && method === "PUT") {
        if (failPuts > 0) {
          failPuts--;
          return resp(503, { error: { code: "serviceNotAvailable" } });
        }
        if (files.has(key)) return resp(409, { error: { code: "nameAlreadyExists" } });
        files.set(key, { id: `file${++idCounter}`, size: (init.body as Buffer).length });
        return resp(201, { id: files.get(key)!.id });
      }
      if (m[4] === "createUploadSession" && method === "POST") {
        if (files.has(key)) return resp(409, { error: { code: "nameAlreadyExists" } });
        const sessionPath = `/session${++idCounter}`;
        sessions.set(sessionPath, { key, received: 0, size: Number(headers["x-size"] ?? fs.statSync(bigFile).size) });
        return resp(200, { uploadUrl: `https://upload.example${sessionPath}` });
      }
    }
    return resp(404, { error: { code: "unknown" } });
  }) as unknown as typeof fetch;

  let bigFile: string;
  const client = () => createGraphClient({ getToken: async () => "TOKEN", rootId: "ROOT", fetchFn: fakeFetch, baseUrl: "https://graph.example/v1.0", sleep: async () => {} });
  const small = () => {
    const p = path.join(dir, `small-${Math.random()}.jpg`);
    fs.writeFileSync(p, JPEG);
    return p;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "photos-graph-"));
    calls = [];
    folders = new Map();
    files = new Map();
    sessions = new Map();
    idCounter = 0;
    failPuts = 0;
    bigFile = path.join(dir, "big.mp4");
    const fd = fs.openSync(bigFile, "w");
    fs.writeSync(fd, Buffer.alloc(1024 * 1024, 7), 0, 1024 * 1024, 21 * 1024 * 1024 - 1024 * 1024); // 21 MiB, sparse start
    fs.closeSync(fd);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates a folder only if it is missing, and reuses it otherwise", async () => {
    const g = client();
    const a = await g.ensureFolder("ROOT", "Badminton Crew");
    const b = await g.ensureFolder("ROOT", "Badminton Crew");
    assert.equal(a.id, b.id);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });
  it("small files go up in one PUT; the same file again is treated as already saved; a different file with the same name is an error", async () => {
    const g = client();
    const f = await g.ensureFolder("ROOT", "Chat");
    const p = small();
    const id = await g.uploadFile(f.id, "2026-07-19_160000_1.jpg", p);
    assert.equal(await g.uploadFile(f.id, "2026-07-19_160000_1.jpg", p), id, "409 + same size = already there");
    fs.writeFileSync(p, Buffer.concat([JPEG, Buffer.from([1])]));
    await assert.rejects(g.uploadFile(f.id, "2026-07-19_160000_1.jpg", p), /different file already has this name/);
    assert.ok(calls.every((c) => c.auth === "Bearer TOKEN" || c.url.startsWith("https://upload.example")));
  });
  it("big files (over 4 MB) use an upload session in 320 KiB-aligned chunks, and the session URL does not get our token", async () => {
    const g = client();
    const f = await g.ensureFolder("ROOT", "Chat");
    const id = await g.uploadFile(f.id, "clip.mp4", bigFile);
    assert.match(id, /^big/);
    const chunks = calls.filter((c) => c.url.startsWith("https://upload.example"));
    assert.equal(chunks.length, 3, "21 MiB in 10 MiB chunks");
    assert.ok(chunks.every((c) => c.auth === null), "the pre-authorised URL gets no Authorization header");
  });
  it("a brief 503 is retried inside the client; a lasting one throws and nothing is half-saved", async () => {
    const g = client();
    const f = await g.ensureFolder("ROOT", "Chat");
    failPuts = 1;
    await g.uploadFile(f.id, "a.jpg", small());
    assert.equal(files.size, 1);
    failPuts = 10;
    await assert.rejects(g.uploadFile(f.id, "b.jpg", small()), (e: Error) => e instanceof GraphError && e.status === 503);
    assert.equal(files.size, 1);
  });
  it("refuses anything outside Uni Events, and sends only GET, POST and PUT", async () => {
    const g = client();
    await assert.rejects(g.ensureFolder("SOMEWHERE-ELSE", "x"), /outside the Uni Events folder/);
    await assert.rejects(g.uploadFile("SOMEWHERE-ELSE", "x.jpg", small()), /outside the Uni Events folder/);
    assert.equal(calls.length, 0, "nothing was even sent");
    const f = await g.ensureFolder("ROOT", "Chat");
    await g.uploadFile(f.id, "a.jpg", small());
    await g.quota();
    assert.deepEqual([...new Set(calls.map((c) => c.method))].sort(), ["GET", "POST", "PUT"]);
    for (const c of calls) assert.ok(/\/me\/drive(\?\$select=quota|\/items\/(ROOT|folder\d+))/.test(c.url) || c.url.startsWith("https://upload.example"), c.url);
  });
  it("a name with slashes can never climb out of its folder", async () => {
    const g = client();
    const f = await g.ensureFolder("ROOT", "Chat");
    await g.uploadFile(f.id, "../../escape.jpg", small());
    assert.ok([...files.keys()].every((k) => k.startsWith(`${f.id}/`)), "stored under the folder it was sent to");
    assert.ok(calls.some((c) => c.url.includes("..%2F..%2Fescape.jpg")), "the slashes were escaped, not interpreted");
  });
  it("reports OneDrive space", async () => {
    assert.equal((await client().quota()).remaining, 50 * GB);
  });
});

// ---------------------------------------------------------------- the setup command, and what the code can never do

describe("setup and safety", () => {
  it("finds the folder path inside a OneDrive link (without hardcoding it) or accepts a plain path", () => {
    assert.equal(folderPathFromInput("https://onedrive.live.com/my?id=%2Fpersonal%2Fabc123%2FDocuments%2FPictures%2FUni%20Events&sortField=LinkFilename"), "Pictures/Uni Events");
    assert.equal(folderPathFromInput("Pictures/Uni Events"), "Pictures/Uni Events");
    assert.equal(folderPathFromInput("/Pictures/Uni Events/"), "Pictures/Uni Events");
    assert.equal(folderPathFromInput("https://onedrive.live.com/my?foo=1"), null);
  });
  it("nothing in src/photos can delete, list or search OneDrive, send a Beeper message, or run a downloaded file", () => {
    const dir = path.join(__dirname, "..", "..", "src", "photos");
    const banned: [RegExp, string][] = [
      [/["'`]DELETE["'`]|\.delete\(/, "delete"],
      [/\$search|\/search\(|\/children\?|\/root\/children|\/delta/, "list or search"],
      [/messages\.(send|edit|delete|create)|\.send\(|assets\.upload|uploadBase64|reactions?\.(add|delete)/, "send to Beeper"],
      [/child_process|execSync|execFile|\bspawn(Sync)?\(|eval\(|new Function/, "run something"],
    ];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [re, what] of banned) assert.ok(!re.test(text), `${f} must not ${what}`);
    }
  });
  it("the photos tables hold ids and counts, never message text", () => {
    const db = newDb();
    const cols = (db.prepare(`SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'media_%' OR m.name LIKE 'photo_%')`).all() as { tbl: string; col: string }[]).map((r) => `${r.tbl}.${r.col}`);
    assert.ok(!cols.some((c) => /text|body|caption|content/i.test(c.split(".")[1])), cols.join(", "));
  });
  it("state helpers round-trip", () => {
    const db = newDb();
    setState(db, "k", "v");
    assert.equal(getState(db, "k"), "v");
  });
});
