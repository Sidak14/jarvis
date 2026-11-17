import { ToolRegistry } from "../registry";
import { ping } from "./ping";

/** Every tool the voice assistant has. Add one here and `npm run voice:push` gives it to the assistant. */
export const registry = new ToolRegistry([ping]);
