import { Settings } from "./store";

export { DEFS, GROUPS, type Def, type Group } from "./defs";
export { parseSetting, Settings, type SettingKey } from "./store";

/** The one settings object. db.ts binds it to the database at startup; until then everything is the default. */
export const settings = new Settings();
