// Speech-to-text for WhatsApp voice notes, via an OpenAI-compatible Whisper endpoint.

import { config } from "./config.js";

/**
 * Transcribe an audio buffer to text.
 * @param audio  Raw audio bytes (e.g. an OGG/Opus WhatsApp voice note).
 * @param mimeType  MIME type of the audio, e.g. "audio/ogg".
 */
export async function transcribe(audio: Buffer, mimeType = "audio/ogg"): Promise<string> {
  if (!config.transcribe.apiKey) {
    throw new Error("TRANSCRIBE_API_KEY is not set");
  }

  const form = new FormData();
  const ext = mimeType.split("/")[1] ?? "ogg";
  form.append("file", new Blob([audio], { type: mimeType }), `voice.${ext}`);
  form.append("model", config.transcribe.model);
  form.append("language", config.defaultLanguage);

  const res = await fetch(`${config.transcribe.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.transcribe.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { text: string };
  return data.text.trim();
}
