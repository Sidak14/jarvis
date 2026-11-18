import { Cron } from "croner";

/** Is this a schedule croner understands? Returns a plain message if not. */
export function checkCron(expression: string): string | null {
  try {
    new Cron(expression, { paused: true }).stop();
    return null;
  } catch {
    return "not a valid schedule (five parts, like */5 * * * *)";
  }
}
