/**
 * Moteur Git simulé, sans aucune dépendance au DOM.
 *
 * L'état est un objet JSON pur. Chaque commande reçoit un état et renvoie
 * { state, out, ok, info } sans jamais modifier l'objet reçu :
 *   - out  : lignes de sortie, chaîne ou tableau de segments (texte ou [texte, classes]) ;
 *   - info : description structurée de ce qui s'est passé (sert aux explications pédagogiques).
 * Les seules sources d'impureté (horloge, hasard) sont injectables via `env`.
 */

export const STATE_VERSION = 1;
export const DEFAULT_BRANCH = 'main';
export const REPO_PATH = '/home/apprenant/projet';

const DEFAULT_USER = Object.freeze({ name: 'Apprenant', email: 'apprenant@exemple.fr' });
const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git';

export const defaultEnv = {
  now: () => Date.now(),
  randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  },
};

/* ------------------------------------------------------------------ utilitaires */

export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
export const get = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
export const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const keysOf = (...objects) => [...new Set(objects.flatMap((o) => Object.keys(o)))].sort(byteOrder);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringMap = (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function splitLines(content) {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function result(state, out, ok, info = null) {
  return { state, out: typeof out === 'string' ? out.split('\n') : out, ok, info };
}
export const success = (state, out = [], info = null) => result(state, out, true, info);
export const failure = (state, out, info = null) => result(state, out, false, info);
export const requireRepo = (state) => (state.repo ? null : failure(state, NOT_A_REPO, { kind: 'not-a-repo' }));

/* ------------------------------------------------------------------ état */

export const DEMO_URL = 'https://github.com/camille/demo.git';
export const COLLEAGUE = Object.freeze({ name: 'Camille', email: 'camille@exemple.fr' });

/** Dépôt distant vide, tel qu'un nouveau dépôt GitHub. */
export function emptyServer() {
  return { head: DEFAULT_BRANCH, branches: {}, commits: {}, seq: 0, tags: {}, tagMeta: {} };
}

/** Dépôt de démonstration que `git clone` peut récupérer. */
function seedServer() {
  const steps = [
    {
      id: 'a1b2c3d',
      message: 'Initial commit',
      parent: null,
      lane: 'main',
      file: ['README.md', "# Demo\nProjet d'exemple hébergé sur GitHub (simulé).\n"],
    },
    {
      id: 'b2c3d4e',
      message: "Ajoute la page d'accueil",
      parent: 'a1b2c3d',
      lane: 'main',
      file: ['index.html', '<h1>Demo</h1>\n'],
    },
    {
      id: 'c3d4e5f',
      message: 'Ajoute le style',
      parent: 'b2c3d4e',
      lane: 'main',
      file: ['style.css', 'body { margin: 0; }\n'],
    },
    {
      id: 'd4e5f6a',
      message: 'Début de la page contact',
      parent: 'c3d4e5f',
      lane: 'feature',
      file: ['contact.html', '<h1>Contact</h1>\n'],
    },
  ];
  const server = emptyServer();
  server.branches = { main: 'c3d4e5f', feature: 'd4e5f6a' };
  server.tags = { 'v0.1': 'b2c3d4e' };
  steps.forEach((step, i) => {
    const parent = step.parent ? server.commits[step.parent] : null;
    server.commits[step.id] = {
      id: step.id,
      hash: `${step.id}0123456789abcdef0123456789abcdef01234`.slice(0, 40),
      message: step.message,
      parents: parent ? [parent.id] : [],
      author: { ...COLLEAGUE },
      timestamp: Date.UTC(2026, 8, 1 + i, 10, 0, 0),
      tree: { ...(parent?.tree ?? {}), [step.file[0]]: step.file[1] },
      lane: step.lane,
      seq: ++server.seq,
    };
  });
  return server;
}

export function createState() {
  return {
    version: STATE_VERSION,
    user: { ...DEFAULT_USER },
    workdir: {},
    repo: null,
    config: {}, // réglages de git config autres que user.* (pull.rebase, pull.ff)
    // « GitHub » : les dépôts distants que les URL peuvent désigner, indexés par URL.
    servers: { [DEMO_URL]: seedServer() },
  };
}

export function createRepo() {
  return {
    head: { type: 'branch', name: DEFAULT_BRANCH },
    previousHead: null,
    branches: {},
    commits: {},
    index: {},
    merge: null,
    seq: 0,
    // Ordre d'apparition des branches : sert à leur attribuer une couleur stable.
    lanes: [DEFAULT_BRANCH],
    tags: {}, // nom -> id de commit
    tagMeta: {}, // tags annotés : nom -> { message, tagger, timestamp }
    stash: [], // le plus récent en premier : stash@{0}
    remotes: {}, // nom -> { url }
    remoteRefs: {}, // branches de suivi : 'origin/main' -> id de commit
    upstreams: {}, // branche locale -> branche de suivi
    pick: null, // cherry-pick ou revert en cours (arrêté sur un conflit)
    rebase: null, // rebase en cours (arrêté sur un conflit)
  };
}

const validServer = (sv) =>
  isPlainObject(sv) &&
  typeof sv.head === 'string' &&
  typeof sv.seq === 'number' &&
  isPlainObject(sv.commits) &&
  isStringMap(sv.branches) &&
  Object.values(sv.branches).every((id) => hasOwn(sv.commits, id)) &&
  isStringMap(sv.tags) &&
  Object.values(sv.tags).every((id) => hasOwn(sv.commits, id)) &&
  isPlainObject(sv.tagMeta) &&
  Object.entries(sv.commits).every(
    ([id, c]) =>
      isPlainObject(c) &&
      c.id === id &&
      typeof c.hash === 'string' &&
      typeof c.message === 'string' &&
      typeof c.seq === 'number' &&
      isPlainObject(c.author) &&
      Array.isArray(c.parents) &&
      c.parents.every((p) => hasOwn(sv.commits, p)) &&
      isStringMap(c.tree),
  );

export function isValidState(s) {
  if (!isPlainObject(s) || s.version !== STATE_VERSION || !isStringMap(s.workdir) || !isPlainObject(s.user))
    return false;
  if (!isPlainObject(s.servers) || !Object.values(s.servers).every(validServer) || !isStringMap(s.config)) return false;
  if (s.repo === null) return true;
  const r = s.repo;
  if (!isPlainObject(r) || !isPlainObject(r.commits) || !isStringMap(r.branches) || !isStringMap(r.index)) return false;
  if (!Array.isArray(r.lanes) || typeof r.seq !== 'number') return false;
  const commitOk = ([id, c]) =>
    isPlainObject(c) &&
    c.id === id &&
    typeof c.hash === 'string' &&
    typeof c.message === 'string' &&
    Array.isArray(c.parents) &&
    c.parents.every((p) => hasOwn(r.commits, p)) &&
    isStringMap(c.tree) &&
    typeof c.seq === 'number' &&
    isPlainObject(c.author);
  if (!Object.entries(r.commits).every(commitOk)) return false;
  if (!Object.values(r.branches).every((id) => hasOwn(r.commits, id))) return false;
  const remotesOk =
    isPlainObject(r.remotes) &&
    Object.values(r.remotes).every((x) => isPlainObject(x) && typeof x.url === 'string' && hasOwn(s.servers, x.url));
  if (!remotesOk || !isStringMap(r.remoteRefs) || !isStringMap(r.upstreams)) return false;
  if (!Object.values(r.remoteRefs).every((id) => hasOwn(r.commits, id))) return false;
  if (!isStringMap(r.tags) || !Object.values(r.tags).every((id) => hasOwn(r.commits, id))) return false;
  if (!isPlainObject(r.tagMeta) || !Array.isArray(r.stash)) return false;
  const stashOk = (e) =>
    isPlainObject(e) &&
    typeof e.message === 'string' &&
    hasOwn(r.commits, e.base) &&
    isStringMap(e.index) &&
    isStringMap(e.tree) &&
    isStringMap(e.untracked);
  if (!r.stash.every(stashOk)) return false;
  if (
    r.merge !== null &&
    !(isPlainObject(r.merge) && hasOwn(r.commits, r.merge.theirs) && isPlainObject(r.merge.conflicts))
  )
    return false;
  const idsOk = (ids) => Array.isArray(ids) && ids.every((id) => hasOwn(r.commits, id));
  const snapshotOk = (x) => isPlainObject(x) && isStringMap(x.index) && isStringMap(x.workdir);
  const p = r.pick;
  if (p !== null) {
    const valid =
      isPlainObject(p) &&
      (p.kind === 'cherry-pick' || p.kind === 'revert') &&
      (p.id === null || hasOwn(r.commits, p.id)) &&
      idsOk(p.todo) &&
      isPlainObject(p.conflicts) &&
      isStringMap(p.theirsTree) &&
      snapshotOk(p.saved);
    if (!valid) return false;
  }
  const rb = r.rebase;
  if (rb !== null) {
    const valid =
      isPlainObject(rb) &&
      hasOwn(r.commits, rb.onto) &&
      (rb.current === null || hasOwn(r.commits, rb.current)) &&
      idsOk(rb.todo) &&
      typeof rb.total === 'number' &&
      isPlainObject(rb.conflicts) &&
      snapshotOk(rb.saved);
    if (!valid) return false;
  }
  const h = r.head;
  if (!isPlainObject(h)) return false;
  if (h.type === 'branch') return typeof h.name === 'string';
  return h.type === 'detached' && hasOwn(r.commits, h.commit);
}

/** Complète un état enregistré par une version plus ancienne du simulateur. */
export function normalizeState(state) {
  if (!isPlainObject(state)) return state;
  const s = { ...state };
  if (!isPlainObject(s.servers)) s.servers = { [DEMO_URL]: seedServer() };
  if (!isPlainObject(s.config)) s.config = {};
  s.servers = Object.fromEntries(
    Object.entries(s.servers).map(([url, sv]) => [
      url,
      isPlainObject(sv) ? { tags: {}, tagMeta: {}, ...sv } : sv,
    ]),
  );
  if (isPlainObject(s.repo)) {
    s.repo = {
      previousHead: null,
      merge: null,
      tags: {},
      tagMeta: {},
      stash: [],
      remotes: {},
      remoteRefs: {},
      upstreams: {},
      pick: null,
      rebase: null,
      ...s.repo,
    };
    for (const remote of Object.values(s.repo.remotes)) {
      if (isPlainObject(remote) && typeof remote.url === 'string' && !hasOwn(s.servers, remote.url)) {
        s.servers = { ...s.servers, [remote.url]: emptyServer() };
      }
    }
  }
  return s;
}

export const serialize = (state) => JSON.stringify(state);

export function deserialize(json) {
  try {
    const state = normalizeState(JSON.parse(json));
    return isValidState(state) ? state : null;
  } catch {
    return null;
  }
}

/** Pile d'états pour « Annuler la dernière commande ». Les états étant immuables, on stocke des références. */
export class UndoStack {
  constructor(entries = [], limit = 50) {
    this.limit = limit;
    this.entries = (Array.isArray(entries) ? entries : [])
      .map((e) => (e && typeof e === 'object' ? { ...e, state: normalizeState(e.state) } : null))
      .filter((e) => e && isValidState(e.state))
      .slice(-limit);
  }
  push(state, label) {
    this.entries.push({ state, label });
    if (this.entries.length > this.limit) this.entries.shift();
  }
  pop() {
    return this.entries.pop() ?? null;
  }
  get size() {
    return this.entries.length;
  }
  toJSON() {
    return this.entries;
  }
}

/* ------------------------------------------------------------------ lecture du dépôt */

export function headCommitId(repo) {
  return repo.head.type === 'branch' ? (get(repo.branches, repo.head.name) ?? null) : repo.head.commit;
}

export const currentBranch = (repo) => (repo.head.type === 'branch' ? repo.head.name : null);
export const subject = (c) => c.message.split('\n')[0];
export const treeOf = (repo, id) => (id ? repo.commits[id].tree : {});
export const shortLine = (repo, id) => `${id} ${subject(repo.commits[id])}`;

/** Conflits de l'opération en cours (fusion, cherry-pick, revert ou rebase), ou un objet vide. */
export const conflictsOf = (repo) => (repo.merge ?? repo.pick ?? repo.rebase)?.conflicts ?? {};

/** Opération arrêtée qui bloque un nouveau départ : { name, noun } ou null. */
export function operationInProgress(repo) {
  if (repo.merge) return { name: 'merge', noun: 'merge', verb: 'merging', head: 'MERGE_HEAD' };
  if (repo.rebase) return { name: 'rebase', noun: 'rebase', verb: 'rebasing', head: 'REBASE_HEAD' };
  if (repo.pick) {
    const revert = repo.pick.kind === 'revert';
    return {
      name: repo.pick.kind,
      noun: repo.pick.kind,
      verb: revert ? 'reverting' : 'cherry-picking',
      head: revert ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD',
    };
  }
  return null;
}

/* ------------------------------------------------------------------ .gitignore */

export function globToRegExp(glob) {
  const escape = (ch) => ch.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      source += '.*';
      while (glob[i + 1] === '*') i++;
    } else if (ch === '?') source += '.';
    else if (ch === '[' && glob.indexOf(']', i + 2) !== -1) {
      const end = glob.indexOf(']', i + 2);
      source += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (ch === '\\' && i + 1 < glob.length) source += escape(glob[++i]);
    else source += escape(ch);
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

/** Règles de .gitignore (un seul niveau : le simulateur n'a pas de sous-dossiers). */
function ignoreRules(workdir) {
  const content = get(workdir, '.gitignore');
  if (content === undefined) return [];
  const rules = [];
  splitLines(content).forEach((raw, i) => {
    let text = raw.replace(/(?<!\\)\s+$/, '');
    if (!text || text.startsWith('#')) return;
    const negate = text.startsWith('!');
    if (negate) text = text.slice(1);
    if (text.endsWith('/')) return; // un motif de dossier ne correspond à aucun fichier ici
    text = text.replace(/^\//, '');
    if (!text || text.includes('/')) return;
    const regex = globToRegExp(text.replace(/^\\(?=[#!])/, ''));
    if (regex) rules.push({ regex, negate, line: i + 1, text: raw });
  });
  return rules;
}

/** Règle de .gitignore qui ignore ce fichier (la dernière qui correspond l'emporte), ou null. */
export function ignoreMatch(workdir, path) {
  let found = null;
  for (const rule of ignoreRules(workdir)) if (rule.regex.test(path)) found = rule.negate ? null : rule;
  return found;
}

export function ancestors(repo, ...ids) {
  const seen = new Set();
  const stack = ids.filter(Boolean);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...repo.commits[id].parents);
  }
  return seen;
}

export const isAncestor = (repo, ancestor, of) => ancestors(repo, of).has(ancestor);

export function mergeBase(repo, a, b) {
  const fromA = ancestors(repo, a);
  let best = null;
  for (const id of ancestors(repo, b)) {
    if (fromA.has(id) && (!best || repo.commits[id].seq > repo.commits[best].seq)) best = id;
  }
  return best;
}

/** Commits accessibles depuis une référence ; les autres sont « orphelins ». */
export function reachableCommits(repo) {
  return ancestors(
    repo,
    ...Object.values(repo.branches),
    ...Object.values(repo.remoteRefs),
    ...Object.values(repo.tags),
    headCommitId(repo),
  );
}

function findCommitByPrefix(repo, prefix) {
  if (!/^[0-9a-f]{4,40}$/.test(prefix)) return null;
  const matches = Object.values(repo.commits).filter((c) => c.hash.startsWith(prefix));
  return matches.length === 1 ? matches[0].id : null;
}

/** Résout HEAD, une branche ou un hash abrégé, suivis éventuellement de ~n ou ^n. */
export function resolveRevision(repo, rev) {
  const match = /^(.+?)((?:[~^]\d*)*)$/.exec(rev);
  if (!match) return null;
  const [, base, suffix] = match;
  let id;
  if (base === 'HEAD' || base === '@') id = headCommitId(repo);
  else if (hasOwn(repo.tags, base)) id = repo.tags[base];
  else if (hasOwn(repo.branches, base)) id = repo.branches[base];
  else if (hasOwn(repo.remoteRefs, base)) id = repo.remoteRefs[base];
  else id = findCommitByPrefix(repo, base);
  for (const [, op, digits] of suffix.matchAll(/([~^])(\d*)/g)) {
    if (!id) return null;
    const n = digits === '' ? 1 : Number(digits);
    if (op === '~') for (let i = 0; i < n && id; i++) id = repo.commits[id].parents[0] ?? null;
    else if (n > 0) id = repo.commits[id].parents[n - 1] ?? null;
  }
  return id ?? null;
}

export function isValidBranchName(name) {
  if (!name || name === 'HEAD' || name === '@' || name === '__proto__') return false;
  if (name.startsWith('-') || name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.split('/').some((part) => part.startsWith('.'))) return false;
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
}

/** Écart entre une branche locale et sa branche de suivi : { upstream, gone, ahead, behind }. */
export function trackingInfo(repo, branch) {
  const upstream = get(repo.upstreams, branch);
  if (!upstream) return null;
  const remoteId = get(repo.remoteRefs, upstream);
  if (!remoteId) return { upstream, gone: true, ahead: 0, behind: 0 };
  const mine = ancestors(repo, get(repo.branches, branch));
  const theirs = ancestors(repo, remoteId);
  return {
    upstream,
    gone: false,
    ahead: [...mine].filter((id) => !theirs.has(id)).length,
    behind: [...theirs].filter((id) => !mine.has(id)).length,
  };
}

/** « ahead 1, behind 2 », « gone » ou une chaîne vide quand tout est à jour. */
export function trackingBrief(info) {
  if (info.gone) return 'gone';
  return [info.ahead && `ahead ${info.ahead}`, info.behind && `behind ${info.behind}`].filter(Boolean).join(', ');
}

function trackingLines(info) {
  const { upstream: up, ahead, behind } = info;
  if (info.gone)
    return [
      `Your branch is based on '${up}', but the upstream is gone.`,
      '  (use "git branch --unset-upstream" to fixup)',
    ];
  if (!ahead && !behind) return [`Your branch is up to date with '${up}'.`];
  if (!behind)
    return [
      `Your branch is ahead of '${up}' by ${plural(ahead, 'commit')}.`,
      '  (use "git push" to publish your local commits)',
    ];
  if (!ahead) {
    return [
      `Your branch is behind '${up}' by ${plural(behind, 'commit')}, and can be fast-forwarded.`,
      '  (use "git pull" to update your local branch)',
    ];
  }
  return [
    `Your branch and '${up}' have diverged,`,
    `and have ${ahead} and ${behind} different commits each, respectively.`,
    '  (use "git pull" if you want to integrate the remote branch with yours)',
  ];
}

function branchTrackingLines(repo, name) {
  const info = trackingInfo(repo, name);
  return info ? trackingLines(info) : [];
}

/** Compare HEAD, l'index et le répertoire de travail (le cœur de `git status`). */
export function computeStatus(state) {
  const repo = state.repo;
  const head = treeOf(repo, headCommitId(repo));
  const { index } = repo;
  const wd = state.workdir;
  const conflicts = conflictsOf(repo);
  const staged = [];
  const unstaged = [];
  for (const path of keysOf(head, index)) {
    if (hasOwn(conflicts, path)) continue;
    const before = get(head, path);
    const after = get(index, path);
    if (before === after) continue;
    staged.push({ path, kind: before === undefined ? 'new' : after === undefined ? 'deleted' : 'modified' });
  }
  for (const path of keysOf(index)) {
    if (hasOwn(conflicts, path)) continue;
    if (!hasOwn(wd, path)) unstaged.push({ path, kind: 'deleted' });
    else if (wd[path] !== index[path]) unstaged.push({ path, kind: 'modified' });
  }
  const rules = ignoreRules(wd);
  const isIgnored = (p) => rules.reduce((hit, r) => (r.regex.test(p) ? !r.negate : hit), false);
  const untracked = keysOf(wd).filter((p) => !hasOwn(index, p) && !hasOwn(conflicts, p) && !isIgnored(p));
  const unmerged = keysOf(conflicts).map((path) => ({ path, kind: conflicts[path] }));
  return { staged, unstaged, untracked, unmerged };
}

/* ------------------------------------------------------------------ diff */

/** Diff ligne à ligne (plus longue sous-séquence commune) : opérations ' ', '-' et '+'. */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const ops = a.slice(0, pre).map((line) => ({ t: ' ', line }));
  if (A.length * B.length > 250000) {
    ops.push(...A.map((line) => ({ t: '-', line })), ...B.map((line) => ({ t: '+', line })));
  } else {
    const lcs = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) {
        ops.push({ t: ' ', line: A[i++] });
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: '-', line: A[i++] });
      else ops.push({ t: '+', line: B[j++] });
    }
    while (i < A.length) ops.push({ t: '-', line: A[i++] });
    while (j < B.length) ops.push({ t: '+', line: B[j++] });
  }
  ops.push(...a.slice(a.length - suf).map((line) => ({ t: ' ', line })));
  return ops;
}

function hunks(ops, context = 3) {
  const positions = [];
  let oldLine = 1;
  let newLine = 1;
  for (const op of ops) {
    positions.push([oldLine, newLine]);
    if (op.t !== '+') oldLine++;
    if (op.t !== '-') newLine++;
  }
  const ranges = [];
  ops.forEach((op, i) => {
    if (op.t === ' ') return;
    const last = ranges[ranges.length - 1];
    if (last && i - context <= last[1] + 1) last[1] = Math.min(ops.length - 1, i + context);
    else ranges.push([Math.max(0, i - context), Math.min(ops.length - 1, i + context)]);
  });
  const range = (start, count) => (count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`);
  return ranges.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    const [oldStart, newStart] = positions[start];
    return { header: `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`, ops: slice };
  });
}

/** Identifiant de blob imité (le fichier vide garde le vrai hash de Git). */
function blobId(content) {
  if (content === '') return 'e69de29';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ content.length;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 7);
}

export function treeChanges(from, to) {
  return keysOf(from, to).flatMap((path) => {
    const before = get(from, path);
    const after = get(to, path);
    if (before === after) return [];
    const ops = diffLines(splitLines(before ?? ''), splitLines(after ?? ''));
    const ins = ops.filter((o) => o.t === '+').length;
    const del = ops.filter((o) => o.t === '-').length;
    return [{ path, before, after, ops, ins, del }];
  });
}

export function fileDiffLines({ path, before, after, ops }) {
  const bold = (text) => [[text, 'bold']];
  const out = [bold(`diff --git a/${path} b/${path}`)];
  if (before === undefined) out.push(bold('new file mode 100644'), bold(`index 0000000..${blobId(after)}`));
  else if (after === undefined) out.push(bold('deleted file mode 100644'), bold(`index ${blobId(before)}..0000000`));
  else out.push(bold(`index ${blobId(before)}..${blobId(after)} 100644`));
  if (!ops.some((o) => o.t !== ' ')) return out;
  out.push(
    bold(before === undefined ? '--- /dev/null' : `--- a/${path}`),
    bold(after === undefined ? '+++ /dev/null' : `+++ b/${path}`),
  );
  for (const hunk of hunks(ops)) {
    out.push([[hunk.header, 'cyan']]);
    for (const op of hunk.ops)
      out.push(op.t === ' ' ? ` ${op.line}` : [[op.t + op.line, op.t === '+' ? 'green' : 'red']]);
  }
  return out;
}

export function diffstatLines(changes) {
  if (!changes.length) return [];
  const nameWidth = Math.max(...changes.map((c) => c.path.length));
  const maxTotal = Math.max(...changes.map((c) => c.ins + c.del));
  const countWidth = String(maxTotal).length;
  const barWidth = Math.max(10, 70 - nameWidth - countWidth);
  const scale = (n) => (maxTotal > barWidth && n ? Math.max(1, Math.round((n * barWidth) / maxTotal)) : n);
  return changes.map((c) => {
    const left = ` ${c.path.padEnd(nameWidth)} | ${String(c.ins + c.del).padStart(countWidth)}`;
    const plus = '+'.repeat(scale(c.ins));
    const minus = '-'.repeat(scale(c.del));
    return plus || minus ? [`${left} `, [plus, 'green'], [minus, 'red']] : left;
  });
}

export function summaryLines(changes, { modes = true } = {}) {
  if (!changes.length) return [];
  const ins = changes.reduce((n, c) => n + c.ins, 0);
  const del = changes.reduce((n, c) => n + c.del, 0);
  let line = ` ${plural(changes.length, 'file')} changed`;
  if (!ins && !del) line += ', 0 insertions(+), 0 deletions(-)';
  if (ins) line += `, ${plural(ins, 'insertion')}(+)`;
  if (del) line += `, ${plural(del, 'deletion')}(-)`;
  const out = [line];
  if (!modes) return out;
  for (const c of changes) {
    if (c.before === undefined) out.push(` create mode 100644 ${c.path}`);
    else if (c.after === undefined) out.push(` delete mode 100644 ${c.path}`);
  }
  return out;
}

/* ------------------------------------------------------------------ fichiers simulés */

function fileNameProblem(name) {
  if (name === '' || name === '__proto__') return 'invalid';
  if (name === '.' || name === '..' || name === '.git') return 'directory';
  if (name.includes('/')) return 'missing-directory';
  return null;
}

export function touch(state, names) {
  if (!names.length) return failure(state, ['touch: missing file operand', "Try 'touch --help' for more information."]);
  const s = clone(state);
  const out = [];
  const created = [];
  for (const name of names) {
    const problem = fileNameProblem(name);
    if (problem === 'missing-directory') out.push(`touch: cannot touch '${name}': No such file or directory`);
    else if (problem === 'invalid') out.push(`touch: cannot touch '${name}': Invalid argument`);
    else if (!problem && !hasOwn(s.workdir, name)) {
      s.workdir[name] = '';
      created.push(name);
    }
  }
  return result(created.length ? s : state, out, !out.length, { kind: 'touch', created });
}

export function writeFile(state, name, content, append = false) {
  const problem = fileNameProblem(name);
  if (problem === 'missing-directory') return failure(state, `bash: ${name}: No such file or directory`);
  if (problem === 'directory') return failure(state, `bash: ${name}: Is a directory`);
  if (problem) return failure(state, `bash: ${name}: Invalid argument`);
  const s = clone(state);
  s.workdir[name] = append ? (get(s.workdir, name) ?? '') + content : content;
  return success(s, [], { kind: 'write', name, append });
}

export function cat(state, names) {
  const out = [];
  let ok = true;
  for (const name of names) {
    if (hasOwn(state.workdir, name)) out.push(...splitLines(state.workdir[name]));
    else {
      out.push(
        `cat: ${name}: ${fileNameProblem(name) === 'directory' ? 'Is a directory' : 'No such file or directory'}`,
      );
      ok = false;
    }
  }
  return result(state, out, ok);
}

export function ls(state, { all = false } = {}) {
  const entries = Object.keys(state.workdir).filter((n) => all || !n.startsWith('.'));
  const dirs = all ? ['.', '..', ...(state.repo ? ['.git'] : [])] : [];
  const items = [...dirs.map((d) => [d, 'blue bold']), ...entries.sort(byteOrder)];
  if (!items.length) return success(state, []);
  return success(state, [items.flatMap((item, i) => (i ? ['  ', item] : [item]))]);
}

export function rm(state, names, { recursive = false, force = false } = {}) {
  if (!names.length) return failure(state, ['rm: missing operand', "Try 'rm --help' for more information."]);
  const s = clone(state);
  const out = [];
  let removedRepo = false;
  for (const name of names) {
    if (name === '.git' && s.repo) {
      if (recursive) {
        s.repo = null;
        removedRepo = true;
      } else out.push("rm: cannot remove '.git': Is a directory");
    } else if (name === '.' || name === '..') {
      out.push(`rm: refusing to remove '.' or '..' directory: skipping '${name}'`);
    } else if (hasOwn(s.workdir, name)) {
      delete s.workdir[name];
    } else if (!force) {
      out.push(`rm: cannot remove '${name}': No such file or directory`);
    }
  }
  return result(s, out, !out.length, { kind: 'rm', removedRepo });
}

/* ------------------------------------------------------------------ git init / status / add */

export function init(state) {
  if (state.repo) {
    return success(state, `Reinitialized existing Git repository in ${REPO_PATH}/.git/`, {
      kind: 'init',
      reinit: true,
    });
  }
  const s = clone(state);
  s.repo = createRepo();
  return success(s, `Initialized empty Git repository in ${REPO_PATH}/.git/`, {
    kind: 'init',
    reinit: false,
    branch: DEFAULT_BRANCH,
  });
}

const CHANGE_LABEL = { new: 'new file:   ', modified: 'modified:   ', deleted: 'deleted:    ' };

function headLine(repo) {
  if (repo.rebase) return `interactive rebase in progress; onto ${repo.rebase.onto}`;
  if (repo.head.type === 'branch') return `On branch ${repo.head.name}`;
  const { commit: at, from } = repo.head;
  return [[`HEAD detached ${at === from ? 'at' : 'from'} ${from}`, 'red']];
}

/** Commandes déjà rejouées et restantes d'un rebase, comme dans l'en-tête de `git status`. */
function rebaseProgressLines(repo) {
  const { all = [], step } = repo.rebase;
  const line = (id) => `   pick ${id} # ${subject(repo.commits[id])}`;
  const done = all.slice(0, step);
  const next = all.slice(step);
  const out = [];
  if (!done.length) out.push('No commands done.');
  else {
    const noun = done.length > 1 ? 'Last commands done' : 'Last command done';
    out.push(`${noun} (${plural(done.length, 'command')} done):`, ...done.slice(-2).map(line));
    if (done.length > 2) out.push('  (see more in file .git/rebase-merge/done)');
  }
  if (!next.length) out.push('No commands remaining.');
  else {
    const noun = next.length > 1 ? 'Next commands to do' : 'Next command to do';
    out.push(`${noun} (${plural(next.length, 'remaining command')}):`, ...next.slice(0, 2).map(line));
    if (next.length > 2) out.push('  (see more in file .git/rebase-merge/git-rebase-todo)');
    out.push('  (use "git rebase --edit-todo" to view and edit)');
  }
  return out;
}

/** Lignes d'un cherry-pick, d'un revert ou d'un rebase arrêté, telles que les affiche `git status`. */
function sequencerLines(repo, unmerged) {
  const resume = (cmd, conflict) =>
    unmerged ? `  (${conflict} run "git ${cmd} --continue")` : `  (all conflicts fixed: run "git ${cmd} --continue")`;
  if (repo.rebase) {
    const { branch, onto } = repo.rebase;
    return [
      `You are currently rebasing${branch ? ` branch '${branch}'` : ''} on '${onto}'.`,
      resume('rebase', 'fix conflicts and then'),
      '  (use "git rebase --skip" to skip this patch)',
      '  (use "git rebase --abort" to check out the original branch)',
      '',
    ];
  }
  const { kind, id } = repo.pick;
  const verb = kind === 'revert' ? 'reverting' : 'cherry-picking';
  return [
    id ? `You are currently ${verb} commit ${id}.` : `Currently ${verb} a sequence of commits.`,
    resume(kind, 'fix conflicts and'),
    `  (use "git ${kind} --skip" to skip this patch)`,
    `  (use "git ${kind} --abort" to cancel the ${kind} operation)`,
    '',
  ];
}

export function statusLines(state, { forCommit = false } = {}) {
  const repo = state.repo;
  const st = computeStatus(state);
  const initial = !headCommitId(repo);
  const out = [headLine(repo)];
  if (repo.rebase) out.push(...rebaseProgressLines(repo));
  const tracking = repo.head.type === 'branch' ? branchTrackingLines(repo, repo.head.name) : [];
  if (tracking.length) out.push(...tracking, '');
  if (repo.merge) {
    if (st.unmerged.length)
      out.push(
        'You have unmerged paths.',
        '  (fix conflicts and run "git commit")',
        '  (use "git merge --abort" to abort the merge)',
        '',
      );
    else out.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)', '');
  } else if (repo.pick || repo.rebase) {
    out.push(...sequencerLines(repo, st.unmerged.length > 0));
  }
  if (initial) out.push('', forCommit ? 'Initial commit' : 'No commits yet', '');
  if (st.staged.length) {
    out.push('Changes to be committed:');
    if (!repo.merge && !repo.pick)
      out.push(
        initial
          ? '  (use "git rm --cached <file>..." to unstage)'
          : '  (use "git restore --staged <file>..." to unstage)',
      );
    for (const e of st.staged) out.push(['\t', [CHANGE_LABEL[e.kind] + e.path, 'green']]);
    out.push('');
  }
  if (st.unmerged.length) {
    const onlyContent = st.unmerged.every((e) => e.kind.startsWith('both'));
    out.push(
      'Unmerged paths:',
      ...(repo.rebase ? ['  (use "git restore --staged <file>..." to unstage)'] : []),
      onlyContent
        ? '  (use "git add <file>..." to mark resolution)'
        : '  (use "git add/rm <file>..." as appropriate to mark resolution)',
    );
    for (const e of st.unmerged) out.push(['\t', [`${e.kind}:`.padEnd(17) + e.path, 'red']]);
    out.push('');
  }
  if (st.unstaged.length) {
    const hasDeletion = st.unstaged.some((e) => e.kind === 'deleted');
    out.push(
      'Changes not staged for commit:',
      `  (use "git ${hasDeletion ? 'add/rm' : 'add'} <file>..." to update what will be committed)`,
      '  (use "git restore <file>..." to discard changes in working directory)',
    );
    for (const e of st.unstaged) out.push(['\t', [CHANGE_LABEL[e.kind] + e.path, 'red']]);
    out.push('');
  }
  if (st.untracked.length) {
    out.push('Untracked files:', '  (use "git add <file>..." to include in what will be committed)');
    for (const path of st.untracked) out.push(['\t', [path, 'red']]);
    out.push('');
  }
  if (!st.staged.length) {
    if (st.unstaged.length || st.unmerged.length)
      out.push('no changes added to commit (use "git add" and/or "git commit -a")');
    else if (st.untracked.length)
      out.push('nothing added to commit but untracked files present (use "git add" to track)');
    else if (initial) out.push('nothing to commit (create/copy files and use "git add" to track)');
    else if (!repo.merge) out.push('nothing to commit, working tree clean');
  }
  return out;
}

const UNMERGED_CODE = { 'both modified': 'UU', 'both added': 'AA', 'deleted by us': 'DU', 'deleted by them': 'UD' };

function shortStatusLines(state, withBranch) {
  const repo = state.repo;
  const st = computeStatus(state);
  const rows = new Map();
  const row = (path) => rows.get(path) ?? rows.set(path, { x: ' ', y: ' ', conflict: false }).get(path);
  for (const e of st.staged) row(e.path).x = { new: 'A', modified: 'M', deleted: 'D' }[e.kind];
  for (const e of st.unstaged) row(e.path).y = e.kind === 'deleted' ? 'D' : 'M';
  for (const e of st.unmerged)
    Object.assign(row(e.path), { x: UNMERGED_CODE[e.kind][0], y: UNMERGED_CODE[e.kind][1], conflict: true });
  const out = [];
  if (withBranch) {
    if (repo.head.type === 'detached') out.push(['## ', ['HEAD (no branch)', 'red']]);
    else if (!headCommitId(repo)) out.push(['## No commits yet on ', [repo.head.name, 'green']]);
    else {
      const tracking = trackingInfo(repo, repo.head.name);
      const brief = tracking ? trackingBrief(tracking) : '';
      out.push([
        '## ',
        [repo.head.name, 'green'],
        ...(tracking ? ['...', [tracking.upstream, 'red'], ...(brief ? [` [${brief}]`] : [])] : []),
      ]);
    }
  }
  for (const [path, r] of [...rows].sort(([a], [b]) => byteOrder(a, b))) {
    out.push([[r.x, r.conflict ? 'red' : 'green'], [r.y, 'red'], ` ${path}`]);
  }
  for (const path of st.untracked) out.push([['??', 'red'], ` ${path}`]);
  return out;
}

export function status(state, { short = false, branch = false } = {}) {
  return (
    requireRepo(state) ??
    success(state, short ? shortStatusLines(state, branch) : statusLines(state), { kind: 'status' })
  );
}

const IGNORED_ADD_ERROR = (paths) => [
  'The following paths are ignored by one of your .gitignore files:',
  ...paths,
  'hint: Use -f if you really want to add them.',
  'hint: Turn this message off by running',
  'hint: "git config advice.addIgnoredFile false"',
];

export function add(state, { paths = [], all = false, force = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  if (!paths.length && !all) {
    return failure(state, [
      'Nothing specified, nothing added.',
      "hint: Maybe you wanted to say 'git add .'?",
      'hint: Disable this message with "git config advice.addEmptyPathspec false"',
    ]);
  }
  const s = clone(state);
  const repo = s.repo;
  const conflicts = conflictsOf(repo);
  const rules = ignoreRules(s.workdir);
  const matchesRules = (p) => rules.reduce((hit, r) => (r.regex.test(p) ? !r.negate : hit), false);
  const ignored = (p) => !hasOwn(repo.index, p) && !hasOwn(conflicts, p) && matchesRules(p);
  const everything = () => keysOf(s.workdir, repo.index, conflicts).filter((p) => force || !ignored(p));
  const targets = new Set(all ? everything() : []);
  const refused = [];
  for (const spec of paths) {
    if (spec === '.' || spec === ':/') everything().forEach((p) => targets.add(p));
    else if (hasOwn(s.workdir, spec) || hasOwn(repo.index, spec) || hasOwn(conflicts, spec)) {
      if (!force && ignored(spec)) refused.push(spec);
      else targets.add(spec);
    } else return failure(state, `fatal: pathspec '${spec}' did not match any files`);
  }
  if (refused.length) return failure(state, IGNORED_ADD_ERROR(refused), { kind: 'add-ignored', paths: refused });
  const staged = [];
  const resolved = [];
  for (const path of targets) {
    const before = get(repo.index, path);
    if (hasOwn(s.workdir, path)) repo.index[path] = s.workdir[path];
    else delete repo.index[path];
    if (hasOwn(conflicts, path)) {
      delete conflicts[path];
      resolved.push(path);
    } else if (get(repo.index, path) !== before) staged.push(path);
  }
  return success(s, [], { kind: 'add', staged, resolved, op: operationInProgress(repo)?.name ?? null });
}

/* ------------------------------------------------------------------ git commit */

export function cleanupMessage(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** `lane` et `timestamp` sont imposés quand on rejoue (rebase, cherry-pick) ou réécrit (amend) un commit. */
export function createCommit(
  repo,
  { message, parents, tree, author, env, lane = currentBranch(repo), timestamp = env.now() },
) {
  let hash;
  do hash = env.randomHex(40);
  while (hasOwn(repo.commits, hash.slice(0, 7)));
  const created = {
    id: hash.slice(0, 7),
    hash,
    message,
    parents,
    author: { name: author.name, email: author.email },
    timestamp,
    tree: { ...tree },
    lane,
    seq: ++repo.seq,
  };
  repo.commits[created.id] = created;
  if (lane && !repo.lanes.includes(lane)) repo.lanes.push(lane);
  return created;
}

export function moveHead(repo, id) {
  if (repo.head.type === 'branch') repo.branches[repo.head.name] = id;
  else repo.head.commit = id;
}

export const UNMERGED_COMMIT_ERROR = [
  'error: Committing is not possible because you have unmerged files.',
  "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
  'hint: as appropriate to mark resolution and make a commit.',
  'fatal: Exiting because of an unresolved conflict.',
];

export function commit(
  state,
  { message = null, all = false, allowEmpty = false, amend = false, noEdit = false } = {},
  env = defaultEnv,
) {
  const error = requireRepo(state);
  if (error) return error;
  const s = clone(state);
  const repo = s.repo;
  const op = repo.merge ?? repo.pick ?? repo.rebase ?? null;
  const headId = headCommitId(repo);
  if (amend) {
    if (op) {
      return failure(state, `fatal: You are in the middle of a ${operationInProgress(repo).name} -- cannot amend.`);
    }
    if (!headId) return failure(state, 'fatal: You have nothing to amend.');
  }
  const old = amend ? repo.commits[headId] : null;
  const autoStaged = [];
  if (all) {
    for (const path of keysOf(repo.index, conflictsOf(repo))) {
      const before = get(repo.index, path);
      if (hasOwn(s.workdir, path)) repo.index[path] = s.workdir[path];
      else delete repo.index[path];
      if (op) delete op.conflicts[path];
      if (get(repo.index, path) !== before) autoStaged.push(path);
    }
  }
  if (Object.keys(conflictsOf(repo)).length) {
    return failure(state, [...UNMERGED_COMMIT_ERROR, ...keysOf(conflictsOf(repo)).map((p) => `U\t${p}`)]);
  }
  const changes = treeChanges(treeOf(repo, amend ? (old.parents[0] ?? null) : headId), repo.index);
  if (!amend && !changes.length && !repo.merge && !allowEmpty)
    return failure(state, statusLines(s, { forCommit: true }), { kind: 'nothing-to-commit' });
  const pending = op?.message ?? null;
  if (message === null && !(amend && noEdit) && pending === null)
    return failure(state, 'Aborting commit due to empty commit message.', { kind: 'no-editor', amend });
  const text = cleanupMessage(message ?? (amend ? old.message : pending));
  if (!text) return failure(state, 'Aborting commit due to empty commit message.');

  const merging = repo.merge;
  const replay = repo.pick ?? repo.rebase; // porte l'auteur et la date du commit d'origine
  const branch = currentBranch(repo);
  const created = createCommit(repo, {
    message: text,
    parents: amend ? [...old.parents] : [headId, merging?.theirs].filter(Boolean),
    tree: repo.index,
    author: amend ? old.author : (replay?.author ?? s.user),
    timestamp: amend ? old.timestamp : (replay?.timestamp ?? env.now()),
    lane: amend ? old.lane : repo.rebase ? repo.rebase.branch : branch,
    env,
  });
  moveHead(repo, created.id);
  repo.merge = null;
  if (repo.pick) {
    if (repo.pick.todo.length) Object.assign(repo.pick, { id: null, message: null, conflicts: {} });
    else repo.pick = null;
  }
  if (repo.rebase) Object.assign(repo.rebase, { current: null, message: null, conflicts: {} });
  const where = branch ? `${branch}${created.parents.length ? '' : ' (root-commit)'}` : 'detached HEAD';
  const out = [`[${where} ${created.id}] ${subject(created)}`];
  if (amend || replay?.timestamp != null) out.push(` Date: ${gitDate(created.timestamp)}`);
  if (!merging) out.push(...summaryLines(changes));
  return success(s, out, {
    kind: 'commit',
    id: created.id,
    branch,
    parent: created.parents[0] ?? null,
    merged: merging ? merging.label : null,
    autoStaged,
    files: changes.length,
    amend,
    old: old?.id ?? null,
  });
}

/* ------------------------------------------------------------------ git log */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function gitDate(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const zone = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${time} ${d.getFullYear()} ${zone}`;
}

function decoration(repo, id) {
  const items = [];
  const current = currentBranch(repo);
  const at = (refs) =>
    Object.keys(refs)
      .filter((name) => refs[name] === id)
      .sort(byteOrder)
      .reverse();
  if (headCommitId(repo) === id)
    items.push(
      current
        ? [
            ['HEAD -> ', 'cyan bold'],
            [current, 'green bold'],
          ]
        : [['HEAD', 'cyan bold']],
    );
  for (const name of at(repo.tags)) items.push([[`tag: ${name}`, 'yellow bold']]);
  for (const name of at(repo.remoteRefs)) items.push([[name, 'red bold']]);
  for (const name of at(repo.branches)) if (name !== current) items.push([[name, 'green bold']]);
  if (!items.length) return [];
  return [[' (', 'yellow'], ...items.flatMap((item, i) => (i ? [[', ', 'yellow'], ...item] : item)), [')', 'yellow']];
}

const dateOrder = (repo, tips) =>
  [...ancestors(repo, ...tips)].sort((a, b) => repo.commits[b].seq - repo.commits[a].seq);

/** Ordre topologique de `git log --graph` : une lignée est affichée en entier avant de passer à la suivante. */
function topoOrder(repo, tips) {
  const all = ancestors(repo, ...tips);
  const children = new Map([...all].map((id) => [id, 0]));
  for (const id of all) for (const p of repo.commits[id].parents) children.set(p, children.get(p) + 1);
  const stack = [...new Set(tips)]
    .filter((id) => children.get(id) === 0)
    .sort((a, b) => repo.commits[a].seq - repo.commits[b].seq);
  const order = [];
  while (stack.length) {
    const id = stack.pop();
    order.push(id);
    for (const p of repo.commits[id].parents) {
      children.set(p, children.get(p) - 1);
      if (children.get(p) === 0) stack.push(p);
    }
  }
  return order;
}

/** Dessin ASCII façon `git log --graph` : une colonne par lignée en cours d'affichage. */
function asciiGraph(repo, order) {
  let columns = [];
  const draw = (width, marks) => {
    const chars = Array(width).fill(' ');
    for (const [pos, ch] of marks) chars[pos] = ch;
    return chars.join('');
  };
  return order.map((id) => {
    let idx = columns.indexOf(id);
    if (idx === -1) idx = columns.push(id) - 1;
    const parents = repo.commits[id].parents;
    let next = [...columns];
    next.splice(idx, 1, ...parents);
    const width = Math.max(columns.length, next.length, 1) * 2;
    const commitLine = draw(
      width,
      columns.map((_, i) => [2 * i, i === idx ? '*' : '|']),
    );
    let expand = null;
    if (parents.length > 1) {
      expand = draw(
        width,
        columns.flatMap((_, i) =>
          i < idx
            ? [[2 * i, '|']]
            : i === idx
              ? [
                  [2 * i, '|'],
                  [2 * i + 1, '\\'],
                ]
              : [[2 * i + 1, '\\']],
        ),
      );
    }
    const body = draw(
      width,
      next.map((_, i) => [2 * i, '|']),
    );
    const collapse = [];
    if (!parents.length && idx < columns.length - 1) {
      collapse.push(
        draw(
          width,
          columns.flatMap((_, i) => (i < idx ? [[2 * i, '|']] : i > idx ? [[2 * i - 1, '/']] : [])),
        ),
      );
    }
    for (;;) {
      const j = next.findIndex((c, k) => next.indexOf(c) < k);
      if (j === -1) break;
      collapse.push(
        draw(
          width,
          next.map((_, k) => (k < j ? [2 * k, '|'] : [2 * k - 1, '/'])),
        ),
      );
      next = next.filter((_, k) => k !== j);
    }
    columns = next;
    return { commitLine, expand, body, collapse };
  });
}

export function log(
  state,
  { oneline = false, graph = false, all = false, revs = [], maxCount = Infinity, paths = [], mergeOnly = false } = {},
) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  let tips = [];
  let keep = null; // commits autorisés, quand --merge restreint l'historique
  let filePaths = paths;
  if (mergeOnly) {
    // --merge : commits des deux côtés d'un conflit (HEAD...MERGE_HEAD) qui touchent un fichier en conflit
    const other = repo.merge?.theirs ?? repo.pick?.id ?? repo.rebase?.current ?? null;
    if (!other) return failure(state, 'fatal: --merge without MERGE_HEAD?');
    const mine = ancestors(repo, headCommitId(repo));
    const theirs = ancestors(repo, other);
    keep = new Set([...mine, ...theirs].filter((id) => !(mine.has(id) && theirs.has(id))));
    tips = [headCommitId(repo), other];
    filePaths = keysOf(conflictsOf(repo));
  } else if (all)
    tips = [
      ...Object.values(repo.branches),
      ...Object.values(repo.remoteRefs),
      ...Object.values(repo.tags),
      headCommitId(repo),
    ].filter(Boolean);
  else if (revs.length) {
    for (const rev of revs) {
      const id = resolveRevision(repo, rev);
      if (!id) {
        return failure(state, [
          `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
          "Use '--' to separate paths from revisions, like this:",
          "'git <command> [<revision>...] -- [<file>...]'",
        ]);
      }
      tips.push(id);
    }
  } else {
    const head = headCommitId(repo);
    if (!head) return failure(state, `fatal: your current branch '${repo.head.name}' does not have any commits yet`);
    tips = [head];
  }
  const touches = (id) => {
    const c = repo.commits[id];
    const parents = c.parents.length ? c.parents : [null];
    return parents.every((p) => filePaths.some((path) => get(c.tree, path) !== get(treeOf(repo, p), path)));
  };
  let order = graph ? topoOrder(repo, tips) : dateOrder(repo, tips);
  if (keep) order = order.filter((id) => keep.has(id));
  if (keep || filePaths.length) order = order.filter(touches);
  order = order.slice(0, maxCount);
  const rows = graph ? asciiGraph(repo, order) : null;
  const out = [];
  order.forEach((id, i) => {
    const c = repo.commits[id];
    const g = rows?.[i];
    const prefix = g ? [g.commitLine] : [];
    if (oneline) {
      out.push([...prefix, [id, 'yellow'], ...decoration(repo, id), ` ${subject(c)}`]);
      if (g) out.push(...(g.expand ? [g.expand] : []), ...g.collapse);
      return;
    }
    const body = [];
    if (c.parents.length > 1) body.push(`Merge: ${c.parents.join(' ')}`);
    body.push(`Author: ${c.author.name} <${c.author.email}>`, `Date:   ${gitDate(c.timestamp)}`, '');
    body.push(...c.message.split('\n').map((line) => (line ? `    ${line}` : '')));
    if (i < order.length - 1) body.push('');
    out.push([...prefix, [`commit ${c.hash}`, 'yellow'], ...decoration(repo, id)]);
    if (!g) {
      out.push(...body);
      return;
    }
    body.forEach((line, k) => out.push((k === 0 && g.expand ? g.expand : g.body) + line));
    out.push(...g.collapse);
  });
  return success(state, out, { kind: 'log', count: order.length, graph, mergeOnly, files: filePaths.length > 0 });
}

