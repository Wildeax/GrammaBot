// Summary text, Excel export, scheduled reports, and OpenRouter credit alerts.

import ExcelJS from "exceljs";
import { config, ownerChat } from "./config.js";
import { fmtMoney } from "./format.js";
import {
  entriesBetween,
  allEntries,
  distinctChatIds,
  metaGet,
  metaSet,
  type LedgerEntry,
} from "./db.js";
import { sendText } from "./telegram.js";
import { localToday, localHour, localWeekday, previousMonthRange, last7DaysRange } from "./time.js";

interface Agg {
  income: number;
  expense: number;
  cats: Map<string, number>;
}

/** Build a per-currency summary message for a date range. Returns null if there are no entries. */
export function buildSummaryText(
  chatId: string,
  from: string,
  to: string,
  label: string
): string | null {
  const entries = entriesBetween(chatId, from, to);
  if (entries.length === 0) return null;

  const byCurrency = new Map<string, Agg>();
  let pending = 0;
  for (const e of entries) {
    if (e.status === "pending") {
      pending++;
      continue;
    }
    const cur = e.currency || config.defaultCurrency;
    const agg = byCurrency.get(cur) ?? { income: 0, expense: 0, cats: new Map() };
    if (e.direction === "income") agg.income += e.amount;
    else {
      agg.expense += e.amount;
      const cat = e.category || "otros";
      agg.cats.set(cat, (agg.cats.get(cat) ?? 0) + e.amount);
    }
    byCurrency.set(cur, agg);
  }

  const blocks = [...byCurrency.entries()].map(([cur, a]) => {
    const top = [...a.cats.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([cat, amt]) => `   • ${cat}: ${fmtMoney(amt, cur)}`)
      .join("\n");
    return (
      `🟢 Ingresos: ${fmtMoney(a.income, cur)}\n` +
      `🔴 Gastos: ${fmtMoney(a.expense, cur)}\n` +
      `⚖️ Balance: ${fmtMoney(a.income - a.expense, cur)}` +
      (top ? `\n\nGastos por categoría:\n${top}` : "")
    );
  });

  return (
    `📊 ${label} (${entries.length} anotaciones)\n\n` +
    blocks.join("\n\n— — —\n\n") +
    (pending > 0 ? `\n\n⏳ ${pending} movimiento(s) sin monto (ver /pendientes)` : "")
  );
}

