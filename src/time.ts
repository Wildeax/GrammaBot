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

/** Current hour (0-23) in the configured timezone. */
export function localHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      hour: "2-digit",
      hour12: false,
    }).format(new Date())
  );
}

/** Current weekday in the configured timezone: 0=Sunday … 6=Saturday. */
export function localWeekday(): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
  }).format(new Date());
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** Inclusive [from,to] (YYYY-MM-DD) of the month BEFORE the current local month, with a label. */
export function previousMonthRange(): { from: string; to: string; label: string } {
  const [y, m] = localToday().split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate(); // day 0 of next month = last day
  const mm = String(pm).padStart(2, "0");
  const months = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
  ];
  return {
    from: `${py}-${mm}-01`,
    to: `${py}-${mm}-${String(lastDay).padStart(2, "0")}`,
    label: `${months[pm - 1]} ${py}`,
  };
}

/** Inclusive [from,to] for the last 7 days ending today (local). */
export function last7DaysRange(): { from: string; to: string; label: string } {
  const to = localToday();
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return { from: d.toISOString().slice(0, 10), to, label: "los últimos 7 días" };
}
