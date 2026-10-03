import { getSetting } from "../db";
import { type ClientTemplate, clientTexts } from "./texts";

/** Client text: a `settings` override ("tpl.<name>") if present, otherwise the built-in default. */
export async function template(db: D1Database, name: ClientTemplate): Promise<string> {
  const override = await getSetting<string>(db, `tpl.${name}`);
  return typeof override === "string" && override.trim() ? override : clientTexts[name];
}
