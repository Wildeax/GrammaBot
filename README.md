# GrammaBot 🧾

An AI assistant that helps keep accounting/bookkeeping records straight by **talking to it on WhatsApp**.

The idea is simple: the user sends a **voice note** ("noté 5.000 de gas hoy", "cobré 20.000 del cliente Pérez"), and the bot does all the techy work — it transcribes the audio, understands what was said, and saves a clean ledger entry. No spreadsheets, no apps to learn. Just talk.

Built so a non-technical person can keep their books by simply *telling* the assistant what to note.

## How it works

```
WhatsApp voice note ──► Webhook (Hono) ──► Transcribe (Whisper)
                                              │
                                              ▼
                                     Understand (LLM extraction)
                                              │
                                              ▼
                                   Save ledger entry (SQLite)
                                              │
                                              ▼
                              Confirmation reply on WhatsApp
```

## Stack

| Concern            | Choice                                    |
| ------------------ | ----------------------------------------- |
| Runtime            | Node.js 20 + TypeScript                   |
| Messaging          | WhatsApp Cloud API (official Meta Graph)  |
| Web server         | Hono                                      |
| Speech-to-text     | Whisper (OpenAI / Groq, configurable)     |
| Understanding      | LLM, provider-agnostic via env            |
| Storage            | SQLite (better-sqlite3)                    |

## Getting started

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

Then expose your local server (e.g. with `ngrok http 3000`) and register the public URL as the webhook in the [WhatsApp Cloud API setup](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started).

## Environment

See [`.env.example`](./.env.example) for all required variables.

## Status

Early scaffold — webhook, transcription, extraction, and storage modules are stubbed with TODOs. See the modules in [`src/`](./src).

## License

MIT
