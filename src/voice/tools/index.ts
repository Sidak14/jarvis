import { ToolRegistry } from "../registry";
import { calendarToday } from "./calendar";
import type { ToolDeps } from "./deps";
import { expensesSummary } from "./expenses";
import { garageStatus } from "./garage";
import { homeStatus } from "./home";
import { verifyPin } from "./pin";
import { ping } from "./ping";
import { plansUpcoming } from "./plans";
import { spotifyRecent } from "./spotify";

/** Every tool the voice assistant has. Add one here and `npm run voice:push` gives it to the assistant. */
export function buildRegistry(deps: ToolDeps): ToolRegistry {
  return new ToolRegistry([ping, verifyPin, garageStatus(deps), homeStatus(deps), calendarToday(deps), expensesSummary(deps), plansUpcoming(deps), spotifyRecent(deps)]);
}
