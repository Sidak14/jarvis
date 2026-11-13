// Event photos -> OneDrive: every knob that is not an env setting, in one place.
// (The env settings are PHOTOS_DRY_RUN, PHOTO_WINDOW_START, PHOTOS_MIN_RUN, PHOTOS_RUN_GAP_MINUTES in config.ts.)

export const POLL_JOB = "photos-poll";
export const POLL_CRON = "*/5 * * * *";

// ---- The photo window
/** No end time on the plan: assume it lasted this long. */
export const DEFAULT_DURATION_HOURS = 2;
/** Photos count for this long after the plan ends (Sydney wall-clock hours, so a clock-change day is still "the next day"). */
export const WINDOW_HOURS = 24;
/** The final sweep re-reads the whole window this long after it closes. */
export const SWEEP_AFTER_MINUTES = 30;
/** Plans whose window closed longer ago than this are not looked at (nothing from before the feature existed). */
export const MAX_BACKLOG_DAYS = 3;

// ---- Reading Beeper
export const SCAN_PAGES = 6;
export const SWEEP_PAGES = 40;
/** Each scan starts this far before the last one, so a late-arriving message is never missed. */
export const SCAN_OVERLAP_MINUTES = 15;
export const MEDIA_SEEN_KEEP_DAYS = 30;

// ---- Downloading and uploading
export const MAX_FILE_BYTES = 1024 ** 3; // skip any single file over 1 GB
export const DAILY_BYTES_CAP = 5 * 1024 ** 3; // stop for the day above 5 GB
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3; // keep at least this much disk free
export const LOW_ONEDRIVE_BYTES = 1024 ** 3; // alert below this much free OneDrive space
export const SMALL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // Graph: a plain PUT up to 4 MB, an upload session above
export const UPLOAD_CHUNK_BYTES = 320 * 1024 * 32; // Graph wants a multiple of 320 KiB (10 MiB)
export const MAX_UPLOADS_PER_RUN = 25;
/** A failed upload is tried again after these many minutes (the last value repeats). */
export const RETRY_MINUTES = [5, 15, 60, 240, 720];
/** After this many failures a file is marked failed (and you are told). It stays on the plans page. */
export const MAX_ATTEMPTS = 10;

// ---- Names
export const MAX_NAME_CHARS = 80;
export const ROOT_FOLDER_NAME = "Uni Events";

// ---- Microsoft sign-in (personal accounts, device code flow)
export const MS_LOGIN_BASE = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Files.ReadWrite is the narrowest Graph scope that can write into a normal folder (see README). */
export const MS_SCOPES = ["Files.ReadWrite", "offline_access"];
/** A personal-account refresh token dies after about this many days without being used. */
export const REFRESH_TOKEN_DAYS = 90;
export const TOKEN_WARN_DAYS = 14;
/** The job refreshes the login at least this often, so it can never go unused. */
export const KEEPALIVE_HOURS = 24;

export const COOLDOWN_ALERT_MS = 6 * 3_600_000;
