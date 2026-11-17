import { ToolRegistry } from "../registry";
import { verifyPin } from "./pin";
import { ping } from "./ping";

/** Every tool the voice assistant has. Add one here and `npm run voice:push` gives it to the assistant. */
export const registry = new ToolRegistry([ping, verifyPin]);
