// The living room TV (Samsung The Frame) through Home Assistant. The page sends one of these key NAMES; the server looks the
// Samsung key code up here, so nothing else can be sent to the TV from the screen.

export const TV_PLAYER = "media_player.samsung_the_frame_55_qa55ls03aawxxy";
export const TV_REMOTE = "remote.samsung_the_frame_55_qa55ls03aawxxy";

export const TV_KEYS = {
  power: "KEY_POWER",
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  ok: "KEY_ENTER",
  back: "KEY_RETURN",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  vol_up: "KEY_VOLUP",
  vol_down: "KEY_VOLDOWN",
  mute: "KEY_MUTE",
  play: "KEY_PLAY",
  pause: "KEY_PAUSE",
  ch_up: "KEY_CHUP",
  ch_down: "KEY_CHDOWN",
} as const;
export type TvKey = keyof typeof TV_KEYS;
export const isTvKey = (k: unknown): k is TvKey => typeof k === "string" && Object.prototype.hasOwnProperty.call(TV_KEYS, k);

export interface Tv {
  /** "on" | "off" | "unavailable" */
  state: "on" | "off" | "unavailable";
  muted: boolean;
  /** 0 to 100, or null */
  volume: number | null;
  /** Inputs the TV reports (TV, HDMI...). */
  sources: string[];
  source: string | null;
}
