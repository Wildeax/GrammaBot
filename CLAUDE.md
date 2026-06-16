# Project guidance

## Hard rules

- **No external-AI-tooling branding anywhere.** Do not add any "Claude", "Claude Code", "Generated with", "Co-Authored-By: Claude", or similar attribution to commits, PR descriptions, code comments, docs, or any file in this repo. Keep all authorship clean and unbranded.

## What this is

GrammaBot — an AI assistant that lets a non-technical person keep accounting/bookkeeping
records by sending **Telegram voice notes**. The bot transcribes the audio, extracts a
structured ledger entry with an LLM, stores it, and replies with a confirmation.

The guiding principle: **the hard technical work is handled by the AI; the user just says
what to note.** Keep UX assumptions accordingly — favor natural language, forgiving parsing,
clear confirmations, and minimal setup.

## Stack

- Node.js 20 + TypeScript
- Telegram Bot API (free) via long polling — no webhook/public URL needed.
- Whisper for speech-to-text (provider configurable)
- LLM extraction, provider-agnostic via env vars
- SQLite (better-sqlite3) for storage

## Conventions

- Keep secrets in `.env` (never commit). `.env.example` documents required vars.
- Default language for transcription/extraction prompts is Spanish, but keep it configurable.
