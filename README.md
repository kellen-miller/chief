# Chief

Chief is a private Discord chief of staff for one presidential-themed friends server. He is a concise, polished American assistant with dry wit, calls each member “Mr. President,” can research current information, remembers useful communal context, and supports live voice conversation.

Chief replies in the configured text channel only when directly mentioned or invoked through `/roll`, `/join`, `/leave`, or `/help`. Unmentioned messages in that channel are observed silently for bounded context and automatic memory extraction. In voice, one human can speak naturally; with multiple humans, a completed utterance must address Chief by name.

## Architecture

- Node.js 24, TypeScript, discord.js, and `@discordjs/voice`
- OpenAI Agents SDK for text/web work and server-side Realtime WebSocket voice
- SQLite in WAL mode with a seven-day cross-text/voice conversation timeline,
  plus FTS5 and sqlite-vec for durable communal memory and provenance-backed
  hourly, daily, weekly, and long-term historical context
- One serialized paid-generation queue and a persistent UTC-month usage ledger
- One GCP `e2-micro` VM with a durable standard disk, Artifact Registry, Secret Manager, GCS backups, and GitHub WIF deployment
- Host-side TypeScript operations and Discord monitoring: daily reports at 09:00 Eastern and deduplicated
  operational alerts, including when the bot process is unavailable

Text, web research, memory extraction, and context summaries use `gpt-6-luna`.
Voice uses `gpt-realtime-2.1-mini`; transcription and embeddings keep their
dedicated models. Model aliases and matching prices remain configurable.

SQLite is deliberate: Chief is a single process with a small private-server dataset. It avoids a second always-on database while still providing relational provenance, full-text search, vector ranking, online backup, and crash-safe jobs.

## Local development

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm generate:sql # requires sqlc 1.31.1
pnpm verify
pnpm chief -- smoke
```

The tests use fake provider and deployment boundaries and never make paid OpenAI calls. To run the real bot, export the `.env` values and use `pnpm chief -- run`. Register guild commands once with `pnpm chief -- register-commands`.

The optional `pnpm eval:conversation` command uses the configured OpenAI key and
is paid. It checks both text conversation quality and memory acceptance/rejection
on their configured models. It reports only aggregate case names, pass/fail,
model, reasoning, latency, and token counts; it is never part of pull-request CI.
Before production activation, an owner can explicitly grade the full pinned
corpus with `pnpm eval:conversation -- --grade-pinned-corpus`. That mode makes
additional paid answer and evaluator calls, records the text/evaluator models
and timestamp, and reports rollup faithfulness, supported-claim precision,
cross-tier retrieval relevance, per-class and macro classification accuracy,
requested-link recall, suppressed-source leakage, and returned provenance-ID
validity. The paid input is assembled through the same deterministic SQLite
retrieval replay used in CI. `CHIEF_MODEL_EVALUATOR` selects a dedicated
structured grader model and defaults to `CHIEF_MODEL_TEXT`.

## Cost controls

The default warning is USD 5 and the default hard application ceiling is USD
10 per UTC calendar month. Context indexing has a USD 3 monthly sub-ceiling and
always leaves conservative headroom for an interaction. Text, search, Realtime,
transcription, embeddings, memory extraction, and the one-time persisted
voice-suffix clip all reserve budget before starting and reconcile returned
usage. Model aliases and unit prices are environment-configurable.

`CHIEF_CONTEXT_TIME_ZONE` defaults to `America/New_York` and controls calendar
rollups and human-readable time labels. `CHIEF_USAGE_INDEXING_CEILING_USD`
defaults to `3`, must be positive, and cannot exceed
`CHIEF_USAGE_CEILING_USD`. Retention periods, tier token limits, and retrieval
allocations are fixed product policy rather than deployment knobs.

Historical context reports what the group discussed; it is not accepted truth.
Raw eligible text and hourly context are retained for 30 days, daily context for
one year, and weekly/long-term context indefinitely until an authorized forget.
When raw evidence has expired, Chief labels the result summary-only and cannot
use it for quotations or precise source claims.

See [Discord setup](docs/discord-setup.md), [GCP bootstrap](docs/gcp-bootstrap.md), [operations](docs/operations.md), and [manual acceptance](docs/manual-acceptance.md).

## Languages and generated SQL

Application code, monitoring, and host operations use TypeScript. Host operations
run separately from the bot with a pinned Node.js 24 runtime and no npm packages;
monitoring remains available while the bot is stopped. Bash only provisions the
initial host/apt/Node environment or forwards existing script entrypoints to
`src/ops/cli.ts`. Terraform owns GCP resources and systemd bootstrap.

Ordinary database statements live in `sql/queries.sql`. `pnpm generate:sql`
reads `migrations/` directly with sqlc 1.31.1 and emits
synchronous `better-sqlite3` statements and binding/row types into
`src/database/queries.ts`. Generation uses our
[sqlc TypeScript plugin fork](https://github.com/kellen-miller/sqlc-gen-typescript),
pinned to a WASM release and SHA256 in `sqlc.yaml`. The fork supports synchronous
prepared statements, named/positional bindings, SQLite types, alias casing, and
scalar `pluck()` types. CI checks regeneration for drift.

Versioned `migrations/*.sql` files own the schema. Knex runs them on Chief's
existing `better-sqlite3` connection, preserving sqlite-vec and connection
settings. Knex's migration source discovers SQL files in filename order, with no
handwritten catalog. Matching modules in `src/database/migrations/` apply
historical data repairs after their SQL; `src/database/migration-data.ts` owns
the repair logic. Old checksum values live in migration headers for backup
compatibility. New SQL files use content checksums and need no registration.
Knex and sqlc consume the same migration files; no separate schema snapshot is
maintained. Knex owns ordering, transactions, locking, and its
`knex_migrations` ledger. Startup awaits migrations before serving work.
Existing `schema_migrations` IDs and checksums are retained for backup validation;
Knex adopts applied migrations without replaying them. Downgrades restore a
matching backup. Run migrations with
`pnpm chief -- migrate --database /path/to/chief.db`.

Transactions, domain validation/mapping, migration checksums, FTS5/sqlite-vec,
dynamic SQL, and queries using SQLite syntax unsupported by sqlc remain in their
owning TypeScript modules. sqlc does not execute migrations or replace recovery
verification. SQLite alias casing and scalar `pluck()` results are preserved.
`sqlc.yaml` records narrow parameter type overrides for nullable comparisons and
CASE parameters that sqlc infers incorrectly; they do not alter executable SQL.
