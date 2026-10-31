# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web app that clones a Git repo, analyzes it (static analysis + LLM), stores a knowledge base in SQLite, and lets users explore architecture, insights, file/symbol explanations, git history, and ask questions. npm workspaces: `server/` (Express 5 API + pipeline), `web/` (React + Vite), `shared/` (types + zod schemas, imported as `@cq/shared` via path aliases in both tsconfigs and the vite/vitest configs; it is not a separate package).

## Commands

Node 20+ and git required. Run from repo root:

```bash
npm install
npm run dev          # server (tsx watch) on :3000 + vite on :5173, /api proxied to :3000
npm test             # vitest run in server/ (only server has tests)
npm run typecheck    # tsc for server and web
npm run build && npm start   # esbuild-bundled server serves web/dist
npm run new-code     # mint a new login access code
```

Single test file / single test:

```bash
npm test -w server -- test/pipeline.test.ts
npm test -w server -- test/pipeline.test.ts -t "stores files"
```

Docker: `docker compose up -d --build`, then `docker compose logs app | grep "Access code"`.

Config is all env vars (see `.env.example`, parsed in `server/src/config.ts`). Data lives under `DATA_DIR` (default `./data`): `codebase.db` and `repos/<id>` checkouts. `AUTH_DISABLED=true` skips the access-code login.

## Architecture

**Ingestion pipeline** (`server/src/ingest/pipeline.ts`): a single in-process sequential job queue; progress is broadcast via the `jobEvents` EventEmitter (streamed to the UI). Order: clone (`clone.ts`) → scan → parse (imports, symbols, routes, env vars, manifests) → import graph + module grouping + centrality (`graph.ts`) → chunk + FTS5 index (+ optional embeddings) → git history index (`server/src/history/`) → cross-reference index (`refs.ts`) → LLM steps in `server/src/analyze/` (per-file summaries, insights, then architecture synthesis and the full codebase review (`agent/review.ts`) in the background, while the repo status is `enriching`). `analyzeDirectory()` runs the pipeline on a local directory and is what tests use.

**LLM layer** (`server/src/llm/`): `LLMProvider` interface (`provider.ts`) with Anthropic (structured output via forced tool use), OpenAI (JSON-schema, falls back to JSON mode), and `MockProvider` (offline). Provider is chosen by `LLM_PROVIDER` or whichever API key is present; with no key, the app runs fully offline on the mock. Every LLM step must have a static fallback:
- `jsonWithFallback(llm, opts)` — structured call; on failure parses `opts.heuristic()` with the same zod schema.
- `agentWithFallback(llm, opts)` — tool-use agent run (`llm/agent.ts` handles budgets and validates the final submission against a schema, sending invalid ones back to the model); on failure replays `opts.scripted` via `MockProvider`.
When adding an LLM feature, provide the heuristic/scripted path so offline mode and failure cases keep working.

**Agent tools** (`server/src/agent/tools.ts`, `RepoIndex`): read-only tools confined to the checkout (read_file, grep, find_definition, find_references, importer_chain, history tools, etc.). Used by the explainer (`explain.ts`), code review (`review.ts`: full codebase and per-file, stored in `reviews`), ask-the-diagram (`diagram.ts`), and Q&A (`qa/answer.ts`, retrieval in `qa/retrieve.ts`).

**DB** (`server/src/db/index.ts`): better-sqlite3, schema is `CREATE TABLE IF NOT EXISTS` plus an additive `migrate()` that adds missing columns. New columns on existing tables must be added there too. Flexible architecture fields go in the JSON `extra` column on `components`/`connections`.

**Routes**: `server/src/routes/api.ts` (all under `/api`, behind cookie-session auth from `auth.ts`); read queries shared with export live in `routes/queries.ts`. `createApp()` in `server/src/index.ts` is exported for supertest tests.

**Export/import** (`server/src/export/export.ts`): versioned format `codebase-questions/v1`, schema in `shared/`. Changing stored data usually means updating the export schema and import too.

## Safety constraints (keep these)

- Never execute code from analyzed repos (no installs, scripts, or hooks). `git` is run with fixed arg lists, no shell, `https://` URLs only, no symlink following; file reads stay inside the checkout.
- The kept `.git` is scrubbed of credentials/reflogs (`prepareCheckout` in `clone.ts`) and only read-only git commands run on it; it is deleted if `HISTORY_DEPTH < 0` or over `MAX_HISTORY_MB`. `GITHUB_TOKEN` must never reach disk or logs.

## Tests

`server/test/` uses vitest with `openDb(':memory:')` and `MockProvider` against `test/fixtures/sample-app` (a small multi-language fixture, excluded from test discovery). `test/fakeApi.ts` is a local Express stand-in for the Anthropic/OpenAI APIs that replays scripted text/tool-call blocks and records request bodies, used to test real providers and the agent loop without network access.