/* ------------------------------------------------------------------ git branch */

function addBranch(repo, name, id) {
  repo.branches[name] = id;
  if (!repo.lanes.includes(name)) repo.lanes.push(name);
  // Des commits faits en HEAD détachée rejoignent la ligne de la branche qui les « sauve ».
  for (let c = repo.commits[id]; c && c.lane === null; c = repo.commits[c.parents[0]]) c.lane = name;
}

export function branchList(state, { verbose = 0, remotes = false, all = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const current = currentBranch(repo);
  const level = Number(verbose);
  const entries = [];
  if (!remotes || all) {
    entries.push(
      ...Object.keys(repo.branches)
        .sort(byteOrder)
        .map((name) => ({ name, current: name === current, id: repo.branches[name] })),
    );
    if (repo.head.type === 'detached') {
      const { commit: at, from } = repo.head;
      entries.unshift({ name: `(HEAD detached ${at === from ? 'at' : 'from'} ${from})`, current: true, id: at });
    }
  }
  if (remotes || all) {
    entries.push(
      ...Object.keys(repo.remoteRefs)
        .sort(byteOrder)
        .map((ref) => ({ name: all ? `remotes/${ref}` : ref, remote: true, id: repo.remoteRefs[ref] })),
    );
  }
  const width = Math.max(0, ...entries.map((e) => e.name.length));
  const out = entries.map((e) => {
    const name = level ? e.name.padEnd(width) : e.name;
    const line = [e.current ? '* ' : '  ', e.current ? [name, 'green'] : e.remote ? [name, 'red'] : name];
    if (level) {
      const tracking = level > 1 && !e.remote && e.current !== undefined ? trackingInfo(repo, e.name) : null;
      const brief = tracking ? trackingBrief(tracking) : '';
      const label = tracking ? `[${tracking.upstream}${brief ? `: ${brief}` : ''}] ` : '';
      line.push(` ${e.id} ${label}${subject(repo.commits[e.id])}`);
    }
    return line;
  });
  return success(state, out, {
    kind: 'branch-list',
    count: Object.keys(repo.branches).length,
    current,
    remotes: remotes || all,
  });
}

export function branchCreate(state, { name, start = null }) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (!isValidBranchName(name)) return failure(state, `fatal: '${name}' is not a valid branch name`);
  if (hasOwn(repo.branches, name)) return failure(state, `fatal: a branch named '${name}' already exists`);
  const id = resolveRevision(repo, start ?? 'HEAD');
  if (!id) return failure(state, `fatal: not a valid object name: '${start ?? currentBranch(repo) ?? 'HEAD'}'`);
  const s = clone(state);
  addBranch(s.repo, name, id);
  const tracking = start !== null && hasOwn(repo.remoteRefs, start) ? start : null;
  if (tracking) s.repo.upstreams[name] = tracking;
  return success(s, tracking ? `branch '${name}' set up to track '${tracking}'.` : [], {
    kind: 'branch-create',
    name,
    id,
    current: currentBranch(repo),
    tracking,
  });
}

