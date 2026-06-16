// Civil-date helpers anchored to the configured timezone (NOT the server/UTC clock).
// Critical for an accounting app: a transaction's date must match the user's local day.

import { config } from "./config.js";

/** The user's local calendar date as YYYY-MM-DD (e.g. America/Bogota), regardless of server TZ. */
export function localToday(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(new Date());
}

/** First day of the user's current local month, YYYY-MM-DD. */
export function localMonthStart(): string {
  return `${localToday().slice(0, 7)}-01`;
}
