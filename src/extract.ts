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
  | { intent: "entry"; entry: ExtractedEntry }
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
La moneda por defecto es COP (pesos colombianos).

Devolvé SOLO un objeto JSON con una clave "intent" que sea una de:

1) "entry" — la persona está anotando un gasto o un ingreso. Incluí también:
   - "direction": "income" si entró plata, "expense" si salió.
   - "amount": número positivo en pesos (sin separadores, punto decimal). Convertí lucas/palos.
   - "currency": código ISO de 3 letras si lo menciona; si no, "COP".
   - "category": categoría corta (ej. "gas", "mercado", "ventas", "arriendo") o null.
   - "counterparty": persona o negocio involucrado o null.
   - "note": nota breve o null.
   - "occurredOn": fecha YYYY-MM-DD. Si dice "hoy" usá {{today}}. Si no se sabe, usá {{today}}.

2) "summary" — pide un resumen o cuánto gastó/ingresó/le queda. Incluí:
   - "period": "today", "week", "month" o "all". Si no especifica, usá "month".

3) "delete_last" — quiere borrar/deshacer la última anotación ("borrá lo último",
   "eliminá el último", "me equivoqué", "ese no").

4) "none" — saludo, pregunta general, o algo que no es ninguna de las anteriores.

No incluyas texto fuera del JSON.`;

interface RawAction {
  intent?: string;
  direction?: string;
  amount?: number | string;
  currency?: string;
  category?: string | null;
  counterparty?: string | null;
  note?: string | null;
  occurredOn?: string;
  period?: string;
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
  const parsed = JSON.parse(data.choices[0].message.content) as RawAction;

  switch (parsed.intent) {
    case "entry": {
      if (parsed.direction !== "income" && parsed.direction !== "expense") {
        return { intent: "none" };
      }
      const entry: ExtractedEntry = {
        direction: parsed.direction,
        amount: Math.abs(Number(parsed.amount) || 0),
        currency: (parsed.currency || config.defaultCurrency).toUpperCase(),
        category: parsed.category ?? null,
        counterparty: parsed.counterparty ?? null,
        note: parsed.note ?? null,
        occurredOn: parsed.occurredOn || today,
      };
      if (entry.amount <= 0) return { intent: "none" };
      return { intent: "entry", entry };
    }
    case "summary": {
      const valid: Period[] = ["today", "week", "month", "all"];
      const period = valid.includes(parsed.period as Period)
        ? (parsed.period as Period)
        : "month";
      return { intent: "summary", period };
    }
    case "delete_last":
      return { intent: "delete_last" };
    default:
      return { intent: "none" };
  }
}