export function branchDelete(state, { names = [], force = false }) {
  const error = requireRepo(state);
  if (error) return error;
  if (!names.length) return failure(state, 'fatal: branch name required');
  const s = clone(state);
  const repo = s.repo;
  const headId = headCommitId(repo);
  const out = [];
  const deleted = [];
  let ok = true;
  for (const name of names) {
    if (!hasOwn(repo.branches, name)) {
      out.push(`error: branch '${name}' not found`);
      ok = false;
    } else if (name === currentBranch(repo)) {
      out.push(`error: cannot delete branch '${name}' used by worktree at '${REPO_PATH}'`);
      ok = false;
    } else if (!force && !(headId && isAncestor(repo, repo.branches[name], headId))) {
      out.push(
        `error: the branch '${name}' is not fully merged`,
        `hint: If you are sure you want to delete it, run 'git branch -D ${name}'`,
        'hint: Disable this message with "git config advice.forceDeleteBranch false"',
      );
      ok = false;
    } else {
      out.push(`Deleted branch ${name} (was ${repo.branches[name]}).`);
      delete repo.branches[name];
      delete repo.upstreams[name];
      deleted.push(name);
    }
  }
  return result(
    deleted.length ? s : state,
    out,
    ok,
    deleted.length ? { kind: 'branch-delete', names: deleted, force } : null,
  );
}

