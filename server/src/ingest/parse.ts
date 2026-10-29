/**
 * Lightweight, regex-based static extraction. It is deliberately language-tolerant
 * rather than precise: results seed the LLM prompts and power the offline heuristics.
 */
export interface ImportRef { spec: string; line: number }
export interface SymbolRef {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  /** Last line of the definition body (inclusive). */
  endLine?: number;
  /** Enclosing class/module name for methods. */
  parent?: string;
  /** Trimmed definition line. */
  signature?: string;
}
export interface RouteRef { method: string; path: string; line: number }
export interface SignalRef { kind: string; detail: string; line: number }

export interface FileFacts {
  imports: ImportRef[];
  symbols: SymbolRef[];
  routes: RouteRef[];
  envVars: SignalRef[];
  /** Security-relevant patterns (sinks, crypto, secrets, auth). */
  security: SignalRef[];
  /** Infrastructure touch points: db, cache, queue, http clients, etc. */
  infra: SignalRef[];
  isEntry: boolean;
  isTest: boolean;
}

export interface Dependency { name: string; version: string; ecosystem: string; manifest: string; dev: boolean }

const JS_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'vue', 'svelte', 'astro']);

let lastText = '';
let lastStarts: number[] = [];

function lineOf(text: string, index: number): number {
  if (text !== lastText) {
    lastText = text;
    lastStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lastStarts.push(i + 1);
  }
  let lo = 0;
  let hi = lastStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lastStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function allMatches(text: string, re: RegExp, fn: (m: RegExpExecArray, line: number) => void) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    fn(m, lineOf(text, m.index));
    if (m.index === g.lastIndex) g.lastIndex++;
  }
}

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^[ \t]*import\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/m,
    /^[ \t]*export\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+['"]([^'"]+)['"]/m,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
  ],
  python: [/^[ \t]*from\s+([.\w]+)\s+import\b/m, /^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/m],
  go: [/^[ \t]*import\s+"([^"]+)"/m, /^[ \t]+(?:\w+\s+)?"([^"]+)"\s*$/m],
  rust: [/^[ \t]*(?:pub\s+)?use\s+([\w:]+)/m, /^[ \t]*(?:pub\s+)?mod\s+(\w+)\s*;/m, /^[ \t]*extern\s+crate\s+(\w+)/m],
  java: [/^[ \t]*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/m],
  kotlin: [/^[ \t]*import\s+([\w.]+)/m],
  csharp: [/^[ \t]*using\s+([\w.]+)\s*;/m],
  ruby: [/^[ \t]*require(?:_relative)?\s+['"]([^'"]+)['"]/m],
  php: [/^[ \t]*use\s+([\w\\]+)/m, /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/],
  c: [/^[ \t]*#\s*include\s+"([^"]+)"/m],
};

function langFamily(lang: string | null): string | null {
  if (!lang) return null;
  if (JS_LANGS.has(lang)) return 'js';
  if (lang === 'cpp' || lang === 'objective-c') return 'c';
  return IMPORT_PATTERNS[lang] ? lang : null;
}

const SYMBOL_PATTERNS: Record<string, { re: RegExp; kind: string }[]> = {
  js: [
    { re: /^[ \t]*(export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/m, kind: 'function' },
    { re: /^[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/m, kind: 'class' },
    { re: /^[ \t]*(export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/m, kind: 'type' },
    { re: /^[ \t]*(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/m, kind: 'function' },
    { re: /^[ \t]*(export\s+)?enum\s+([A-Za-z_$][\w$]*)/m, kind: 'enum' },
    { re: /^(export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=/m, kind: 'variable' },
    { re: /^[ \t]+()(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^)\n]*\)\s*(?::\s*[^{\n]+)?\{\s*$/m, kind: 'method' },
  ],
  python: [
    { re: /^()(?:async\s+)?def\s+([A-Za-z_]\w*)/m, kind: 'function' },
    { re: /^[ \t]+()(?:async\s+)?def\s+([A-Za-z_]\w*)/m, kind: 'method' },
    { re: /^()([A-Z][A-Z0-9_]{2,})\s*(?::[^=\n]+)?=/m, kind: 'constant' },
    { re: /^()([a-z_][a-z0-9_]*)\s*(?::[^=\n]+)?=(?!=)/m, kind: 'variable' },
    { re: /^()class\s+([A-Za-z_]\w*)/m, kind: 'class' },
  ],
  go: [
    { re: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/m, kind: 'function' },
    { re: /^()type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/m, kind: 'type' },
  ],
  rust: [
    { re: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/m, kind: 'function' },
    { re: /^[ \t]*(pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/m, kind: 'type' },
  ],
  java: [
    { re: /^[ \t]*(public\s+)?(?:abstract\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/m, kind: 'class' },
    { re: /^[ \t]+(public\s+)?(?:static\s+|final\s+|synchronized\s+)*[\w<>[\],\s]+\s+([a-z]\w*)\s*\([^)]*\)\s*(?:throws [\w.,\s]+)?\{/m, kind: 'method' },
  ],
  kotlin: [
    { re: /^[ \t]*()(?:data\s+|sealed\s+|open\s+)?class\s+([A-Za-z_]\w*)/m, kind: 'class' },
    { re: /^[ \t]*()(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/m, kind: 'function' },
  ],
  csharp: [{ re: /^[ \t]*(public\s+)?(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|record|struct)\s+([A-Za-z_]\w*)/m, kind: 'class' }],
  ruby: [
    { re: /^[ \t]*()class\s+([A-Z]\w*(?:::\w+)*)/m, kind: 'class' },
    { re: /^[ \t]*()module\s+([A-Z]\w*)/m, kind: 'module' },
    { re: /^[ \t]*()def\s+(?:self\.)?([a-z_]\w*[?!]?)/m, kind: 'method' },
  ],
  php: [
    { re: /^[ \t]*()(?:final\s+|abstract\s+)?class\s+([A-Za-z_]\w*)/m, kind: 'class' },
    { re: /^[ \t]*(public\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)/m, kind: 'function' },
  ],
};

const ROUTE_PATTERNS: RegExp[] = [
  // express / koa / fastify / hono style: app.get('/x', ...), router.post("/y")
  /(?:\b[\w$]*(?:app|router|server|api|routes?|fastify)|\b(?:r|e|g|mux))\.(get|post|put|patch|delete|options|head|all|use)\(\s*['"`]([^'"`]+)['"`]/i,
  // Flask / FastAPI: @app.get("/x"), @router.post("/x"), @app.route("/x", methods=[...])
  /@\w+\.(get|post|put|patch|delete|route|api_route|websocket)\(\s*['"]([^'"]+)['"]/i,
  // Spring: @GetMapping("/x")
  /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]+)"/,
  // Go net/http, gin, echo, chi: HandleFunc("/x", ...), r.GET("/x")
  /\b(?:HandleFunc|Handle)\(\s*"([^"]+)"/,
  /\.\s*(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/,
  // Django urls: path('x/', view)
  /\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,/,
  // Rails: get '/x', to: ...
  /^[ \t]*(get|post|put|patch|delete|resources|resource)\s+[:'"]([\w/:.-]+)/m,
  // Next.js / Remix handlers: export async function GET(
  /^[ \t]*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(()/m,
];

const ENV_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/,
  /os\.(?:environ\.get|getenv|environ\[)\(?\s*['"]([A-Z][A-Z0-9_]+)['"]/,
  /os\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"/,
  /env::var\(\s*"([A-Z][A-Z0-9_]+)"/,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]+)"/,
  /ENV\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/,
];

const SECURITY_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'code-exec', re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn\w+Context\b|\bexec\s*\(\s*compile\b/ },
  { kind: 'command-exec', re: /\bchild_process\b|\b(?:execSync|spawnSync|execFile)\s*\(|\bsubprocess\.(?:run|call|Popen|check_output)\b|\bos\.system\s*\(|\bexec\.Command\s*\(|Runtime\.getRuntime\(\)\.exec|\bshell_exec\s*\(|`[^`]*\$\{[^}]+\}[^`]*`\s*\)\s*;?\s*\/\/\s*shell/ },
  { kind: 'shell-true', re: /shell\s*=\s*True|shell:\s*true/ },
  { kind: 'sql-concat', re: /"[^"]*\b(?:SELECT\b[^"]*\bFROM|INSERT\s+INTO|UPDATE\b[^"]*\bSET|DELETE\s+FROM)\b[^"]*"\s*\+|'[^']*\b(?:SELECT\b[^']*\bFROM|INSERT\s+INTO|UPDATE\b[^']*\bSET|DELETE\s+FROM)\b[^']*'\s*\+|f["'](?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|\.(?:query|execute|raw|exec)\(\s*`[^`]*\$\{|(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'%]*["']\s*%\s*\(?\w/i },
  { kind: 'xss-sink', re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\bv-html\b|\|\s*safe\b|mark_safe\(|\bhtml_safe\b|document\.write\(/ },
  { kind: 'deserialization', re: /\bpickle\.loads?\(|\byaml\.load\((?![^)]*SafeLoader)|\bunserialize\(|ObjectInputStream|\bMarshal\.load\b|node-serialize/ },
  { kind: 'weak-crypto', re: /\b(?:md5|sha1)\b\s*\(|createHash\(\s*['"](?:md5|sha1)['"]|\bDES\b|\bRC4\b|Math\.random\(\)/i },
  { kind: 'hardcoded-secret', re: /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{12,}['"]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}/i },
  { kind: 'tls-disabled', re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED/ },
  { kind: 'cors-wildcard', re: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*['"]|cors\(\s*\)/ },
  { kind: 'auth', re: /\b(?:jwt|jsonwebtoken|passport|bcrypt|argon2|oauth|session|csrf|authenticate|authorize|login|isAuthenticated|requireAuth|@login_required|@PreAuthorize|\[Authorize\])/i },
  { kind: 'path-traversal', re: /(?:readFile|createReadStream|sendFile|open)\s*\([^)]*(?:req\.|request\.|params|query)/ },
  { kind: 'ssrf', re: /(?:fetch|axios(?:\.\w+)?|requests\.(?:get|post)|http\.Get|urlopen)\s*\(\s*(?:req\.|request\.|params|query|url\b)/ },
  { kind: 'redirect', re: /res\.redirect\(\s*req\.|redirect\(\s*request\.(?:args|GET)/ },
];

const INFRA_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'db:postgres', re: /\bpg\b['"]|from ['"]pg['"]|psycopg|postgres(?:ql)?:\/\/|lib\/pq|jackc\/pgx|sqlx::Pg/ },
  { kind: 'db:mysql', re: /\bmysql2?\b['"]|pymysql|go-sql-driver\/mysql|mysql:\/\// },
  { kind: 'db:sqlite', re: /better-sqlite3|sqlite3|go-sqlite3|rusqlite/ },
  { kind: 'db:mongo', re: /mongoose|mongodb(?:\+srv)?:\/\/|pymongo|MongoClient/ },
  { kind: 'db:orm', re: /@prisma\/client|PrismaClient|typeorm|sequelize|drizzle-orm|knex|sqlalchemy|django\.db|gorm\.io|diesel::|ActiveRecord|@Entity\b|EntityFramework|DbContext/ },
  { kind: 'cache:redis', re: /\bioredis\b|['"]redis['"]|redis:\/\/|go-redis|import redis|Jedis|Lettuce/ },
  { kind: 'queue', re: /amqplib|rabbitmq|kafkajs|confluent_kafka|sarama|bullmq|\bbull\b['"]|celery|sqs|SQSClient|pubsub|nats\b|kombu|sidekiq|resque/i },
  { kind: 'http-client', re: /\baxios\b|\bfetch\(|node-fetch|got\(|\brequests\.|httpx|http\.Client|reqwest|OkHttp|RestTemplate|WebClient|HttpClient/ },
  { kind: 'grpc', re: /grpc|\.proto['"]/ },
  { kind: 'graphql', re: /apollo|graphql|gql`/ },
  { kind: 'storage', re: /S3Client|aws-sdk|boto3|@google-cloud\/storage|azure-storage|minio/ },
  { kind: 'websocket', re: /socket\.io|\bws\b['"]|WebSocket|websockets/ },
  { kind: 'llm', re: /@anthropic-ai\/sdk|anthropic|openai|langchain/ },
];

export function isTestPath(p: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e|fixtures?)(\/|$)|\.(test|spec)\.\w+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/.test(p);
}

export function isEntryPath(p: string, content: string): boolean {
  const base = p.split('/').pop()!.toLowerCase();
  if (/^(main|index|app|server|cli|manage|wsgi|asgi|program|__main__)\.(ts|tsx|js|mjs|py|go|rs|java|kt|cs|rb)$/.test(base)) {
    const depth = p.split('/').length;
    if (depth <= 3) return true;
  }
  return /if\s+__name__\s*==\s*['"]__main__['"]|^func main\(\)|^\s*fn main\(\)|public static void main\(|\.listen\(\s*\w*\s*(?:,|\))/m.test(content);
}

export function parseFile(p: string, lang: string | null, content: string): FileFacts {
  const fam = langFamily(lang);
  const facts: FileFacts = { imports: [], symbols: [], routes: [], envVars: [], security: [], infra: [], isEntry: false, isTest: isTestPath(p) };
  const text = content.length > 300_000 ? content.slice(0, 300_000) : content;

  if (fam) {
    for (const re of IMPORT_PATTERNS[fam]) {
      allMatches(text, re, (m, line) => {
        const spec = m[1];
        if (fam === 'python' && !spec.startsWith('.') && spec.includes(',')) {
          for (const s of spec.split(',')) facts.imports.push({ spec: s.trim(), line });
        } else facts.imports.push({ spec, line });
      });
    }
    if (fam === 'go') {
      // Only keep import-looking strings from import blocks.
      const block = text.match(/import\s*\(([\s\S]*?)\)/);
      facts.imports = facts.imports.filter((i) => !block || block[1].includes(`"${i.spec}"`) || /^[ \t]*import\s+"/m.test(text));
    }
    const symFam = SYMBOL_PATTERNS[fam] ? fam : lang && SYMBOL_PATTERNS[lang] ? lang : null;
    if (symFam) {
      for (const { re, kind } of SYMBOL_PATTERNS[symFam]) {
        allMatches(text, re, (m, line) => {
          const name = m[2];
          if (!name || ['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'constructor', 'function', 'else', 'do', 'try'].includes(name)) return;
          let exported = Boolean(m[1]);
          if (fam === 'go') exported = /^[A-Z]/.test(name);
          if (fam === 'python') exported = !name.startsWith('_');
          facts.symbols.push({ name, kind, line, exported });
        });
      }
      facts.symbols = computeRanges(text.split('\n'), facts.symbols, fam);
    }
  }

  const codeLike = !['markdown', 'mdx', 'text', 'rst', 'html', 'css', 'scss', 'less', 'json', 'jsonc', 'xml'].includes(lang ?? '') && lang !== null;
  if (!codeLike) {
    // Docs and data files: keep imports/symbols only (none), skip runtime signals.
    facts.isEntry = false;
    return facts;
  }
  for (const re of ROUTE_PATTERNS) {
    allMatches(text, re, (m, line) => {
      const [method, route] = m[2] !== undefined ? [m[1], m[2]] : ['ANY', m[1]];
      if (method.toLowerCase() === 'use' && !String(route).startsWith('/')) return;
      if (!route && !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) return;
      facts.routes.push({ method: method.toUpperCase(), path: route || `/${p.replace(/\/route\.\w+$/, '')}`, line });
    });
  }
  // Inline route handlers become pseudo-symbols so call sites inside them have a meaningful "caller".
  if (fam && BRACE_FAMS.has(fam)) {
    const lines = text.split('\n');
    for (const r of facts.routes) {
      const l = lines[r.line - 1] ?? '';
      if (!/=>|function\b/.test(l) || facts.symbols.some((s) => s.line === r.line)) continue;
      const end = braceEnd(lines, r.line - 1);
      facts.symbols.push({ name: `${r.method} ${r.path}`, kind: 'route', line: r.line, endLine: (end ?? r.line - 1) + 1, exported: false, signature: l.trim().slice(0, 200) });
    }
  } else if (fam === 'python') {
    // Decorated route functions: attach the route to the following def.
    for (const r of facts.routes) {
      const def = facts.symbols.find((s) => s.line > r.line && s.line <= r.line + 3 && (s.kind === 'function' || s.kind === 'method'));
      if (def) def.signature = `${r.method} ${r.path} → ${def.signature}`;
    }
  }
  for (const re of ENV_PATTERNS) allMatches(text, re, (m, line) => facts.envVars.push({ kind: 'env', detail: m[1], line }));

  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (l.length > 2000) return;
    for (const { kind, re } of SECURITY_PATTERNS) {
      if (re.test(l)) facts.security.push({ kind, detail: l.trim().slice(0, 200), line: i + 1 });
    }
    for (const { kind, re } of INFRA_PATTERNS) {
      if (re.test(l)) facts.infra.push({ kind, detail: l.trim().slice(0, 160), line: i + 1 });
    }
  });
  // Keep the signal lists bounded.
  facts.security = facts.security.slice(0, 40);
  facts.infra = dedupeBy(facts.infra, (s) => s.kind).slice(0, 20);
  facts.envVars = dedupeBy(facts.envVars, (s) => s.detail);
  facts.isEntry = isEntryPath(p, text);
  return facts;
}

function dedupeBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Manifests ----------

export function parseManifest(p: string, content: string): Dependency[] {
  const base = p.split('/').pop()!;
  const deps: Dependency[] = [];
  const push = (name: string, version: string, ecosystem: string, dev = false) =>
    name && deps.push({ name, version: version || '*', ecosystem, manifest: p, dev });
  try {
    if (base === 'package.json') {
      const j = JSON.parse(content);
      for (const [n, v] of Object.entries(j.dependencies ?? {})) push(n, String(v), 'npm');
      for (const [n, v] of Object.entries(j.peerDependencies ?? {})) push(n, String(v), 'npm');
      for (const [n, v] of Object.entries(j.devDependencies ?? {})) push(n, String(v), 'npm', true);
    } else if (/^requirements.*\.txt$/.test(base)) {
      for (const l of content.split('\n')) {
        const m = l.trim().match(/^([A-Za-z0-9_.\-[\]]+)\s*([=<>!~]=?.*)?$/);
        if (m && !l.trim().startsWith('#') && !l.trim().startsWith('-')) push(m[1], (m[2] ?? '').trim(), 'pypi', /dev|test/.test(base));
      }
    } else if (base === 'pyproject.toml') {
      const block = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (block) for (const m of block[1].matchAll(/['"]([A-Za-z0-9_.\-]+)\s*([^'"]*)['"]/g)) push(m[1], m[2].trim(), 'pypi');
      const poetry = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
      if (poetry) for (const m of poetry[1].matchAll(/^([A-Za-z0-9_.\-]+)\s*=\s*['"{]?([^'"\n}]*)/gm)) if (m[1] !== 'python') push(m[1], m[2], 'pypi');
    } else if (base === 'go.mod') {
      for (const m of content.matchAll(/^[ \t]*(?:require\s+)?([\w.\-]+\.[\w.\-/]+)\s+(v[\w.\-+]+)/gm)) push(m[1], m[2], 'go');
    } else if (base === 'Cargo.toml') {
      const sections = content.split(/^\[/m);
      for (const s of sections) {
        const header = s.split('\n')[0];
        if (!/dependencies\]/.test(header)) continue;
        for (const m of s.matchAll(/^([A-Za-z0-9_\-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")?/gm)) push(m[1], m[2] ?? m[3] ?? '', 'cargo', header.includes('dev'));
      }
    } else if (base === 'pom.xml') {
      for (const m of content.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>(?:[\s\S]*?<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/g))
        push(`${m[1]}:${m[2]}`, m[3] ?? '', 'maven');
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      for (const m of content.matchAll(/(implementation|api|compile|testImplementation)\s*\(?\s*['"]([^:'"]+:[^:'"]+):?([^'"]*)['"]/g))
        push(m[2], m[3], 'maven', m[1].startsWith('test'));
    } else if (base === 'Gemfile') {
      for (const m of content.matchAll(/^[ \t]*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) push(m[1], m[2] ?? '', 'rubygems');
    } else if (base === 'composer.json') {
      const j = JSON.parse(content);
      for (const [n, v] of Object.entries(j.require ?? {})) push(n, String(v), 'packagist');
    } else if (base.endsWith('.csproj')) {
      for (const m of content.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) push(m[1], m[2], 'nuget');
    }
  } catch {
    /* malformed manifest: ignore */
  }
  return deps;
}

export const MANIFEST_NAMES = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.csproj)$/;

// ---------- Symbol ranges ----------

const BRACE_FAMS = new Set(['js', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'c', 'scala', 'swift']);
const CONTAINER_KINDS = new Set(['class', 'type', 'module', 'enum']);

function indentOf(l: string): number {
  const m = l.match(/^[ \t]*/)![0];
  return m.replace(/\t/g, '    ').length;
}

/** Find the line where the brace block opened at/after `start` closes. Strings and comments are skipped roughly. */
function braceEnd(lines: string[], start: number): number | null {
  let depth = 0;
  let opened = false;
  let inBlock = false;
  for (let i = start; i < Math.min(lines.length, start + 5000); i++) {
    const l = lines[i];
    let quote: string | null = null;
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (inBlock) {
        if (c === '*' && l[j + 1] === '/') {
          inBlock = false;
          j++;
        }
        continue;
      }
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && l[j + 1] === '/') break;
      if (c === '/' && l[j + 1] === '*') {
        inBlock = true;
        j++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') {
        depth++;
        opened = true;
      } else if (c === '}') {
        depth--;
        if (opened && depth <= 0) return i;
      }
    }
    // Statement without a block (e.g. `const x = 1;` or an expression arrow fn).
    if (!opened && i - start >= 0 && /[;,)]\s*$/.test(l.trim()) && !/[({[]\s*$/.test(l)) return i;
    if (!opened && i - start > 6) return start;
  }
  return null;
}

export function computeRanges(lines: string[], symbols: SymbolRef[], fam: string): SymbolRef[] {
  const seen = new Set<string>();
  const syms = symbols
    .sort((a, b) => a.line - b.line)
    .filter((s) => {
      const k = `${s.name}:${s.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  for (const s of syms) {
    const i = s.line - 1;
    s.signature = (lines[i] ?? '').trim().slice(0, 200);
    let end: number | null = null;
    if (BRACE_FAMS.has(fam)) end = braceEnd(lines, i);
    else if (fam === 'python') {
      const ind = indentOf(lines[i] ?? '');
      end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        if (indentOf(l) <= ind && !/^[ \t]*[)\]}]/.test(l)) break;
        end = j;
      }
      if (s.kind === 'constant') end = i;
    } else if (fam === 'ruby') {
      const ind = indentOf(lines[i] ?? '');
      for (let j = i + 1; j < lines.length; j++) {
        if (/^[ \t]*end\b/.test(lines[j]) && indentOf(lines[j]) === ind) {
          end = j;
          break;
        }
      }
    }
    s.endLine = (end ?? i) + 1;
  }
  // Parents: innermost container whose range strictly contains the symbol.
  for (const s of syms) {
    let best: SymbolRef | undefined;
    for (const c of syms) {
      if (c === s || !CONTAINER_KINDS.has(c.kind) || !c.endLine) continue;
      if (c.line < s.line && c.endLine >= (s.endLine ?? s.line) && (!best || c.line > best.line)) best = c;
    }
    if (best) s.parent = best.name;
    // A "method" match outside any container is really a nested function or a false positive.
    if (s.kind === 'method' && !best && fam === 'js') s.kind = 'function';
  }
  // Drop JS "methods" that are actually control flow inside functions (no container, deeply nested).
  return syms.filter((s) => !(fam === 'js' && s.kind === 'function' && !s.parent && /^\s{4,}/.test(lines[s.line - 1] ?? '') && !/^[ \t]*(export|async|function)/.test(lines[s.line - 1] ?? '')));
}

/** Innermost symbol containing a line. */
export function enclosingSymbol(symbols: SymbolRef[], line: number): SymbolRef | undefined {
  let best: SymbolRef | undefined;
  for (const s of symbols) {
    if (s.line <= line && (s.endLine ?? s.line) >= line && (!best || s.line >= best.line)) best = s;
  }
  return best;
}