/** Build a formatted .xlsx workbook (Movimientos + Resumen) for a chat. */
export async function buildWorkbook(chatId: string): Promise<Uint8Array> {
  const entries = allEntries(chatId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "GrammaBot";

  const mov = wb.addWorksheet("Movimientos");
  mov.columns = [
    { header: "Fecha", key: "fecha", width: 12 },
    { header: "Tipo", key: "tipo", width: 9 },
    { header: "Concepto", key: "concepto", width: 34 },
    { header: "Monto", key: "monto", width: 14 },
    { header: "Moneda", key: "moneda", width: 8 },
    { header: "Cantidad", key: "cantidad", width: 9 },
    { header: "Unidad", key: "unidad", width: 9 },
    { header: "Precio unit.", key: "precio", width: 13 },
    { header: "Quién", key: "quien", width: 16 },
    { header: "Categoría", key: "categoria", width: 16 },
    { header: "Estado", key: "estado", width: 11 },
    { header: "Nota", key: "nota", width: 30 },
  ];
  for (const e of entries as LedgerEntry[]) {
    mov.addRow({
      fecha: e.occurredOn,
      tipo: e.direction === "income" ? "ingreso" : "gasto",
      concepto: e.concept ?? "",
      monto: e.status === "pending" ? null : e.amount,
      moneda: e.currency,
      cantidad: e.quantity ?? null,
      unidad: e.unit ?? "",
      precio: e.unitPrice ?? null,
      quien: e.counterparty ?? "",
      categoria: e.category ?? "",
      estado: e.status === "pending" ? "pendiente" : "registrado",
      nota: e.note ?? "",
    });
  }
  mov.getRow(1).font = { bold: true };
  mov.getColumn("monto").numFmt = "#,##0";
  mov.getColumn("precio").numFmt = "#,##0";
  mov.views = [{ state: "frozen", ySplit: 1 }];

  // Resumen sheet: totals per currency + by category.
  const res = wb.addWorksheet("Resumen");
  res.columns = [
    { header: "Concepto", key: "k", width: 26 },
    { header: "Monto", key: "v", width: 16 },
    { header: "Moneda", key: "c", width: 8 },
  ];
  res.getRow(1).font = { bold: true };
  const byCur = new Map<string, Agg>();
  for (const e of entries) {
    if (e.status === "pending") continue;
    const cur = e.currency || config.defaultCurrency;
    const a = byCur.get(cur) ?? { income: 0, expense: 0, cats: new Map() };
    if (e.direction === "income") a.income += e.amount;
    else {
      a.expense += e.amount;
      a.cats.set(e.category || "otros", (a.cats.get(e.category || "otros") ?? 0) + e.amount);
    }
    byCur.set(cur, a);
  }
  for (const [cur, a] of byCur) {
    res.addRow({ k: "Ingresos", v: a.income, c: cur });
    res.addRow({ k: "Gastos", v: a.expense, c: cur });
    res.addRow({ k: "Balance", v: a.income - a.expense, c: cur });
    for (const [cat, amt] of [...a.cats.entries()].sort((x, y) => y[1] - x[1])) {
      res.addRow({ k: `  Gasto · ${cat}`, v: amt, c: cur });
    }
    res.addRow({});
  }
  res.getColumn("v").numFmt = "#,##0";

  // exceljs returns a Node Buffer at runtime (which is a Uint8Array).
  return (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
}

/** Monthly close on the 1st (3-day grace) and a weekly summary on Mondays. Deduped via meta. */
export async function runScheduledReports(): Promise<void> {
  if (localHour() < config.reportHour) return;
  const day = Number(localToday().slice(8, 10));
  const chats = distinctChatIds();

  if (day <= 3) {
    const { from, to, label } = previousMonthRange();
    for (const chat of chats) {
      const key = `rep:m:${chat}:${from}`;
      if (metaGet(key)) continue;
      const text = buildSummaryText(chat, from, to, `Cierre de ${label}`);
      if (text) await sendText(Number(chat), `🗓️ ${text}`);
      metaSet(key, "1");
    }
  }

  if (config.weeklySummary && localWeekday() === 1) {
    const { from, to, label } = last7DaysRange();
    for (const chat of chats) {
      const key = `rep:w:${chat}:${to}`;
      if (metaGet(key)) continue;
      const text = buildSummaryText(chat, from, to, `Resumen de ${label}`);
      if (text) await sendText(Number(chat), text);
      metaSet(key, "1");
    }
  }
}

/** Alert the owner when OpenRouter remaining credit drops below the threshold (once per low state). */
export async function checkCredit(): Promise<void> {
  const owner = ownerChat();
  if (!owner) return;
  try {
    const res = await fetch(`${config.llm.baseUrl}/credits`, {
      headers: { Authorization: `Bearer ${config.llm.apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return; // not OpenRouter or transient — skip silently
    const d = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } };
    if (!d.data) return;
    const remaining = Number(d.data.total_credits ?? 0) - Number(d.data.total_usage ?? 0);
    const low = remaining < config.creditAlertUsd;
    const alerted = metaGet("credit:lowAlerted") === "1";

    if (low && !alerted) {
      await sendText(
        owner,
        `⚠️ Atención: a GrammaBot le quedan ~$${remaining.toFixed(2)} USD de crédito en OpenRouter.\n` +
          "Recargá pronto para que el bot siga transcribiendo y anotando sin cortes."
      );
      metaSet("credit:lowAlerted", "1");
    } else if (!low && alerted) {
      metaSet("credit:lowAlerted", "0"); // recharged → re-arm the alert
    }
  } catch {
    /* ignore */
  }
}