export function branchSetUpstream(state, { upstream = null, branch = null, unset = false }) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const name = branch ?? currentBranch(repo);
  if (!name) return failure(state, 'fatal: HEAD does not point to a branch');
  if (!hasOwn(repo.branches, name)) return failure(state, `fatal: branch '${name}' does not exist`);
  const s = clone(state);
  if (unset) {
    if (!hasOwn(repo.upstreams, name)) return failure(state, `fatal: Branch '${name}' has no upstream information`);
    delete s.repo.upstreams[name];
    return success(s, [], { kind: 'branch-unset-upstream', name });
  }
  if (!hasOwn(repo.remoteRefs, upstream)) {
    return failure(state, `fatal: the requested upstream branch '${upstream}' does not exist`);
  }
  s.repo.upstreams[name] = upstream;
  return success(s, `branch '${name}' set up to track '${upstream}'.`, { kind: 'branch-upstream', name, upstream });
}

/* ------------------------------------------------------------------ git checkout / switch */

const ACTION_VERB = {
  checkout: 'switch branches',
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
};

export function overwriteError(dirty, untracked, action) {
  if (dirty.length) {
    return [
      `error: Your local changes to the following files would be overwritten by ${action}:`,
      ...dirty.map((p) => `\t${p}`),
      `Please commit your changes or stash them before you ${ACTION_VERB[action]}.`,
      'Aborting',
    ];
  }
  return [
    `error: The following untracked working tree files would be overwritten by ${action}:`,
    ...untracked.map((p) => `\t${p}`),
    `Please move or remove them before you ${ACTION_VERB[action]}.`,
    'Aborting',
  ];
}

