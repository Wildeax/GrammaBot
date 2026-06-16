// Telegram bot: long-polls for messages, interprets them, and acts
// (record entries / summary / search / delete last / export CSV).

import { config } from "./config.js";
import {
  getUpdates,
  sendText,
  sendDocument,
  downloadFile,
  type TelegramMessage,
} from "./telegram.js";
import { transcribe } from "./transcribe.js";
import { interpret } from "./extract.js";
import {
  insertEntry,
  deleteLast,
  entriesBetween,
  searchEntries,
  pendingEntries,
  allEntries,
  type LedgerEntry,
} from "./db.js";

const WELCOME =
  "¡Hola! Soy tu asistente de cuentas 🧾\n\n" +
  "Contame por audio o por texto lo que gastaste o te entró, y yo lo anoto.\n\n" +
  "Por ejemplo:\n" +
  '• "El 17 de mayo pagué 300 mil de jornales, preparación del terreno: 3 jornales a 100 mil c/u"\n' +
  '• "Hoy Danilo sembró maíz, 1 jornal de 100 mil"\n\n' +
  "También podés decirme:\n" +
  '• "¿Cuánto gasté en enero?" — resumen de cualquier mes\n' +
  '• "¿Cuánto le pagué a Danilo?" — buscar movimientos\n' +
  '• "Borrá lo último" — si te equivocaste\n' +
  "• /pendientes — trabajos sin monto\n" +
  "• /exportar — bajar todo en un archivo de Excel\n\n" +
  "Mandame una nota de voz cuando quieras 🙂";

