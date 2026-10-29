# Codebase Questions

Point the app at any Git repository. It clones the repo, maps it with static analysis plus an LLM, and builds a searchable knowledge base. You can then explore that knowledge base and ask it questions in four areas:

| Area | What you get |
|---|---|
| **Architecture & system design** | An interactive component diagram. Click a component to see its responsibilities, files and connections. Click an arrow to see how two components interact, with the code that proves it. Double-click a component for its file-level import graph. |
| **Code onboarding** | Setup commands, entry points, a suggested reading order, core concepts, conventions and tests. |
| **Security** | Attack surface (routes and entry points), authentication, injection sinks, secrets and dependency risk. Findings are ranked by severity and link to code. |
| **API & library integration** | The public API surface, an HTTP endpoint table, and how each major third-party library is used at runtime. |

The **Ask** tab answers free-form questions. It detects the category automatically (or you pick one), streams the answer, and cites code as clickable `path:line` links. You can scope a question to one component, connection or file.

## Quick start (Docker)

```bash
cp .env.example .env        # add ANTHROPIC_API_KEY or OPENAI_API_KEY
docker compose up -d --build
docker compose logs app | grep "Access code"
```

Open <http://localhost:3000> and enter the 16-character code.

### Access codes

- On every start, the server prints a **one-time code** like `7GPV-B2AF-ZK5R-PWGG`. It is 16 characters from an unambiguous alphabet (no `0/O/1/I/L`), about 80 bits.
- Redeeming the code creates an httpOnly, `SameSite=Strict` session cookie (30 days by default). After that the code cannot be used again.
- Only a SHA-256 hash of each code is stored. Five wrong attempts from one IP lock that IP out for 15 minutes.
- To sign in on another device, use **Add device** in the top bar to mint a new code. If you are locked out, run:

  ```bash
  docker compose exec app node server/dist/cli/new-code.js
  ```

  Locally, run `npm run new-code` instead.

Minting a code invalidates any unused one. Existing sessions stay valid.

## Export / import

On a repository page, **Export ▾** downloads `<repo>-<date>.codebase.json`. The file is versioned (`codebase-questions/v1`) and contains the architecture, insights, file summaries, the import graph, suggested questions and chat history. The *With source code* option also includes the indexed code chunks, so the code viewer and search keep working after import.

**Import JSON** on the home page loads such a file into any instance. Re-analyze clones the repository again and rebuilds the knowledge base.

## Local development

Requires Node 20+ and git.

```bash
npm install
npm run dev        # API on :3000, web on :5173 (proxied)
npm test           # server unit + pipeline + auth + provider tests
npm run typecheck
npm run build && npm start
```

## Configuration

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | The provider is picked from whichever key is present. With neither key, the app runs in **offline mode**: static analysis only, and answers are assembled from search results. |
| `LLM_PROVIDER` | auto | `anthropic`, `openai` or `mock` |
| `LLM_MODEL` / `LLM_FAST_MODEL` | `claude-sonnet-5-5` / same | The fast model handles bulk per-file summaries. |
| `OPENAI_BASE_URL` | — | Any OpenAI-compatible server. If `json_schema` output is unsupported, it falls back to JSON mode. |
| `EMBEDDING_PROVIDER` | `openai` if an OpenAI key is set | Adds vector search on top of keyword (FTS5/BM25) search. |
| `GITHUB_TOKEN` | — | Read access for private GitHub repos. It is never written to disk or logs. |
| `MAX_LLM_FILES` | 150 | How many of the most central files get an LLM summary. The rest get static summaries. |
| `MAX_REPO_MB` / `MAX_REPO_FILES` / `MAX_FILE_BYTES` | 500 / 20000 / 400000 | Ingestion limits |
| `COOKIE_SECURE`, `TRUST_PROXY` | false | Set both when serving behind an HTTPS reverse proxy. |

## How it works

```
clone (shallow, https only) → scan (.gitignore, skip binaries/vendored)
  → parse (imports, symbols, routes, env vars, security + infra signals, manifests)
  → import graph → module grouping → chunk + FTS5 index (+ embeddings)
  → LLM: per-file summaries (batched, cached by content hash)
  → LLM: architecture synthesis (components + connections with code evidence)
  → LLM: per-category insights + suggested questions
  → SQLite knowledge base
```

- `server/` contains the Express 5 API, the ingestion pipeline (`src/ingest`), the analysis steps (`src/analyze`), retrieval and answering (`src/qa`), auth, and export/import. It uses SQLite via better-sqlite3 in a single file under `DATA_DIR`.
- `server/src/llm/` holds the provider interface plus Anthropic (structured output via forced tool use), OpenAI (JSON-schema output) and an offline mock. Every LLM step has a static-analysis fallback, so one failed call never fails the whole analysis.
- `web/` is a React + Vite app: React Flow and ELK for the diagram, Shiki for code highlighting, and react-markdown for insights and answers.
- `shared/` holds the types and zod schemas used by both sides, including the export format.

### Safety

The app never executes code from analyzed repositories: it does not install dependencies or run scripts or hooks. Clones run `git` directly with a fixed argument list and no shell, accept only `https://` URLs, and do not follow symlinks. The `.git` directory is deleted after cloning. File reads are confined to the checkout.