/**
 * Passe l'index et le répertoire de travail de l'arbre `from` à l'arbre `to`
 * en conservant, comme Git, les modifications locales qui ne gênent pas.
 * Renvoie null si tout va bien, sinon les lignes d'erreur (sans rien modifier).
 */
export function switchTree(s, from, to, action) {
  const { index } = s.repo;
  const wd = s.workdir;
  const paths = keysOf(from, to).filter((p) => get(from, p) !== get(to, p));
  const dirty = [];
  const untracked = [];
  for (const path of paths) {
    const base = get(from, path);
    const target = get(to, path);
    const inIndex = get(index, path);
    const inWd = get(wd, path);
    if (base === undefined && inIndex === undefined) {
      if (inWd !== undefined && inWd !== target) untracked.push(path);
    } else if (!(inIndex === base && inWd === base) && !(inIndex === target && inWd === target)) {
      dirty.push(path);
    }
  }
  if (dirty.length || untracked.length) return overwriteError(dirty, untracked, action);
  for (const path of paths) {
    const target = get(to, path);
    if (target === undefined) {
      delete index[path];
      delete wd[path];
    } else {
      index[path] = target;
      wd[path] = target;
    }
  }
  return null;
}

/**
 * Équivalent de `git reset --hard` vers `tree` sur `s` : l'index et les fichiers suivis prennent l'arbre,
 * les fichiers non suivis restent en place.
 */
