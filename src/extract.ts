// Interpret a free-form message (voice or text) into an action the bot can run:
// record an entry, show a summary, delete the last entry, or nothing.

import { config } from "./config.js";
import type { LedgerEntry } from "./db.js";

export type ExtractedEntry = Omit<
  LedgerEntry,
  "id" | "chatId" | "rawTranscript" | "createdAt"
>;

export type Period = "today" | "week" | "month" | "all";

export type Action =
  | { intent: "entries"; entries: ExtractedEntry[] }
  | { intent: "summary"; period: Period }
  | { intent: "delete_last" }
  | { intent: "none" };

const SYSTEM_PROMPT = `Eres un asistente de contabilidad para una señora colombiana que habla
español con acento paisa (Antioquia/Medellín). Recibís lo que dijo en una nota de voz o
escribió, y devolvés UNA acción en JSON estricto.

Entendé la jerga paisa de plata:
- "luca" / "lucas" = miles de pesos. "5 lucas" = 5000. "una luca" = 1000.
- "barra" / "barras" = mil pesos (igual que luca).
- "palo" / "palos" = millones. "2 palos" = 2000000.
- "mil quinientos" = 1500, "veinte mil" = 20000, etc.
La moneda SIEMPRE es COP (pesos colombianos), salvo que diga explícitamente otra (dólares, etc.).

Devolvé SOLO un objeto JSON con una clave "intent" que sea una de:

1) "entries" — la persona está anotando uno O VARIOS gastos/ingresos en el mismo mensaje.
   Incluí "entries": un arreglo con un objeto por cada movimiento mencionado. Cada objeto:
   - "direction": "income" si entró plata, "expense" si salió.
   - "amount": número positivo en pesos (sin separadores, punto decimal). Convertí lucas/palos.
   - "currency": "COP" salvo que mencione otra explícitamente.
   - "category": categoría corta (ej. "gas", "mercado", "ventas", "arriendo") o null.
   - "counterparty": persona o negocio involucrado o null.
   - "note": nota breve o null.
   - "occurredOn": fecha YYYY-MM-DD. Si dice "hoy" usá {{today}}. Si no se sabe, usá {{today}}.
   IMPORTANTE: si menciona dos cosas (ej. un gasto y un ingreso), devolvé DOS objetos en "entries".

2) "summary" — pide un resumen o cuánto gastó/ingresó/le queda. Incluí:
   - "period": "today", "week", "month" o "all". Si no especifica, usá "month".

3) "delete_last" — quiere borrar/deshacer la última anotación ("borrá lo último",
   "eliminá el último", "me equivoqué", "ese no").

4) "none" — saludo, pregunta general, o algo que no es ninguna de las anteriores.

No incluyas texto fuera del JSON.`;

interface RawEntry {
  direction?: string;
  amount?: number | string;
  currency?: string;
  category?: string | null;
  counterparty?: string | null;
  note?: string | null;
  occurredOn?: string;
  intent?: string;
}

interface RawAction extends RawEntry {
  entries?: RawEntry[];
  period?: string;
}

function toEntry(raw: RawEntry, today: string): ExtractedEntry | null {
  if (raw.direction !== "income" && raw.direction !== "expense") return null;
  const amount = Math.abs(Number(raw.amount) || 0);
  if (amount <= 0) return null;
  return {
    direction: raw.direction,
    amount,
    currency: (raw.currency || config.defaultCurrency).toUpperCase(),
    category: raw.category ?? null,
    counterparty: raw.counterparty ?? null,
    note: raw.note ?? null,
    occurredOn: raw.occurredOn || today,
  };
}

export async function interpret(transcript: string, today: string): Promise<Action> {
  if (!config.llm.apiKey) {
    throw new Error("LLM_API_KEY is not set");
  }

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT.replaceAll("{{today}}", today) },
        { role: "user", content: transcript },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Interpretation failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsedRaw = JSON.parse(data.choices[0].message.content);

  // Be robust to the model returning a bare array of entries instead of an object.
  const parsed: RawAction = Array.isArray(parsedRaw)
    ? { intent: "entries", entries: parsedRaw }
    : parsedRaw;

  // Collect any entry-shaped objects: from "entries", or a single inline entry.
  const rawEntries: RawEntry[] =
    parsed.entries && Array.isArray(parsed.entries)
      ? parsed.entries
      : parsed.direction
        ? [parsed]
        : [];

  if (parsed.intent === "summary") {
    const valid: Period[] = ["today", "week", "month", "all"];
    const period = valid.includes(parsed.period as Period)
      ? (parsed.period as Period)
      : "month";
    return { intent: "summary", period };
  }

  if (parsed.intent === "delete_last") {
    return { intent: "delete_last" };
  }

  const entries = rawEntries
    .map((r) => toEntry(r, today))
    .filter((e): e is ExtractedEntry => e !== null);

  if (entries.length > 0) {
    return { intent: "entries", entries };
  }

  return { intent: "none" };
}
