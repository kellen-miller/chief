# Chief

Chief is a private Discord chief of staff for one presidential-themed friends server. He is a concise, polished American assistant with dry wit, calls each member “Mr. President,” can research current information, remembers useful communal context, and supports live voice conversation.

Chief replies in the configured text channel only when directly mentioned or invoked through `/roll`, `/join`, `/leave`, or `/help`. Unmentioned messages in that channel are observed silently for bounded context and automatic memory extraction. In voice, one human can speak naturally; with multiple humans, a completed utterance must address Chief by name.

## Architecture

- Node.js 24, TypeScript, discord.js, and `@discordjs/voice`
- OpenAI Agents SDK for text/web work and server-side Realtime WebSocket voice
- SQLite in WAL mode with a seven-day cross-text/voice conversation timeline,
  plus FTS5 and sqlite-vec for durable communal memory
- One serialized paid-generation queue and a persistent UTC-month usage ledger
- One GCP `e2-micro` VM with a durable standard disk, Artifact Registry, Secret Manager, GCS backups, and GitHub WIF deployment

SQLite is deliberate: Chief is a single process with a small private-server dataset. It avoids a second always-on database while still providing relational provenance, full-text search, vector ranking, online backup, and crash-safe jobs.

## Local development

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm verify
pnpm chief -- smoke
```

The tests use fake provider and deployment boundaries and never make paid OpenAI calls. To run the real bot, export the `.env` values and use `pnpm chief -- run`. Register guild commands once with `pnpm chief -- register-commands`.

The optional `pnpm eval:conversation` command uses the configured OpenAI key and
is paid. It checks both text conversation quality and memory acceptance/rejection
on their configured models. It reports only aggregate case names, pass/fail,
model, reasoning, latency, and token counts; it is never part of pull-request CI.

## Cost controls

The default warning is USD 5 and the default hard application ceiling is USD 10 per UTC calendar month. Text, search, Realtime, transcription, embeddings, memory extraction, and the one-time persisted voice-suffix clip all reserve budget before starting and reconcile returned usage. Model aliases and unit prices are environment-configurable.

See [Discord setup](docs/discord-setup.md), [GCP bootstrap](docs/gcp-bootstrap.md), [operations](docs/operations.md), and [manual acceptance](docs/manual-acceptance.md).
