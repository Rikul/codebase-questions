# Codebase Questions

Point the app at any Git repository. It clones the repo, maps it with static analysis plus an LLM, and builds a searchable knowledge base. You can then explore that knowledge base and ask it questions in four areas:

## Quick start (Docker)

```bash
cp .env.example .env        # add ANTHROPIC_API_KEY or OPENAI_API_KEY
docker compose up -d --build
docker compose logs app | grep "Access code"
```

Open <http://localhost:3000> and enter the 16-character code.

### Explain any file, symbol or selection

The **Files** tab (and every code popup opened from a citation) has an explanation panel that answers five questions about whatever you point at:

1. **What is it?**
2. **How does it fit in** with the rest of the project?
3. **When is it used?** For example at startup, on which HTTP routes, from jobs, or only in tests. It traces import chains from entry points.
4. **What does it contain?** Its functions, classes and variables. Click one to explain it.
5. **Who calls it, and what does it call?** Callers and callees are resolved through a cross-reference index and link to the exact lines.

Click any underlined name in the code to explain that symbol. Select a few lines and choose **Explain selection** to explain just that code. Explanations are cached per file version and included in exports.

### History: when was this created or changed?

The app keeps a bounded git history (`HISTORY_DEPTH`, 1000 commits by default) and can answer history questions for any file, function, class, variable or selection:

- **Files** show "Created 2023-12-21 by … · last changed … · N commits" in the header. The explanation panel has a timeline (follows renames, with +/− counts and authors).
- **Functions and classes** are tracked through their current line range with `git log -L`, so you see the commit that **introduced** them and every later change with a diff excerpt. **Variables** are found with git's pickaxe (`-S`), which gives the commit where the name first appeared. **Selections** use blame plus line history.
- **Blame** puts a gutter next to the code (author initials and age, tinted by recency). Click it to open the commit.
- **Commit viewer** shows the message, changed files and a colored diff, with **Explain this change**.
- **The model uses history tools too:** `file_history`, `symbol_history`, `blame`, `commit_details` and `search_history`. It explains *why* something changed by reading the key commits. Ask "when was login added?" or "who changed the auth flow?"; offline, these are answered straight from git.
- Onboarding gets a **Project history & hotspots** section (most-changed files, top contributors, recent changes), and component panels show recently changed files and hotspots.

If history is truncated (shallow clone), creation dates are shown as "on or before". Exports include file timelines; symbol history, blame and diffs need re-analysis after import, because `.git` isn't exported. The kept `.git` has its credentials and reflogs removed, and only read-only git commands are run on it.

### Better diagrams from LLM understanding

- **Architecture with code evidence.** The model builds the component diagram from the static-analysis facts, cites code for each connection, and records the protocol, sync vs async, and the data exchanged. Connections backed by cited code are solid; the rest are dotted and marked "?".
- **Layers and groups.** Components are ordered left to right by layer (entry → interface → core → data → infra → external). Multi-package repos are drawn with service or package containers.
- **Ask the diagram.** Ask "what happens on login?" and the matching path through the diagram is highlighted. **Walk me through it** then plays a step-by-step tour that pans to each component and connection with a caption and a code link.

### The model investigates instead of guessing

The explainer, diagram answers and the **Ask** tab all run as a tool-use agent. Its tools are read-only and confined to the repository:
- `read_file`, `list_dir`, `search_code`, `grep`
- `file_info`, `list_symbols`, `find_definition`
- `find_references`, `symbol_calls`, `importer_chain`
- `get_architecture`, `get_insights`

A live trace shows each step, for example "Reading src/app.ts:1-120" and "Finding references to getUser". Structured results are validated against a schema; an invalid submission goes back to the model to fix. Without an API key, the same tools are called by a scripted static investigation, so all of these features still work offline.

The **Ask** tab answers free-form questions. It detects the category automatically (or you pick one), streams the answer, and cites code as clickable `path:line` links. You can scope a question to one component, connection or file.

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
| `MAX_REPO_MB` / `MAX_REPO_FILES` / `MAX_FILE_BYTES` | 500 / 20000 / 400000 | Ingestion limits (working tree) |
| `HISTORY_DEPTH` / `HISTORY_INDEX_COMMITS` / `MAX_HISTORY_MB` | 1000 / 5000 / 500 | Git history kept, commits indexed for timelines, and the size limit for the kept `.git`. Over the limit, history is dropped with a warning. Truncated history is labeled in the UI. |
| `COOKIE_SECURE`, `TRUST_PROXY` | false | Set both when serving behind an HTTPS reverse proxy. |

## License

Apache License 2.0. See [LICENSE](LICENSE).

## How it works

```
clone (https only, bounded history) → scan (.gitignore, skip binaries/vendored)
  → parse (imports, symbols, routes, env vars, security + infra signals, manifests)
  → import graph → module grouping → chunk + FTS5 index (+ embeddings)
  → git history index (commits, per-file changes, renames)
  → LLM: per-file summaries (batched, cached by content hash)
  → LLM: per-category insights + suggested questions (results open here)
  → LLM, in the background: architecture synthesis (components + connections with code evidence)
  → SQLite knowledge base (+ symbol ranges and a cross-reference index for the agent's tools)
```

- `server/` contains the Express 5 API, the ingestion pipeline (`src/ingest`), the analysis steps (`src/analyze`), retrieval and answering (`src/qa`), auth, and export/import. It uses SQLite via better-sqlite3 in a single file under `DATA_DIR`.
- `server/src/agent/` holds the inspection tools (`tools.ts`), the file/symbol explainer (`explain.ts`) and "ask the diagram" (`diagram.ts`). `server/src/ingest/refs.ts` builds the cross-reference index (call sites, enclosing symbol, resolved target).
- `server/src/llm/` holds the provider interface plus Anthropic (structured output via forced tool use), OpenAI (JSON-schema output) and an offline mock. Each provider also has a `runAgent` tool-use loop (`server/src/llm/agent.ts` handles budgets and submission validation). Every LLM step has a static-analysis fallback, so one failed call never fails the whole analysis.
- `web/` is a React + Vite app: React Flow and ELK for the diagram, Shiki for code highlighting, and react-markdown for insights and answers.
- `shared/` holds the types and zod schemas used by both sides, including the export format.

### Safety

The app never executes code from analyzed repositories: it does not install dependencies or run scripts or hooks. Clones run `git` directly with a fixed argument list and no shell, accept only `https://` URLs, and do not follow symlinks. The `.git` directory is deleted after cloning. File reads are confined to the checkout.

### Analysis logs

Analysis writes timestamped JSON logs to stdout/stderr. In Docker, use
`docker compose logs -f app`; with `npm run dev` or `npm start`, watch the terminal.
Filter by `jobId` or `repoId` to follow an analysis. Stage transitions include elapsed
milliseconds; model calls report their operation (such as `insights_security`),
request ID, provider, configured main model, fast-model selection, duration, and
success or fallback. Application-level retries report attempt counts and delays;
SDK-internal retries are not individually logged. Validation failures report every
rejected field path, issue code, and expected type or allowed enum values. Prompts,
model responses, source contents, credential objects, and SDK error bodies are
excluded. Existing historical warnings are not retroactively written to logs.
