// Interpret a free-form message (voice or text) into an action the bot can run:
// record entries, show a summary, search past entries, delete the last, or nothing.

import { config } from "./config.js";
import type { LedgerEntry } from "./db.js";

export type ExtractedEntry = Omit<
  LedgerEntry,
  "id" | "chatId" | "rawTranscript" | "createdAt"
>;

export type Action =
  | { intent: "entries"; entries: ExtractedEntry[] }
  | { intent: "summary"; from: string; to: string; label: string }
  | {
      intent: "search";
      text: string | null;
      counterparty: string | null;
      from: string | null;
      to: string | null;
      label: string;
    }
  | { intent: "delete_last" }
  | { intent: "none" };

const SYSTEM_PROMPT = `Eres un asistente de contabilidad para una señora colombiana que habla
español con acento paisa (Antioquia/Medellín), llevando las cuentas de una finca/cultivos.
Recibís lo que dijo en una nota de voz o escribió, y devolvés UNA acción en JSON estricto.
Hoy es {{today}}.

Entendé la jerga paisa de plata:
- "luca"/"lucas" = miles de pesos ("5 lucas" = 5000). "barra"/"barras" = mil pesos.
- "palo"/"palos" = millones ("2 palos" = 2000000). "mil quinientos" = 1500, "veinte mil" = 20000.
La moneda SIEMPRE es COP salvo que diga explícitamente otra.

Devolvé SOLO un objeto JSON con "intent", que sea una de:

1) "entries" — anota uno O VARIOS movimientos. Incluí "entries": arreglo, un objeto por movimiento:
   - "direction": "income" si entró plata, "expense" si salió.
   - "amount": total en pesos (número, sin separadores). null si NO menciona monto.
   - "currency": "COP" salvo otra explícita.
   - "concept": descripción rica pero CONCISA de para qué fue, incluyendo el cultivo/labor si lo
     dice (ej. "Preparación del terreno (picar)", "Siembra de maíz", "Abono para aromáticas").
   - "category": bucket corto ("mano de obra", "insumos", "siembra", "cosecha", "venta", etc.) o null.
   - "quantity": cantidad si aplica (ej. 3 jornales) o null.
   - "unit": unidad ("jornal", "kg", "bulto") o null.
   - "unitPrice": precio por unidad si lo dice o se deduce (300000/3=100000) o null.
   - "counterparty": persona/negocio (ej. "Danilo", "Wilfer") o null.
   - "note": detalle extra o null.
   - "occurredOn": fecha YYYY-MM-DD. Parseá fechas explícitas ("mayo 17 2026"->2026-05-17,
     "junio 11"->usá el año de hoy). "este mismo día"/"ese día" = la fecha del movimiento anterior
     del mensaje. Si no hay fecha, usá {{today}}.
   Si menciona varias labores/pagos, devolvé varios objetos.

2) "summary" — pide un resumen o cuánto gastó/ingresó/le queda en algún periodo. Resolvé el
   periodo a fechas concretas según hoy. Incluí:
   - "from": fecha inicio YYYY-MM-DD (inclusive).
   - "to": fecha fin YYYY-MM-DD (inclusive).
   - "label": etiqueta humana del periodo (ej. "enero 2026", "este mes", "esta semana", "en total").
   Ejemplos: "este mes" -> del 1 del mes actual a hoy. "enero" -> del 2026-01-01 al 2026-01-31.
   "el año pasado" -> 2025-01-01 a 2025-12-31. "todo" -> from "0000-01-01" a {{today}}.

3) "search" — pide recordar/buscar transacciones específicas del pasado. Incluí:
   - "text": palabra clave (concepto/cultivo/labor) o null.
   - "counterparty": persona si la menciona o null.
   - "from"/"to": rango de fechas YYYY-MM-DD si aplica, o null.
   - "label": descripción humana de lo buscado (ej. "pagos a Danilo en mayo").

4) "delete_last" — borrar/deshacer la última anotación ("borrá lo último", "me equivoqué").

5) "none" — saludo, pregunta general, o nada de lo anterior.

No incluyas texto fuera del JSON.`;

interface RawEntry {
  direction?: string;
  amount?: number | string | null;
  currency?: string;
  concept?: string | null;
  category?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  unitPrice?: number | string | null;
  counterparty?: string | null;
  note?: string | null;
  occurredOn?: string;
  intent?: string;
}

interface RawAction extends RawEntry {
  entries?: RawEntry[];
  from?: string | null;
  to?: string | null;
  text?: string | null;
  label?: string;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toEntry(raw: RawEntry, today: string): ExtractedEntry | null {
  if (raw.direction !== "income" && raw.direction !== "expense") return null;
  const amount = numOrNull(raw.amount);
  const concept = raw.concept ?? null;
  // Keep entries that have a concept even without amount (recorded as pending).
  if (amount === null && !concept) return null;
  return {
    direction: raw.direction,
    amount: amount ?? 0,
    currency: (raw.currency || config.defaultCurrency).toUpperCase(),
    concept,
    category: raw.category ?? null,
    counterparty: raw.counterparty ?? null,
    quantity: numOrNull(raw.quantity),
    unit: raw.unit ?? null,
    unitPrice: numOrNull(raw.unitPrice),
    note: raw.note ?? null,
    occurredOn: raw.occurredOn || today,
    status: amount === null ? "pending" : "recorded",
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
  const parsed: RawAction = Array.isArray(parsedRaw)
    ? { intent: "entries", entries: parsedRaw }
    : parsedRaw;

  if (parsed.intent === "summary") {
    return {
      intent: "summary",
      from: parsed.from || "0000-01-01",
      to: parsed.to || today,
      label: parsed.label || "el periodo",
    };
  }

  if (parsed.intent === "search") {
    return {
      intent: "search",
      text: parsed.text ?? null,
      counterparty: parsed.counterparty ?? null,
      from: parsed.from ?? null,
      to: parsed.to ?? null,
      label: parsed.label || "tu búsqueda",
    };
  }

  if (parsed.intent === "delete_last") {
    return { intent: "delete_last" };
  }

  const rawEntries: RawEntry[] =
    parsed.entries && Array.isArray(parsed.entries)
      ? parsed.entries
      : parsed.direction
        ? [parsed]
        : [];

  const entries = rawEntries
    .map((r) => toEntry(r, today))
    .filter((e): e is ExtractedEntry => e !== null);

  if (entries.length > 0) {
    return { intent: "entries", entries };
  }

  return { intent: "none" };
}
