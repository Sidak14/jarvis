import { StatusPill, type PillKind } from "../components";
import type { Html } from "../html";
import type { ExpenseSource, SheetStatus, State } from "../vm/types";

// Small mappings shared by several pages: a state or status -> a pill.

export const stateKind = (s: State): PillKind => s;

export function sourcePill(s: ExpenseSource): Html {
  const label = { tap: "Tap", email: "Email", bank: "Bank", manual: "Manual" }[s];
  return StatusPill("info", label);
}

export function sheetPill(s: SheetStatus): Html {
  switch (s) {
    case "synced":
      return StatusPill("ok", "Synced");
    case "pending":
      return StatusPill("warn", "Pending");
    case "failed":
      return StatusPill("error", "Failed");
    case "duplicate":
      return StatusPill("off", "Merged");
    case "unreadable":
      return StatusPill("error", "Unreadable");
  }
}

export function runPill(status: "success" | "failure" | "running" | null, quiet = false): Html {
  if (status === "success") return StatusPill("ok", quiet ? "OK, nothing to report" : "OK");
  if (status === "failure") return StatusPill("error", "Failing");
  if (status === "running") return StatusPill("info", "Running");
  return StatusPill("off", "No result reported");
}
