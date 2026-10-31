// Static component tree for the architecture diagram: packages (from manifests) → modules (directory
// groups) → subdirectories. Every code file is owned by exactly one node: the deepest one containing it.
import path from 'node:path';
import { groupModules } from './graph.js';

export interface HierNode {
  id: string;
  /** Directory prefix ('' for the repository root). */
  path: string;
  name: string;
  kind: 'package' | 'module' | 'dir';
  children: HierNode[];
  /** Files owned directly by this node (not by a child). */
  ownFiles: string[];
}

interface FileIn {
  path: string;
  lang: string | null;
  content?: string;
}

/** Manifests that declare a package (a deployable or publishable unit). */
const PACKAGE_MANIFEST = /(^|\/)(package\.json|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|composer\.json|[^/]+\.csproj)$/;
const NON_CODE = new Set(['markdown', 'mdx', 'text', 'rst', 'json', 'jsonc', 'yaml', 'toml', 'ini', 'xml', 'dotenv', 'html', 'css', 'scss', 'less', 'svg']);
const MAX_NODES = 250;
const MAX_DIR_DEPTH = 3;

const isCode = (f: FileIn) => Boolean(f.lang) && !NON_CODE.has(f.lang!);
const dirOf = (p: string) => (path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
const under = (p: string, dir: string) => !dir || p.startsWith(dir + '/');

function manifestName(file: string, content: string | undefined): string | null {
  if (!content) return null;
  try {
    if (file.endsWith('package.json') || file.endsWith('composer.json')) return (JSON.parse(content).name as string) || null;
  } catch {
    return null;
  }
  const m =
    (file.endsWith('pyproject.toml') || file.endsWith('Cargo.toml')) ? content.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
    : file.endsWith('go.mod') ? content.match(/^module\s+(\S+)/m)
    : file.endsWith('pom.xml') ? content.match(/<artifactId>([^<]+)<\/artifactId>/)
    : null;
  return m ? m[1] : null;
}

function isWorkspaceRoot(file: string, content: string | undefined): boolean {
  if (!content) return false;
  if (file === 'package.json') {
    try {
      return Boolean(JSON.parse(content).workspaces);
    } catch {
      return false;
    }
  }
  if (file === 'Cargo.toml') return /^\s*\[workspace\]/m.test(content);
  return false;
}

export function prettyName(p: string): string {
  if (!p) return 'Project root';
  const segs = p.split('/');
  const last = segs[segs.length - 1];
  const parent = segs.length > 1 ? segs[segs.length - 2] : '';
  const name = ['src', 'lib', 'app', 'index', 'main'].includes(last) && parent ? `${parent}/${last}` : last;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Name for a directory relative to its parent node: "Routes", or "src/" for a generic folder's own files. */
function relName(parent: string, p: string): string {
  const rel = parent && p.startsWith(parent + '/') ? p.slice(parent.length + 1) : p;
  const last = rel.split('/').pop()!;
  if (['src', 'main', 'index', 'source'].includes(last)) return `${rel}/`;
  return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Build the component tree. `files` must include manifest contents for package detection. */
export function buildHierarchy(files: FileIn[], extraWorkspaceRoot = false): HierNode[] {
  let count = 0;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const used = new Set<string>();
  const idFor = (p: string) => {
    const base = (p || 'root').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'x';
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };

  // Packages: directories holding a manifest. A workspace root manifest is a container, not a package.
  const pkgs = new Map<string, string>(); // dir -> display name
  let rootIsWorkspace = extraWorkspaceRoot || files.some((f) => /^(pnpm-workspace\.yaml|lerna\.json|go\.work|nx\.json|turbo\.json)$/.test(f.path));
  for (const f of files) {
    if (!PACKAGE_MANIFEST.test(f.path)) continue;
    const dir = dirOf(f.path);
    if (!dir && isWorkspaceRoot(f.path, f.content)) {
      rootIsWorkspace = true;
      continue;
    }
    if (!pkgs.has(dir)) pkgs.set(dir, manifestName(f.path, f.content) ?? prettyName(dir));
  }
  if (rootIsWorkspace) pkgs.delete('');
  const pkgDirs = [...pkgs.keys()].filter((d) => files.some((f) => isCode(f) && under(f.path, d) && f.path !== d));

  /** Subdirectory nodes below `dir` (files already restricted to `dir`). */
  const dirNode = (dir: string, items: FileIn[], kind: HierNode['kind'], name: string, depth: number): HierNode => {
    count++;
    const node: HierNode = { id: idFor(dir), path: dir, name, kind, children: [], ownFiles: [] };
    const sub = new Map<string, FileIn[]>();
    for (const f of items) {
      const rest = dir ? f.path.slice(dir.length + 1) : f.path;
      if (!rest.includes('/')) node.ownFiles.push(f.path);
      else {
        const child = dir ? `${dir}/${rest.split('/')[0]}` : rest.split('/')[0];
        (sub.get(child) ?? sub.set(child, []).get(child)!).push(f);
      }
    }
    for (const [child, list] of [...sub].sort(([a], [b]) => a.localeCompare(b))) {
      const nested = pkgs.has(child) && child !== dir;
      if (!list.some(isCode) || (!nested && (depth >= MAX_DIR_DEPTH || count >= MAX_NODES))) {
        node.ownFiles.push(...list.map((f) => f.path));
        continue;
      }
      // Collapse chains of directories that only hold one subdirectory (src/main/java/...).
      let target = child;
      let targetItems = list;
      for (;;) {
        if (pkgs.has(target) && target !== child) break;
        const direct = targetItems.filter((f) => !f.path.slice(target.length + 1).includes('/'));
        const next = new Set(targetItems.filter((f) => f.path.slice(target.length + 1).includes('/')).map((f) => `${target}/${f.path.slice(target.length + 1).split('/')[0]}`));
        if (direct.some(isCode) || next.size !== 1) break;
        target = [...next][0];
        targetItems = targetItems.filter((f) => f.path.startsWith(target + '/'));
        if (direct.length) node.ownFiles.push(...direct.map((f) => f.path));
      }
      const isPkg = pkgs.has(target);
      node.children.push(dirNode(target, targetItems, isPkg ? 'package' : 'dir', isPkg ? pkgs.get(target)! : relName(dir, target), isPkg ? 0 : depth + 1));
    }
    // A node whose code all sits in one child directory is that child: fold it in.
    const only = node.children[0];
    if (node.children.length === 1 && only.kind !== 'package' && !node.ownFiles.some((p) => isCode(byPath.get(p)!))) {
      node.children = only.children;
      node.ownFiles.push(...only.ownFiles);
    }
    return node;
  };

  /** Modules of a package (or of the repo): directory groups from groupModules, each with its subdirectories. */
  const modulesOf = (prefix: string, items: FileIn[], target: number): { modules: HierNode[]; own: string[] } => {
    const rel = items.map((f) => ({ path: prefix ? f.path.slice(prefix.length + 1) : f.path, lang: f.lang }));
    const groups = groupModules(rel, target);
    const modules: HierNode[] = [];
    const own: string[] = [];
    for (const g of groups) {
      const full = (p: string) => (prefix ? `${prefix}/${p}` : p);
      const groupFiles = new Set(g.files.map(full));
      const list = items.filter((f) => groupFiles.has(f.path));
      if (g.id === '(root)' || !list.some(isCode)) {
        own.push(...list.map((f) => f.path));
        continue;
      }
      // Nested packages inside a module still show up as package nodes (dirNode handles that).
      const isPkg = pkgs.has(full(g.id));
      modules.push(dirNode(full(g.id), list, isPkg ? 'package' : 'module', isPkg ? pkgs.get(full(g.id))! : relName(prefix, full(g.id)), isPkg ? 0 : 1));
    }
    return { modules, own };
  };

  const topPkgs = pkgDirs.filter((d) => d && !pkgDirs.some((o) => o !== d && o !== '' && under(d, o)));
  if (!topPkgs.length || pkgs.has('')) {
    const { modules, own } = modulesOf('', files, 14);
    const rootCode = own.filter((p) => isCode(byPath.get(p)!));
    if (!rootCode.length) return modules;
    count++;
    return [{ id: idFor(''), path: '', name: pkgs.get('') ?? 'Project root', kind: pkgs.has('') ? 'package' : 'module', children: [], ownFiles: own }, ...modules];
  }

  const out: HierNode[] = [];
  for (const dir of topPkgs.sort()) {
    const items = files.filter((f) => under(f.path, dir));
    count++;
    const node: HierNode = { id: idFor(dir), path: dir, name: pkgs.get(dir)!, kind: 'package', children: [], ownFiles: [] };
    const { modules, own } = modulesOf(dir, items, 8);
    node.children = modules;
    node.ownFiles = own;
    out.push(node);
  }
  // Code outside any package (shared sources, scripts) becomes top-level modules next to the packages.
  const rest = files.filter((f) => !topPkgs.some((d) => under(f.path, d)));
  if (rest.some(isCode)) {
    const { modules, own } = modulesOf('', rest, 6);
    out.push(...modules);
    if (own.some((p) => isCode(byPath.get(p)!))) {
      count++;
      out.push({ id: idFor(''), path: '', name: 'Project root', kind: 'module', children: [], ownFiles: own });
    }
  }
  return out;
}

/** Every node, parents before children. */
export function flatten(nodes: HierNode[], parent: HierNode | null = null, out: { node: HierNode; parent: HierNode | null }[] = []) {
  for (const n of nodes) {
    out.push({ node: n, parent });
    flatten(n.children, n, out);
  }
  return out;
}

/** All files under a node (own files plus descendants'). */
export function filesUnder(n: HierNode): string[] {
  return [...n.ownFiles, ...n.children.flatMap(filesUnder)];
}