export function resetToTree(s, tree) {
  const repo = s.repo;
  for (const path of keysOf(repo.index, tree, conflictsOf(repo))) {
    if (hasOwn(tree, path)) s.workdir[path] = tree[path];
    else delete s.workdir[path];
  }
  repo.index = { ...tree };
}

function localChangeLines(state) {
  const st = computeStatus(state);
  const codes = new Map();
  for (const e of [...st.staged, ...st.unstaged]) {
    if (!codes.has(e.path)) codes.set(e.path, e.kind === 'new' ? 'A' : e.kind === 'deleted' ? 'D' : 'M');
  }
  return [...codes].sort(([a], [b]) => byteOrder(a, b)).map(([path, code]) => `${code}\t${path}`);
}

function leavingDetachedLines(repo, oldId) {
  const kept = reachableCommits(repo);
  const lost = [...ancestors(repo, oldId)]
    .filter((id) => !kept.has(id))
    .sort((a, b) => repo.commits[b].seq - repo.commits[a].seq);
  if (!lost.length) return [`Previous HEAD position was ${shortLine(repo, oldId)}`];
  const one = lost.length === 1;
  const shown = lost.length > 5 ? lost.slice(0, 4) : lost;
  return [
    `Warning: you are leaving ${plural(lost.length, 'commit')} behind, not connected to`,
    'any of your branches:',
    '',
    ...shown.map((id) => `  ${shortLine(repo, id)}`),
    ...(lost.length > 5 ? [` ... and ${lost.length - 4} more.`] : []),
    '',
    `If you want to keep ${one ? 'it' : 'them'} by creating a new branch, this may be a good time`,
    'to do so with:',
    '',
    ` git branch <new-branch-name> ${lost[0]}`,
    '',
  ];
}

const detachedAdvice = (rev) => [
  `Note: switching to '${rev}'.`,
  '',
  "You are in 'detached HEAD' state. You can look around, make experimental",
  'changes and commit them, and you can discard any commits you make in this',
  'state without impacting any branches by switching back to a branch.',
  '',
  'If you want to create a new branch to retain commits you create, you may',
  'do so (now or later) by using -c with the switch command. Example:',
  '',
  '  git switch -c <new-branch-name>',
  '',
  'Or undo this operation with:',
  '',
  '  git switch -',
  '',
  'Turn off this advice by setting config variable advice.detachedHead to false',
  '',
];

function mergeInProgressError(repo) {
  const op = operationInProgress(repo);
  if (!op) return null;
  const unmerged = keysOf(conflictsOf(repo));
  if (unmerged.length)
    return ['error: you need to resolve your current index first', ...unmerged.map((p) => `${p}: needs merge`)];
  return [`fatal: cannot switch branch while ${op.verb}`, `Consider "git ${op.name} --quit" or "git worktree add".`];
}

/** Déplace HEAD vers une branche ({ branch }) ou un commit ({ commit }). */
function moveHeadTo(state, target, { created = false, startId = null, rev = null, advice = true } = {}) {
  const guard = mergeInProgressError(state.repo);
  if (guard) return failure(state, guard);
  const s = clone(state);
  const repo = s.repo;
  const oldHead = repo.head;
  const oldId = headCommitId(repo);
  const newId = target.branch ? (created ? startId : repo.branches[target.branch]) : target.commit;
  const error = switchTree(s, treeOf(repo, oldId), treeOf(repo, newId), 'checkout');
  if (error) return failure(state, error);

  repo.previousHead =
    oldHead.type === 'branch' ? { type: 'branch', name: oldHead.name } : { type: 'detached', commit: oldId };
  if (target.branch) {
    if (created && startId) addBranch(repo, target.branch, startId);
    else if (created && !repo.lanes.includes(target.branch)) repo.lanes.push(target.branch);
    repo.head = { type: 'branch', name: target.branch };
  } else {
    repo.head = { type: 'detached', commit: newId, from: newId };
  }

  const out = localChangeLines(s);
  if (oldHead.type === 'detached' && oldId !== newId) out.push(...leavingDetachedLines(repo, oldId));
  if (target.branch) {
    out.push(created ? `Switched to a new branch '${target.branch}'` : `Switched to branch '${target.branch}'`);
    if (!created) out.push(...branchTrackingLines(repo, target.branch));
    return success(s, out, { kind: created ? 'switch-create' : 'switch', branch: target.branch, id: newId });
  }
  if (advice && oldHead.type === 'branch') out.push(...detachedAdvice(rev));
  out.push(`HEAD is now at ${shortLine(repo, newId)}`);
  return success(s, out, { kind: 'detach', id: newId });
}

function switchToBranch(state, name) {
  if (name === currentBranch(state.repo)) {
    return success(
      state,
      [...localChangeLines(state), `Already on '${name}'`, ...branchTrackingLines(state.repo, name)],
      {
        kind: 'already-on',
        branch: name,
      },
    );
  }
  return moveHeadTo(state, { branch: name });
}

function createAndSwitch(state, name, start, mode) {
  const repo = state.repo;
  if (!isValidBranchName(name)) return failure(state, `fatal: '${name}' is not a valid branch name`);
  if (hasOwn(repo.branches, name)) return failure(state, `fatal: a branch named '${name}' already exists`);
  let startId = headCommitId(repo);
  if (start !== null) {
    startId = resolveRevision(repo, start);
    if (!startId) {
      return failure(
        state,
        mode === 'switch'
          ? `fatal: invalid reference: ${start}`
          : `fatal: '${start}' is not a commit and a branch '${name}' cannot be created from it`,
      );
    }
  }
  const res = moveHeadTo(state, { branch: name }, { created: true, startId });
  if (res.ok && start !== null && hasOwn(repo.remoteRefs, start)) {
    res.state.repo.upstreams[name] = start;
    res.out = [`branch '${name}' set up to track '${start}'.`, ...res.out];
    res.info = { ...res.info, tracking: start };
  }
  return res;
}

/** `git checkout feature` crée une branche locale qui suit origin/feature si elle existe côté distant. */
function remoteBranchFor(repo, name) {
  const refs = Object.keys(repo.remoteRefs).filter((ref) => ref.slice(ref.indexOf('/') + 1) === name);
  return refs.length === 1 ? refs[0] : null;
}

function switchToPrevious(state, mode) {
  const previous = state.repo.previousHead;
  if (previous?.type === 'branch' && hasOwn(state.repo.branches, previous.name))
    return switchToBranch(state, previous.name);
  if (previous?.type === 'detached' && hasOwn(state.repo.commits, previous.commit)) {
    return moveHeadTo(state, { commit: previous.commit }, { rev: previous.commit, advice: mode === 'checkout' });
  }
  return failure(state, 'fatal: invalid reference: @{-1}');
}

function checkoutPaths(state, paths, quiet = false) {
  const repo = state.repo;
  const conflicts = conflictsOf(repo);
  const targets = paths.includes('.') ? keysOf(repo.index) : paths;
  for (const path of targets) {
    if (hasOwn(conflicts, path)) return failure(state, `error: path '${path}' is unmerged`);
    if (!hasOwn(repo.index, path))
      return failure(state, `error: pathspec '${path}' did not match any file(s) known to git`);
  }
  const s = clone(state);
  const restored = targets.filter((p) => s.workdir[p] !== repo.index[p]);
  for (const path of restored) s.workdir[path] = repo.index[path];
  return success(s, quiet ? [] : `Updated ${plural(restored.length, 'path')} from the index`, {
    kind: 'restore',
    paths: restored,
  });
}

