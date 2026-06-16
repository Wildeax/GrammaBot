// Shared money/date formatting (used by the bot handlers and the scheduled reports).

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function fmtAmount(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CO")}`;
}

export function fmtMoney(amount: number, currency: string): string {
  return `${fmtAmount(amount)} ${currency}`;
}

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${Number(d)} ${MONTHS[mi]} ${y}`;
}
