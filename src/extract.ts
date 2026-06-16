// Turn a free-form transcript into a structured ledger entry using an LLM.

import { config } from "./config.js";
import type { LedgerEntry } from "./db.js";

export type ExtractedEntry = Omit<
  LedgerEntry,
  "id" | "chatId" | "rawTranscript" | "createdAt"
>;

const SYSTEM_PROMPT = `Eres un asistente de contabilidad. Recibes lo que una persona dijo
en una nota de voz y devuelves UNA anotación contable en JSON estricto.

Devuelve SOLO un objeto JSON con estas claves:
- "direction": "income" si entró dinero, "expense" si salió dinero.
- "amount": número positivo (sin separadores de miles, punto decimal).
- "currency": código ISO de 3 letras si se menciona; si no, usa "ARS".
- "category": categoría corta (ej. "gas", "ventas", "sueldo") o null.
- "counterparty": nombre de la persona/empresa involucrada o null.
- "note": nota breve original o null.
- "occurredOn": fecha en formato YYYY-MM-DD. Si dice "hoy" usa {{today}}. Si no se sabe, usa {{today}}.

No incluyas texto fuera del JSON.`;

export async function extractEntry(
  transcript: string,
  today: string
): Promise<ExtractedEntry> {
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
    throw new Error(`Extraction failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const parsed = JSON.parse(data.choices[0].message.content) as ExtractedEntry;

  // Minimal validation / normalization.
  if (parsed.direction !== "income" && parsed.direction !== "expense") {
    throw new Error(`Invalid direction from model: ${parsed.direction}`);
  }
  parsed.amount = Math.abs(Number(parsed.amount));
  parsed.currency = (parsed.currency || "ARS").toUpperCase();
  parsed.occurredOn = parsed.occurredOn || today;

  return parsed;
}