// --- formatting helpers ---------------------------------------------------

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function fmtAmount(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CO")}`;
}
function fmtMoney(amount: number, currency: string): string {
  return `${fmtAmount(amount)} ${currency}`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${Number(d)} ${MONTHS[mi]} ${y}`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStart(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

/** Two-line compact-but-detailed rendering of one entry. */
function renderEntry(e: LedgerEntry): string {
  const icon = e.direction === "income" ? "🟢" : "🔴";
  const money = e.status === "pending" ? "⏳ Pendiente" : `${icon} ${fmtMoney(e.amount, e.currency)}`;
  const detail: string[] = [];
  if (e.concept) detail.push(`📋 ${e.concept}`);
  if (e.quantity && e.unit) {
    const u = e.quantity === 1 ? e.unit : `${e.unit}es`;
    detail.push(`${e.quantity} ${u}${e.unitPrice ? ` × ${fmtAmount(e.unitPrice)} c/u` : ""}`);
  }
  if (e.counterparty) detail.push(`👤 ${e.counterparty}`);
  return `${fmtDate(e.occurredOn)} · ${money}\n${detail.join(" · ")}`.trim();
}

// --- access control -------------------------------------------------------

function isAllowed(chatId: number): boolean {
  return (
    config.allowedChatIds.length === 0 ||
    config.allowedChatIds.includes(String(chatId))
  );
}

// --- message dispatch -----------------------------------------------------

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  console.log(`message from chat ${chatId}: ${msg.voice ? "[voice]" : text}`);

  try {
    if (text.toLowerCase().startsWith("/miid")) {
      await sendText(chatId, `Tu ID de chat es: ${chatId}`);
      return;
    }
    if (!isAllowed(chatId)) {
      await sendText(chatId, "Este asistente es privado 🔒");
      return;
    }

    const lower = text.toLowerCase();
    if (lower.startsWith("/start") || lower.startsWith("/help") || lower.startsWith("/ayuda")) {
      await sendText(chatId, WELCOME);
    } else if (lower.startsWith("/export") || lower.startsWith("/exportar")) {
      await handleExport(chatId);
    } else if (lower.startsWith("/pendientes")) {
      await handlePending(chatId);
    } else if (lower.startsWith("/resumen")) {
      await handleSummary(chatId, monthStart(), today(), "este mes");
    } else if (msg.voice ?? msg.audio) {
      await handleTranscribed(chatId, (msg.voice ?? msg.audio)!.file_id);
    } else if (text) {
      await handleTranscribed(chatId, null, text);
    } else {
      await sendText(chatId, "Mandame una nota de voz contándome qué anotar 🙂");
    }
  } catch (err) {
    console.error("message error:", err);
    await sendText(chatId, "Uy, algo salió mal procesando eso. Probá de nuevo.");
  }
}

async function handleTranscribed(
  chatId: number,
  fileId: string | null,
  typedText?: string
): Promise<void> {
  let transcript: string;
  if (fileId) {
    const { buffer, mimeType } = await downloadFile(fileId);
    transcript = await transcribe(buffer, mimeType);
  } else {
    transcript = typedText ?? "";
  }
  if (!transcript) return;
  console.log(`transcript (chat ${chatId}): ${transcript}`);

  const action = await interpret(transcript, today());

  switch (action.intent) {
    case "entries": {
      const blocks = action.entries.map((e) => {
        insertEntry({ chatId: String(chatId), rawTranscript: transcript, ...e });
        return renderEntry(e as LedgerEntry);
      });
      const pendingCount = action.entries.filter((e) => e.status === "pending").length;
      const header =
        action.entries.length > 1
          ? `✅ Anoté ${action.entries.length} movimientos:`
          : "✅ Anotado:";
      let footer = "";
      if (pendingCount > 0)
        footer = `\n\n⏳ ${pendingCount} sin monto. Cuando sepas cuánto fue, contame y lo completás.`;
      await sendText(chatId, `${header}\n\n${blocks.join("\n\n")}${footer}`);
      break;
    }
    case "summary":
      await handleSummary(chatId, action.from, action.to, action.label);
      break;
    case "search":
      await handleSearch(chatId, action);
      break;
    case "delete_last":
      await handleDeleteLast(chatId);
      break;
    case "none":
      await sendText(
        chatId,
        "No entendí bien eso 🤔\n" +
          'Probá con algo como "pagué 100 mil a Danilo por un jornal de siembra" o\n' +
          '"¿cuánto gasté este mes?".'
      );
      break;
  }
}

async function handleSummary(
  chatId: number,
  from: string,
  to: string,
  label: string
): Promise<void> {
  const entries = entriesBetween(String(chatId), from, to);
  if (entries.length === 0) {
    await sendText(chatId, `No tengo anotaciones de ${label}.`);
    return;
  }

  const currency = entries.find((e) => e.currency)?.currency || config.defaultCurrency;
  let income = 0;
  let expense = 0;
  let pending = 0;
  const byCategory = new Map<string, number>();
  for (const e of entries) {
    if (e.status === "pending") {
      pending++;
      continue;
    }
    if (e.direction === "income") income += e.amount;
    else {
      expense += e.amount;
      const cat = e.category || "otros";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + e.amount);
    }
  }

  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cat, amt]) => `   • ${cat}: ${fmtMoney(amt, currency)}`)
    .join("\n");

  await sendText(
    chatId,
    `📊 Resumen — ${label} (${entries.length} anotaciones)\n\n` +
      `🟢 Ingresos: ${fmtMoney(income, currency)}\n` +
      `🔴 Gastos: ${fmtMoney(expense, currency)}\n` +
      `⚖️ Balance: ${fmtMoney(income - expense, currency)}` +
      (topCategories ? `\n\nGastos por categoría:\n${topCategories}` : "") +
      (pending > 0 ? `\n\n⏳ ${pending} movimiento(s) sin monto (ver /pendientes)` : "")
  );
}

async function handleSearch(
  chatId: number,
  filters: { text: string | null; counterparty: string | null; from: string | null; to: string | null; label: string }
): Promise<void> {
  const results = searchEntries(String(chatId), filters);
  if (results.length === 0) {
    await sendText(chatId, `No encontré nada sobre ${filters.label}.`);
    return;
  }
  const currency = results.find((e) => e.currency)?.currency || config.defaultCurrency;
  const total = results
    .filter((e) => e.status !== "pending")
    .reduce((s, e) => s + (e.direction === "expense" ? e.amount : 0), 0);
  const blocks = results.map((e) => renderEntry(e)).join("\n\n");
  await sendText(
    chatId,
    `🔎 ${filters.label} — ${results.length} resultado(s):\n\n${blocks}` +
      (total > 0 ? `\n\nTotal gastos en estos: ${fmtMoney(total, currency)}` : "")
  );
}

async function handlePending(chatId: number): Promise<void> {
  const items = pendingEntries(String(chatId));
  if (items.length === 0) {
    await sendText(chatId, "No tenés trabajos pendientes de monto 👍");
    return;
  }
  const blocks = items.map((e) => renderEntry(e)).join("\n\n");
  await sendText(
    chatId,
    `⏳ ${items.length} sin monto:\n\n${blocks}\n\n` +
      "Cuando sepas cuánto fue cada uno, contámelo (ej: \"a Wilfer le pagué 100 mil\")."
  );
}

async function handleDeleteLast(chatId: number): Promise<void> {
  const removed = deleteLast(String(chatId));
  if (!removed) {
    await sendText(chatId, "No hay nada para borrar.");
    return;
  }
  await sendText(chatId, `🗑️ Borré la última anotación:\n\n${renderEntry(removed)}`);
}

function csvField(value: string | number | null): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function handleExport(chatId: number): Promise<void> {
  const entries = allEntries(String(chatId));
  if (entries.length === 0) {
    await sendText(chatId, "No hay anotaciones para exportar todavía.");
    return;
  }
  const header =
    "fecha,tipo,concepto,monto,moneda,cantidad,unidad,precio_unitario,quien,categoria,estado,nota";
  const rows = entries.map((e) =>
    [
      csvField(e.occurredOn),
      csvField(e.direction === "income" ? "ingreso" : "gasto"),
      csvField(e.concept),
      csvField(e.status === "pending" ? "" : e.amount),
      csvField(e.currency),
      csvField(e.quantity),
      csvField(e.unit),
      csvField(e.unitPrice),
      csvField(e.counterparty),
      csvField(e.category),
      csvField(e.status === "pending" ? "pendiente" : "registrado"),
      csvField(e.note),
    ].join(",")
  );
  const csv = "﻿" + [header, ...rows].join("\n"); // BOM so Excel reads UTF-8
  await sendDocument(chatId, `cuentas-${today()}.csv`, csv);
  await sendText(chatId, `📄 Listo, exporté ${entries.length} anotaciones.`);
}

async function main(): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  console.log("GrammaBot is running (Telegram long polling).");
  if (config.allowedChatIds.length > 0) {
    console.log(`Access restricted to chat IDs: ${config.allowedChatIds.join(", ")}`);
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (err) {
      console.error("polling error:", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
