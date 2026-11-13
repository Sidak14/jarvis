import type Database from "better-sqlite3";

// The shapes shared by the view-model builders (src/ui/vm) and the page templates (src/ui/pages).
// A view-model is plain data: no HTML, no database handles. That is what makes it testable.

export type State = "ok" | "warn" | "error" | "off";

export interface Issue {
  module: string;
  text: string;
  severity: "warn" | "error";
  link: string;
}

export interface Fact {
  label: string;
  value: string;
}

export interface ModuleStatus {
  key: string;
  name: string;
  state: State;
  summary: string;
  lastOkAt: Date | null;
  link: string;
  issues: string[];
  /** "Live" / "Dry run" when the module has a mode. */
  mode?: "live" | "dry";
  /** Everything the old status page showed, kept (shown under "Details"). */
  facts: Fact[];
}

export interface StatTileVM {
  label: string;
  value: string;
  sub?: string;
  state?: State;
  href?: string;
}

export interface OverviewVM {
  health: { state: "ok" | "warn" | "error"; items: Issue[] };
  tiles: StatTileVM[];
  modules: ModuleStatus[];
}

export type ExpenseSource = "tap" | "email" | "bank" | "manual";
export type SheetStatus = "synced" | "pending" | "failed" | "duplicate" | "unreadable";

export interface ExpenseRowVM {
  id: number;
  /** When it happened (the purchase). */
  purchasedAt: Date;
  /** When Jarvis logged it. */
  addedAt: Date;
  merchant: string;
  amountCents: number | null;
  currency: string;
  category: string | null;
  source: ExpenseSource;
  sheetStatus: SheetStatus;
  tries: number;
  isTest: boolean;
  card: string | null;
  sheetRow: number | null;
  emailMessageId: string | null;
  lastError: string | null;
}

export interface JobVM {
  name: string;
  scheduleHuman: string;
  cron: string;
  enabled: boolean;
  lastRunAt: Date | null;
  /** null = never reported. A quiet job that ran fine and had nothing to say is "success" with quiet = true. */
  lastStatus: "success" | "failure" | "running" | null;
  quiet: boolean;
  lastDurationMs: number | null;
  nextRunAt: Date | null;
  overdue: boolean;
  overdueReason: string | null;
  /** Registered, has never run, and its first run is not due yet. */
  waiting: boolean;
  consecutiveFailures: number;
  /** In the database but no longer scheduled by this server (an old job that was renamed or removed). */
  retired: boolean;
}

export interface RunVM {
  id: number;
  job: string;
  startedAt: Date;
  status: "success" | "failure" | "running";
  durationMs: number | null;
  log: string | null;
}

export type PlanStance = "none" | "committed" | "declined" | "unsure";

export interface PlanVM {
  id: string; // "P-0001"
  title: string;
  /** "Sat 14 Nov, 7:00pm" */
  when: string;
  /** Calendar chip: day of month and short month, or null when there is no date yet. */
  dayChip: { day: string; month: string } | null;
  where: string | null;
  chat: string;
  myStance: PlanStance;
  planStatus: "proposed" | "confirmed" | "cancelled";
  updatedAt: Date;
  calendarUrl: string | null;
  why: string[];
  details: string[];
  clash: boolean;
  onCalendar: boolean;
  /** A link the plan carries (only http(s) links are ever stored). */
  url: string | null;
}

/** What the runtime provides (config flags, logins, scheduler). Built from the real config in context.ts; faked in tests. */
export interface RegisteredJob {
  name: string;
  cron: string;
  timezone: string | null;
  intervalMs: number;
}
export interface UiFlags {
  sheetConfigured: boolean;
  gmailConfigured: boolean;
  gmailConnected: boolean;
  gmailDryRun: boolean;
  spotifyConfigured: boolean;
  spotifyConnected: boolean;
  spotifyDryRun: boolean;
  telegramConfigured: boolean;
  telegramOwnerSet: boolean;
  telegramQuestions: boolean;
  beeperConfigured: boolean;
  beeperBaseUrl: string;
  plansDryRun: boolean;
  plansAllChats: boolean;
  calendarConnected: boolean;
  aiConfigured: boolean;
}
export interface UiContext {
  db: Database.Database;
  now: Date;
  flags: UiFlags;
  registered: RegisteredJob[];
}
