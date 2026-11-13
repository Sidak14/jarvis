import { config } from "../config";
import { db } from "../db";
import { OneDriveAuth } from "./onedrive-auth";

/** The one shared OneDrive login for the whole server (own Azure app, personal Microsoft account). */
export const oneDriveAuth = new OneDriveAuth(db, config.MS_CLIENT_ID ?? "");