/** Versions « ours » (HEAD) et « theirs » (l'autre côté) d'un conflit en cours. */
function conflictSides(repo) {
  let theirs = null;
  if (repo.merge) theirs = treeOf(repo, repo.merge.theirs);
  else if (repo.pick) theirs = repo.pick.theirsTree;
  else if (repo.rebase?.current) theirs = treeOf(repo, repo.rebase.current);
  return { ours: treeOf(repo, headCommitId(repo)), theirs };
}

const notFoundPath = (path) => `error: pathspec '${path}' did not match any file(s) known to git`;

/**
 * Remet des fichiers dans l'état d'un commit, de l'index ou d'un côté d'un conflit.
 *   source : commit à lire (sinon l'index pour le répertoire de travail, HEAD pour l'index) ;
 *   staged / worktree : zones à écraser ; side : 'ours' ou 'theirs' (répertoire de travail seulement) ;
 *   from : texte de « Updated N paths from … », utilisé par git checkout.
 */
export function restorePaths(
  state,
  { paths, source = null, staged = false, worktree = true, side = null, from = null },
) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (!paths.length) return failure(state, 'fatal: you must specify path(s) to restore');
  const conflicts = conflictsOf(repo);
  let tree;
  if (side) tree = conflictSides(repo)[side] ?? {};
  else if (source !== null) {
    const id = resolveRevision(repo, source);
    if (!id) return failure(state, `fatal: could not resolve ${source}`);
    tree = treeOf(repo, id);
  } else tree = staged ? treeOf(repo, headCommitId(repo)) : repo.index;

  const tracked = keysOf(repo.index, tree);
  const targets = paths.includes('.') ? tracked : paths;
  for (const path of targets) {
    if (side) {
      if (!hasOwn(conflicts, path) && !hasOwn(repo.index, path)) return failure(state, notFoundPath(path));
      continue;
    }
    if (hasOwn(conflicts, path)) return failure(state, `error: path '${path}' is unmerged`);
    if (!hasOwn(tree, path) && !(staged && hasOwn(repo.index, path))) return failure(state, notFoundPath(path));
  }
  const s = clone(state);
  const changed = [];
  for (const path of targets) {
    if (side && !hasOwn(conflicts, path)) continue;
    const content = get(tree, path);
    if (side && content === undefined) {
      return failure(state, `error: path '${path}' does not have ${side === 'ours' ? 'our' : 'their'} version`);
    }
    let moved = false;
    if (worktree && get(s.workdir, path) !== content) {
      if (content === undefined) delete s.workdir[path];
      else s.workdir[path] = content;
      moved = true;
    }
    if (staged && get(s.repo.index, path) !== content) {
      if (content === undefined) delete s.repo.index[path];
      else s.repo.index[path] = content;
      moved = true;
    }
    if (moved) changed.push(path);
  }
  const out = from === null ? [] : [`Updated ${plural(changed.length, 'path')} from ${from}`];
  return success(s, out, { kind: 'restore', paths: changed, staged, worktree, source, side });
}

