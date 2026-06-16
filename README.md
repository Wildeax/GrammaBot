# GrammaBot 🧾

An AI assistant that helps keep accounting/bookkeeping records straight by **talking to it on Telegram**.

The idea is simple: the user sends a **voice note** ("noté 5.000 de gas hoy", "cobré 20.000 del cliente Pérez"), and the bot does all the techy work — it transcribes the audio, understands what was said, and saves a clean ledger entry. No spreadsheets, no apps to learn. Just talk.

Built so a non-technical person can keep their books by simply *telling* the assistant what to note.

## How it works

```
Telegram voice note ──► Bot (long polling) ──► Transcribe (Whisper)
                                                  │
                                                  ▼
                                         Understand (LLM extraction)
                                                  │
                                                  ▼
                                       Save ledger entry (SQLite)
                                                  │
                                                  ▼
                                  Confirmation reply on Telegram
```

## Stack

| Concern            | Choice                                    |
| ------------------ | ----------------------------------------- |
| Runtime            | Node.js 20 + TypeScript                   |
| Messaging          | Telegram Bot API (free, long polling)     |
| Speech-to-text     | Whisper (OpenAI / Groq, configurable)     |
| Understanding      | LLM, provider-agnostic via env            |
| Storage            | SQLite (better-sqlite3)                    |

## Getting started

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Install and configure:

```bash
npm install
cp .env.example .env   # paste your bot token + AI keys
npm run dev
```

3. Open Telegram, find your bot, and send it a voice note. That's it — no public URL or webhook needed (it uses long polling).

## Environment

See [`.env.example`](./.env.example) for all required variables.

## Status

Early scaffold — polling loop, transcription, extraction, and storage are wired together.
See the modules in [`src/`](./src).

## License

MIT