export function checkout(state, { target = null, newBranch = null, paths = [], detach = false, quiet = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (paths.length) return checkoutPaths(state, paths, quiet);
  if (newBranch !== null) return createAndSwitch(state, newBranch, target, 'checkout');
  if (target === null || target === 'HEAD') return success(state, localChangeLines(state));
  if (target === '-') return switchToPrevious(state, 'checkout');
  if (!detach && hasOwn(repo.branches, target)) return switchToBranch(state, target);
  const tracked = detach ? null : remoteBranchFor(repo, target);
  if (tracked) return createAndSwitch(state, target, tracked, 'checkout');
  const id = resolveRevision(repo, target);
  if (id) return moveHeadTo(state, { commit: id }, { rev: target, advice: !detach });
  if (hasOwn(repo.index, target)) return checkoutPaths(state, [target]);
  return failure(state, `error: pathspec '${target}' did not match any file(s) known to git`);
}

export function switchBranch(state, { target = null, create = null, detach = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (create !== null) return createAndSwitch(state, create, target, 'switch');
  if (detach) {
    const id = resolveRevision(repo, target ?? 'HEAD');
    if (!id) return failure(state, `fatal: invalid reference: ${target ?? 'HEAD'}`);
    return moveHeadTo(state, { commit: id }, { rev: target, advice: false });
  }
  if (target === null) return failure(state, 'fatal: missing branch or commit argument');
  if (target === '-') return switchToPrevious(state, 'switch');
  if (hasOwn(repo.branches, target)) return switchToBranch(state, target);
  const tracked = remoteBranchFor(repo, target);
  if (tracked) return createAndSwitch(state, target, tracked, 'switch');
  if (resolveRevision(repo, target)) {
    return failure(state, [
      `fatal: a branch is expected, got commit '${target}'`,
      'hint: If you want to detach HEAD at the commit, try again with the --detach option.',
    ]);
  }
  return failure(state, `fatal: invalid reference: ${target}`);
}

/* ------------------------------------------------------------------ git merge */

function conflictMarkers(ours, theirs, label, oursLabel = 'HEAD') {
  const a = splitLines(ours);
  const b = splitLines(theirs);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return (
    [
      ...a.slice(0, pre),
      `<<<<<<< ${oursLabel}`,
      ...a.slice(pre, a.length - suf),
      '=======',
      ...b.slice(pre, b.length - suf),
      `>>>>>>> ${label}`,
      ...a.slice(a.length - suf),
    ].join('\n') + '\n'
  );
}

function defaultMergeMessage(repo, target, into) {
  const what = hasOwn(repo.branches, target) ? `branch '${target}'` : `commit '${target}'`;
  return `Merge ${what}${into && into !== 'main' && into !== 'master' ? ` into ${into}` : ''}`;
}

function fastForward(state, theirs, target, into) {
  const s = clone(state);
  const repo = s.repo;
  const ours = headCommitId(repo);
  const error = switchTree(s, treeOf(repo, ours), treeOf(repo, theirs), 'merge');
  if (error) return failure(state, error);
  moveHead(repo, theirs);
  const changes = treeChanges(treeOf(repo, ours), treeOf(repo, theirs));
  const out = [
    ...(ours ? [`Updating ${ours}..${theirs}`] : []),
    'Fast-forward',
    ...diffstatLines(changes),
    ...summaryLines(changes),
  ];
  return success(s, out, { kind: 'merge-ff', target, into, from: ours, to: theirs });
}

/**
 * Fusion à trois voies de trois arbres : renvoie les fichiers fusionnés, les conflits (avec leur type et le
 * contenu à écrire, marqueurs compris) et les messages « Auto-merging / CONFLICT » de Git.
 * `label` nomme le côté « theirs » dans les marqueurs et les messages.
 */
export function mergeTrees3(baseTree, oursTree, theirsTree, label, { oursLabel = 'HEAD' } = {}) {
  const merged = {};
  const conflicts = {};
  const conflictContent = {};
  const notes = [];
  for (const path of keysOf(baseTree, oursTree, theirsTree)) {
    const b = get(baseTree, path);
    const o = get(oursTree, path);
    const t = get(theirsTree, path);
    if (o === t || t === b) {
      if (o !== undefined) merged[path] = o;
    } else if (o === b) {
      if (t !== undefined) merged[path] = t;
    } else if (o !== undefined && t !== undefined) {
      conflicts[path] = b === undefined ? 'both added' : 'both modified';
      conflictContent[path] = conflictMarkers(o, t, label, oursLabel);
      notes.push(
        `Auto-merging ${path}`,
        `CONFLICT (${b === undefined ? 'add/add' : 'content'}): Merge conflict in ${path}`,
      );
    } else {
      conflicts[path] = o === undefined ? 'deleted by us' : 'deleted by them';
      conflictContent[path] = o ?? t;
      notes.push(
        o === undefined
          ? `CONFLICT (modify/delete): ${path} deleted in ${oursLabel} and modified in ${label}.  Version ${label} of ${path} left in tree.`
          : `CONFLICT (modify/delete): ${path} deleted in ${label} and modified in ${oursLabel}.  Version ${oursLabel} of ${path} left in tree.`,
      );
    }
  }
  return { merged, conflicts, conflictContent, notes };
}

/**
 * Écrit le résultat d'une fusion dans l'index et le répertoire de travail de `s` (copie modifiable).
 * Refuse, sans rien toucher, d'écraser une modification locale ou un fichier non suivi.
 * Renvoie { error } ou { saved } (l'index et le répertoire de travail d'avant, pour pouvoir annuler).
 */
export function writeMerge(s, oursTree, { merged, conflictContent }, action = 'merge') {
  const repo = s.repo;
  const touched = keysOf(oursTree, merged, conflictContent).filter(
    (p) => hasOwn(conflictContent, p) || get(merged, p) !== get(oursTree, p),
  );
  const dirty = touched.filter((p) => hasOwn(oursTree, p) && get(s.workdir, p) !== oursTree[p]);
  const untracked = touched.filter((p) => !hasOwn(oursTree, p) && hasOwn(s.workdir, p));
  if (dirty.length || untracked.length) return { error: overwriteError(dirty, untracked, action) };

  const saved = { index: clone(repo.index), workdir: clone(s.workdir) };
  for (const path of touched) {
    if (hasOwn(conflictContent, path)) {
      s.workdir[path] = conflictContent[path];
      if (hasOwn(oursTree, path)) repo.index[path] = oursTree[path];
      else delete repo.index[path];
    } else if (hasOwn(merged, path)) {
      repo.index[path] = merged[path];
      s.workdir[path] = merged[path];
    } else {
      delete repo.index[path];
      delete s.workdir[path];
    }
  }
  return { saved };
}

function threeWayMerge(state, ours, theirs, target, into, message, env) {
  const staged = computeStatus(state).staged;
  if (staged.length) {
    return failure(state, [
      'error: Your local changes to the following files would be overwritten by merge:',
      ...staged.map((e) => `\t${e.path}`),
      'Please commit your changes or stash them before you merge.',
      'Aborting',
    ]);
  }
  const s = clone(state);
  const repo = s.repo;
  const oursTree = treeOf(repo, ours);
  const theirsTree = treeOf(repo, theirs);
  const outcome = mergeTrees3(treeOf(repo, mergeBase(repo, ours, theirs)), oursTree, theirsTree, target);
  const { conflicts, notes } = outcome;
  const written = writeMerge(s, oursTree, outcome);
  if (written.error) return failure(state, written.error);
  const { saved } = written;
  const text = message ?? defaultMergeMessage(repo, target, into);
  if (Object.keys(conflicts).length) {
    repo.merge = { theirs, label: target, message: text, conflicts, saved };
    return failure(s, [...notes, 'Automatic merge failed; fix conflicts and then commit the result.'], {
      kind: 'merge-conflict',
      paths: keysOf(conflicts),
      target,
      into,
    });
  }
  const created = createCommit(repo, { message: text, parents: [ours, theirs], tree: repo.index, author: s.user, env });
  moveHead(repo, created.id);
  const changes = treeChanges(oursTree, created.tree);
  return success(s, ["Merge made by the 'ort' strategy.", ...diffstatLines(changes), ...summaryLines(changes)], {
    kind: 'merge-commit',
    id: created.id,
    target,
    into,
  });
}

export function merge(
  state,
  { target = null, noFF = false, ffOnly = false, message = null, abort = false } = {},
  env = defaultEnv,
) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (abort) {
    if (!repo.merge) return failure(state, 'fatal: There is no merge to abort (MERGE_HEAD missing).');
    const s = clone(state);
    s.repo.index = s.repo.merge.saved.index;
    s.workdir = s.repo.merge.saved.workdir;
    s.repo.merge = null;
    return success(s, [], { kind: 'merge-abort' });
  }
  if (repo.pick || repo.rebase) {
    const op = operationInProgress(repo);
    return failure(state, [
      `fatal: You have not concluded your ${op.noun} (${op.head} exists).`,
      'Please, commit your changes before you merge.',
    ]);
  }
  if (repo.merge) {
    return failure(
      state,
      Object.keys(repo.merge.conflicts).length
        ? ['error: Merging is not possible because you have unmerged files.', ...UNMERGED_COMMIT_ERROR.slice(1)]
        : [
            'fatal: You have not concluded your merge (MERGE_HEAD exists).',
            'Please, commit your changes before you merge.',
          ],
    );
  }
  if (target === null) return failure(state, 'fatal: No remote for the current branch.');
  const theirs = resolveRevision(repo, target);
  if (!theirs) return failure(state, `merge: ${target} - not something we can merge`);
  const ours = headCommitId(repo);
  const into = currentBranch(repo);
  if (ours && isAncestor(repo, theirs, ours))
    return success(state, 'Already up to date.', { kind: 'merge-uptodate', target, into });
  if (!ours || (isAncestor(repo, ours, theirs) && !noFF)) return fastForward(state, theirs, target, into);
  if (ffOnly) return failure(state, 'fatal: Not possible to fast-forward, aborting.');
  return threeWayMerge(state, ours, theirs, target, into, message, env);
}

/* ------------------------------------------------------------------ git diff */

/** Résout les arguments de révision de git diff : `A`, `B`, `A..B` ou `A...B` (depuis l'ancêtre commun). */
function diffRevisions(repo, revs) {
  const ids = [];
  for (const rev of revs) {
    const range = /^(.*?)(\.{2,3})(.*)$/.exec(rev);
    const parts = range ? [range[1] || 'HEAD', range[3] || 'HEAD'] : [rev];
    const resolved = [];
    for (const part of parts) {
      const id = resolveRevision(repo, part);
      if (!id) return { error: [`fatal: bad revision '${rev}'`] };
      resolved.push(id);
    }
    if (range?.[2] === '...') resolved[0] = mergeBase(repo, resolved[0], resolved[1]) ?? resolved[0];
    ids.push(...resolved);
  }
  if (ids.length > 2) return { error: ['fatal: too many revisions: a diff compares at most two commits'] };
  return { ids };
}

const NAME_STATUS = (c) => (c.before === undefined ? 'A' : c.after === undefined ? 'D' : 'M');

/**
 * git diff : répertoire de travail ↔ index (défaut), index ↔ HEAD (--staged), ou entre commits.
 * `revs` : 0 (défaut), 1 (commit ↔ répertoire de travail, ou ↔ index avec --staged) ou 2 révisions.
 * `format` : 'patch', 'stat', 'name-only' ou 'name-status'.
 */
export function diff(state, { staged = false, paths = [], revs = [], format = 'patch' } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const head = treeOf(repo, headCommitId(repo));
  const resolved = diffRevisions(repo, revs);
  if (resolved.error) return failure(state, resolved.error);
  const trees = resolved.ids.map((id) => treeOf(repo, id));
  for (const path of paths) {
    if (![state.workdir, repo.index, head, ...trees].some((tree) => hasOwn(tree, path))) {
      return failure(state, [
        `fatal: ambiguous argument '${path}': unknown revision or path not in the working tree.`,
        "Use '--' to separate paths from revisions, like this:",
        "'git <command> [<revision>...] -- [<file>...]'",
      ]);
    }
  }
  const conflicts = conflictsOf(repo);
  const tracked = Object.fromEntries(
    keysOf(repo.index)
      .filter((p) => hasOwn(state.workdir, p))
      .map((p) => [p, state.workdir[p]]),
  );
  let before;
  let after;
  if (trees.length === 2) [before, after] = trees;
  else if (trees.length === 1) [before, after] = [trees[0], staged ? repo.index : tracked];
  else [before, after] = staged ? [head, repo.index] : [repo.index, tracked];
  const changes = treeChanges(before, after).filter(
    (c) => (trees.length === 2 || !hasOwn(conflicts, c.path)) && (!paths.length || paths.includes(c.path)),
  );
  const unmerged = trees.length ? [] : keysOf(conflicts).filter((p) => !paths.length || paths.includes(p));
  let out;
  if (format === 'name-only') out = changes.map((c) => c.path);
  else if (format === 'name-status') out = changes.map((c) => `${NAME_STATUS(c)}\t${c.path}`);
  else if (format === 'stat') out = [...diffstatLines(changes), ...summaryLines(changes, { modes: false })];
  else out = [...unmerged.map((p) => `* Unmerged path ${p}`), ...changes.flatMap(fileDiffLines)];
  return success(state, out, { kind: 'diff', staged, empty: !out.length, revs: trees.length, format });
}

/* ------------------------------------------------------------------ git rm / check-ignore */

export function rmTracked(state, { paths = [], cached = false, force = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  if (!paths.length) return failure(state, 'fatal: No pathspec was given. Which files should I remove?');
  const repo = state.repo;
  const conflicts = conflictsOf(repo);
  const head = treeOf(repo, headCommitId(repo));
  const targets = [];
  for (const path of paths) {
    if (!hasOwn(repo.index, path) && !hasOwn(conflicts, path))
      return failure(state, `fatal: pathspec '${path}' did not match any files`);
    targets.push(path);
  }
  if (!force) {
    const both = [];
    const stagedOnly = [];
    const modified = [];
    for (const path of targets) {
      if (hasOwn(conflicts, path)) continue;
      const inHead = get(head, path);
      const inIndex = get(repo.index, path);
      const inWorkdir = get(state.workdir, path);
      const isStaged = inIndex !== inHead;
      const isModified = inWorkdir !== undefined && inWorkdir !== inIndex;
      if (cached) {
        if (isStaged && inIndex !== inWorkdir) both.push(path);
      } else if (isStaged && isModified) both.push(path);
      else if (isStaged) stagedOnly.push(path);
      else if (isModified) modified.push(path);
    }
    const list = (paths) => paths.map((p) => `    ${p}`);
    const out = [];
    if (both.length)
      out.push(
        `error: the following file${both.length > 1 ? 's have' : ' has'} staged content different from both the`,
        'file and the HEAD:',
        ...list(both),
        '(use -f to force removal)',
      );
    if (stagedOnly.length)
      out.push(
        `error: the following file${stagedOnly.length > 1 ? 's have' : ' has'} changes staged in the index:`,
        ...list(stagedOnly),
        '(use --cached to keep the file, or -f to force removal)',
      );
    if (modified.length)
      out.push(
        `error: the following file${modified.length > 1 ? 's have' : ' has'} local modifications:`,
        ...list(modified),
        '(use --cached to keep the file, or -f to force removal)',
      );
    if (out.length) return failure(state, out, { kind: 'git-rm-refused' });
  }
  const s = clone(state);
  for (const path of targets) {
    delete s.repo.index[path];
    if (!cached) delete s.workdir[path];
    const op = s.repo.merge ?? s.repo.pick ?? s.repo.rebase;
    if (op) delete op.conflicts[path];
  }
  return success(
    s,
    targets.map((p) => `rm '${p}'`),
    { kind: 'git-rm', paths: targets, cached },
  );
}

export function checkIgnore(state, { paths = [], verbose = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  if (!paths.length) return failure(state, 'fatal: no path specified');
  const out = [];
  for (const path of paths) {
    const rule = hasOwn(state.repo.index, path) ? null : ignoreMatch(state.workdir, path);
    if (rule) out.push(verbose ? `.gitignore:${rule.line}:${rule.text}\t${path}` : path);
  }
  return result(state, out, out.length > 0, { kind: 'check-ignore', count: out.length });
}

/* ------------------------------------------------------------------ git config */

// Seules ces clés sont simulées ; les valeurs autorisées sont listées quand elles sont contraintes.
export const CONFIG_KEYS = {
  'user.name': null,
  'user.email': null,
  'pull.rebase': ['true', 'false'],
  'pull.ff': ['only', 'true', 'false'],
};

function configEntries(state) {
  const entries = [
    ['user.name', state.user.name],
    ['user.email', state.user.email],
    ['init.defaultbranch', DEFAULT_BRANCH],
    ...Object.entries(state.config),
  ];
  const repo = state.repo;
  if (repo) {
    entries.push(['core.repositoryformatversion', '0'], ['core.bare', 'false']);
    for (const name of Object.keys(repo.remotes).sort(byteOrder)) {
      entries.push(
        [`remote.${name}.url`, repo.remotes[name].url],
        [`remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`],
      );
    }
    for (const branch of Object.keys(repo.upstreams).sort(byteOrder)) {
      const ref = repo.upstreams[branch];
      const slash = ref.indexOf('/');
      entries.push(
        [`branch.${branch}.remote`, ref.slice(0, slash)],
        [`branch.${branch}.merge`, `refs/heads/${ref.slice(slash + 1)}`],
      );
    }
  }
  return entries;
}

export function config(state, { key = null, value = null, list = false, global = false } = {}) {
  if (list)
    return success(
      state,
      configEntries(state).map(([k, v]) => `${k}=${v}`),
      { kind: 'config-list' },
    );
  const name = key.toLowerCase();
  if (value === null) {
    const found = configEntries(state).find(([k]) => k === name);
    return found ? success(state, [found[1]], { kind: 'config-get', key: name }) : failure(state, []);
  }
  if (!global && !state.repo) return failure(state, 'fatal: not in a git directory');
  const allowed = CONFIG_KEYS[name];
  if (allowed && !allowed.includes(value.toLowerCase())) {
    return failure(state, `fatal: bad boolean config value '${value}' for '${name}'`);
  }
  const s = clone(state);
  if (name === 'user.name') s.user.name = value;
  else if (name === 'user.email') s.user.email = value;
  else s.config[name] = value.toLowerCase();
  return success(s, [], { kind: 'config-set', key: name, value });
}
