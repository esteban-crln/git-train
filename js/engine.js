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

// Prévues par l'architecture (état réservé : tags, stash, remotes), pas encore simulées.
export const PLANNED_COMMANDS = [
  'reset',
  'revert',
  'cherry-pick',
  'stash',
  'tag',
  'rebase',
  'remote',
  'fetch',
  'pull',
  'push',
  'clone',
];

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

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const get = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keysOf = (...objects) => [...new Set(objects.flatMap((o) => Object.keys(o)))].sort(byteOrder);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
const success = (state, out = [], info = null) => result(state, out, true, info);
const failure = (state, out, info = null) => result(state, out, false, info);
const requireRepo = (state) => (state.repo ? null : failure(state, NOT_A_REPO, { kind: 'not-a-repo' }));

/* ------------------------------------------------------------------ état */

export function createState() {
  return { version: STATE_VERSION, user: { ...DEFAULT_USER }, workdir: {}, repo: null };
}

function createRepo() {
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
    tags: {},
    stash: [],
    remotes: {},
  };
}

export function isValidState(s) {
  if (!isPlainObject(s) || s.version !== STATE_VERSION || !isStringMap(s.workdir) || !isPlainObject(s.user))
    return false;
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
  if (
    r.merge !== null &&
    !(isPlainObject(r.merge) && hasOwn(r.commits, r.merge.theirs) && isPlainObject(r.merge.conflicts))
  )
    return false;
  const h = r.head;
  if (!isPlainObject(h)) return false;
  if (h.type === 'branch') return typeof h.name === 'string';
  return h.type === 'detached' && hasOwn(r.commits, h.commit);
}

export const serialize = (state) => JSON.stringify(state);

export function deserialize(json) {
  try {
    const state = JSON.parse(json);
    if (isPlainObject(state?.repo)) {
      state.repo = { previousHead: null, merge: null, tags: {}, stash: [], remotes: {}, ...state.repo };
    }
    return isValidState(state) ? state : null;
  } catch {
    return null;
  }
}

/** Pile d'états pour « Annuler la dernière commande ». Les états étant immuables, on stocke des références. */
export class UndoStack {
  constructor(entries = [], limit = 50) {
    this.limit = limit;
    this.entries = (Array.isArray(entries) ? entries : []).filter((e) => e && isValidState(e.state)).slice(-limit);
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
const treeOf = (repo, id) => (id ? repo.commits[id].tree : {});
const shortLine = (repo, id) => `${id} ${subject(repo.commits[id])}`;

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

const isAncestor = (repo, ancestor, of) => ancestors(repo, of).has(ancestor);

function mergeBase(repo, a, b) {
  const fromA = ancestors(repo, a);
  let best = null;
  for (const id of ancestors(repo, b)) {
    if (fromA.has(id) && (!best || repo.commits[id].seq > repo.commits[best].seq)) best = id;
  }
  return best;
}

/** Commits accessibles depuis une référence ; les autres sont « orphelins ». */
export function reachableCommits(repo) {
  return ancestors(repo, ...Object.values(repo.branches), ...Object.values(repo.tags), headCommitId(repo));
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
  else if (hasOwn(repo.branches, base)) id = repo.branches[base];
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

/** Compare HEAD, l'index et le répertoire de travail (le cœur de `git status`). */
export function computeStatus(state) {
  const repo = state.repo;
  const head = treeOf(repo, headCommitId(repo));
  const { index } = repo;
  const wd = state.workdir;
  const conflicts = repo.merge?.conflicts ?? {};
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
  const untracked = keysOf(wd).filter((p) => !hasOwn(index, p) && !hasOwn(conflicts, p));
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

function treeChanges(from, to) {
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

function fileDiffLines({ path, before, after, ops }) {
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

function diffstatLines(changes) {
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

function summaryLines(changes) {
  if (!changes.length) return [];
  const ins = changes.reduce((n, c) => n + c.ins, 0);
  const del = changes.reduce((n, c) => n + c.del, 0);
  let line = ` ${plural(changes.length, 'file')} changed`;
  if (!ins && !del) line += ', 0 insertions(+), 0 deletions(-)';
  if (ins) line += `, ${plural(ins, 'insertion')}(+)`;
  if (del) line += `, ${plural(del, 'deletion')}(-)`;
  const out = [line];
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
  if (repo.head.type === 'branch') return `On branch ${repo.head.name}`;
  const { commit: at, from } = repo.head;
  return [[`HEAD detached ${at === from ? 'at' : 'from'} ${from}`, 'red']];
}

function statusLines(state, { forCommit = false } = {}) {
  const repo = state.repo;
  const st = computeStatus(state);
  const initial = !headCommitId(repo);
  const out = [headLine(repo)];
  if (repo.merge) {
    if (st.unmerged.length)
      out.push(
        'You have unmerged paths.',
        '  (fix conflicts and run "git commit")',
        '  (use "git merge --abort" to abort the merge)',
        '',
      );
    else out.push('All conflicts fixed but you are still merging.', '  (use "git commit" to conclude merge)', '');
  }
  if (initial) out.push('', forCommit ? 'Initial commit' : 'No commits yet', '');
  if (st.staged.length) {
    out.push('Changes to be committed:');
    if (!repo.merge)
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
    else out.push(['## ', [repo.head.name, 'green']]);
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

export function add(state, { paths = [], all = false } = {}) {
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
  const conflicts = repo.merge?.conflicts ?? {};
  const everything = () => keysOf(s.workdir, repo.index, conflicts);
  const targets = new Set(all ? everything() : []);
  for (const spec of paths) {
    if (spec === '.' || spec === ':/') everything().forEach((p) => targets.add(p));
    else if (hasOwn(s.workdir, spec) || hasOwn(repo.index, spec) || hasOwn(conflicts, spec)) targets.add(spec);
    else return failure(state, `fatal: pathspec '${spec}' did not match any files`);
  }
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
  return success(s, [], { kind: 'add', staged, resolved });
}

/* ------------------------------------------------------------------ git commit */

function cleanupMessage(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function createCommit(repo, { message, parents, tree, author, env }) {
  let hash;
  do hash = env.randomHex(40);
  while (hasOwn(repo.commits, hash.slice(0, 7)));
  const lane = currentBranch(repo);
  const created = {
    id: hash.slice(0, 7),
    hash,
    message,
    parents,
    author: { name: author.name, email: author.email },
    timestamp: env.now(),
    tree: { ...tree },
    lane,
    seq: ++repo.seq,
  };
  repo.commits[created.id] = created;
  if (lane && !repo.lanes.includes(lane)) repo.lanes.push(lane);
  return created;
}

function moveHead(repo, id) {
  if (repo.head.type === 'branch') repo.branches[repo.head.name] = id;
  else repo.head.commit = id;
}

const UNMERGED_COMMIT_ERROR = [
  'error: Committing is not possible because you have unmerged files.',
  "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
  'hint: as appropriate to mark resolution and make a commit.',
  'fatal: Exiting because of an unresolved conflict.',
];

export function commit(state, { message = null, all = false, allowEmpty = false } = {}, env = defaultEnv) {
  const error = requireRepo(state);
  if (error) return error;
  const s = clone(state);
  const repo = s.repo;
  const autoStaged = [];
  if (all) {
    for (const path of keysOf(repo.index, repo.merge?.conflicts ?? {})) {
      const before = get(repo.index, path);
      if (hasOwn(s.workdir, path)) repo.index[path] = s.workdir[path];
      else delete repo.index[path];
      if (repo.merge) delete repo.merge.conflicts[path];
      if (get(repo.index, path) !== before) autoStaged.push(path);
    }
  }
  if (repo.merge && Object.keys(repo.merge.conflicts).length) {
    return failure(state, [...UNMERGED_COMMIT_ERROR, ...keysOf(repo.merge.conflicts).map((p) => `U\t${p}`)]);
  }
  const parentId = headCommitId(repo);
  const changes = treeChanges(treeOf(repo, parentId), repo.index);
  if (!changes.length && !repo.merge && !allowEmpty)
    return failure(state, statusLines(s, { forCommit: true }), { kind: 'nothing-to-commit' });
  if (message === null && !repo.merge)
    return failure(state, 'Aborting commit due to empty commit message.', { kind: 'no-editor' });
  const text = cleanupMessage(message ?? repo.merge.message);
  if (!text) return failure(state, 'Aborting commit due to empty commit message.');

  const merging = repo.merge;
  const parents = [parentId, merging?.theirs].filter(Boolean);
  const branch = currentBranch(repo);
  const created = createCommit(repo, { message: text, parents, tree: repo.index, author: s.user, env });
  moveHead(repo, created.id);
  repo.merge = null;
  const where = branch ? `${branch}${parentId ? '' : ' (root-commit)'}` : 'detached HEAD';
  const out = [`[${where} ${created.id}] ${subject(created)}`];
  if (!merging) out.push(...summaryLines(changes));
  return success(s, out, {
    kind: 'commit',
    id: created.id,
    branch,
    parent: parentId,
    merged: merging ? merging.label : null,
    autoStaged,
    files: changes.length,
  });
}

/* ------------------------------------------------------------------ git log */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function gitDate(timestamp) {
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
  if (headCommitId(repo) === id)
    items.push(
      current
        ? [
            ['HEAD -> ', 'cyan bold'],
            [current, 'green bold'],
          ]
        : [['HEAD', 'cyan bold']],
    );
  for (const name of Object.keys(repo.branches).sort(byteOrder)) {
    if (repo.branches[name] === id && name !== current) items.push([[name, 'green bold']]);
  }
  for (const name of Object.keys(repo.tags).sort(byteOrder)) {
    if (repo.tags[name] === id) items.push([[`tag: ${name}`, 'yellow bold']]);
  }
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

export function log(state, { oneline = false, graph = false, all = false, revs = [], maxCount = Infinity } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  let tips = [];
  if (all) tips = [...Object.values(repo.branches), headCommitId(repo)].filter(Boolean);
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
  const order = (graph ? topoOrder(repo, tips) : dateOrder(repo, tips)).slice(0, maxCount);
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
  return success(state, out, { kind: 'log', count: order.length, graph });
}

/* ------------------------------------------------------------------ git branch */

function addBranch(repo, name, id) {
  repo.branches[name] = id;
  if (!repo.lanes.includes(name)) repo.lanes.push(name);
  // Des commits faits en HEAD détachée rejoignent la ligne de la branche qui les « sauve ».
  for (let c = repo.commits[id]; c && c.lane === null; c = repo.commits[c.parents[0]]) c.lane = name;
}

export function branchList(state, { verbose = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const current = currentBranch(repo);
  const entries = Object.keys(repo.branches)
    .sort(byteOrder)
    .map((name) => ({ name, current: name === current, id: repo.branches[name] }));
  if (repo.head.type === 'detached') {
    const { commit: at, from } = repo.head;
    entries.unshift({ name: `(HEAD detached ${at === from ? 'at' : 'from'} ${from})`, current: true, id: at });
  }
  const width = Math.max(0, ...entries.map((e) => e.name.length));
  const out = entries.map((e) => {
    const name = verbose ? e.name.padEnd(width) : e.name;
    const line = [e.current ? '* ' : '  ', e.current ? [name, 'green'] : name];
    if (verbose) line.push(` ${e.id} ${subject(repo.commits[e.id])}`);
    return line;
  });
  return success(state, out, { kind: 'branch-list', count: Object.keys(repo.branches).length, current });
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
  return success(s, [], { kind: 'branch-create', name, id, current: currentBranch(repo) });
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

/* ------------------------------------------------------------------ git checkout / switch */

const ACTION_VERB = { checkout: 'switch branches', merge: 'merge' };

function overwriteError(dirty, untracked, action) {
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
function switchTree(s, from, to, action) {
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
  if (!repo.merge) return null;
  const unmerged = keysOf(repo.merge.conflicts);
  if (unmerged.length)
    return ['error: you need to resolve your current index first', ...unmerged.map((p) => `${p}: needs merge`)];
  return ['fatal: cannot switch branch while merging', 'Consider "git merge --quit" or "git worktree add".'];
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
    return success(s, out, { kind: created ? 'switch-create' : 'switch', branch: target.branch, id: newId });
  }
  if (advice && oldHead.type === 'branch') out.push(...detachedAdvice(rev));
  out.push(`HEAD is now at ${shortLine(repo, newId)}`);
  return success(s, out, { kind: 'detach', id: newId });
}

function switchToBranch(state, name) {
  if (name === currentBranch(state.repo)) {
    return success(state, [...localChangeLines(state), `Already on '${name}'`], { kind: 'already-on', branch: name });
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
  return moveHeadTo(state, { branch: name }, { created: true, startId });
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
  const conflicts = repo.merge?.conflicts ?? {};
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

export function checkout(state, { target = null, newBranch = null, paths = [], detach = false, quiet = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (paths.length) return checkoutPaths(state, paths, quiet);
  if (newBranch !== null) return createAndSwitch(state, newBranch, target, 'checkout');
  if (target === null || target === 'HEAD') return success(state, localChangeLines(state));
  if (target === '-') return switchToPrevious(state, 'checkout');
  if (!detach && hasOwn(repo.branches, target)) return switchToBranch(state, target);
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
  if (resolveRevision(repo, target)) {
    return failure(state, [
      `fatal: a branch is expected, got commit '${target}'`,
      'hint: If you want to detach HEAD at the commit, try again with the --detach option.',
    ]);
  }
  return failure(state, `fatal: invalid reference: ${target}`);
}

/* ------------------------------------------------------------------ git merge */

function conflictMarkers(ours, theirs, label) {
  const a = splitLines(ours);
  const b = splitLines(theirs);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return (
    [
      ...a.slice(0, pre),
      '<<<<<<< HEAD',
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
  const baseTree = treeOf(repo, mergeBase(repo, ours, theirs));
  const oursTree = treeOf(repo, ours);
  const theirsTree = treeOf(repo, theirs);
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
      conflictContent[path] = conflictMarkers(o, t, target);
      notes.push(
        `Auto-merging ${path}`,
        `CONFLICT (${b === undefined ? 'add/add' : 'content'}): Merge conflict in ${path}`,
      );
    } else {
      conflicts[path] = o === undefined ? 'deleted by us' : 'deleted by them';
      conflictContent[path] = o ?? t;
      notes.push(
        o === undefined
          ? `CONFLICT (modify/delete): ${path} deleted in HEAD and modified in ${target}.  Version ${target} of ${path} left in tree.`
          : `CONFLICT (modify/delete): ${path} deleted in ${target} and modified in HEAD.  Version HEAD of ${path} left in tree.`,
      );
    }
  }

  const touched = keysOf(oursTree, merged, conflictContent).filter(
    (p) => hasOwn(conflictContent, p) || get(merged, p) !== get(oursTree, p),
  );
  const dirty = touched.filter((p) => hasOwn(oursTree, p) && get(s.workdir, p) !== oursTree[p]);
  const untracked = touched.filter((p) => !hasOwn(oursTree, p) && hasOwn(s.workdir, p));
  if (dirty.length || untracked.length) return failure(state, overwriteError(dirty, untracked, 'merge'));

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

export function diff(state, { staged = false, paths = [] } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const head = treeOf(repo, headCommitId(repo));
  for (const path of paths) {
    if (!hasOwn(state.workdir, path) && !hasOwn(repo.index, path) && !hasOwn(head, path)) {
      return failure(state, [
        `fatal: ambiguous argument '${path}': unknown revision or path not in the working tree.`,
        "Use '--' to separate paths from revisions, like this:",
        "'git <command> [<revision>...] -- [<file>...]'",
      ]);
    }
  }
  const conflicts = repo.merge?.conflicts ?? {};
  const tracked = Object.fromEntries(
    keysOf(repo.index)
      .filter((p) => hasOwn(state.workdir, p))
      .map((p) => [p, state.workdir[p]]),
  );
  const changes = (staged ? treeChanges(head, repo.index) : treeChanges(repo.index, tracked)).filter(
    (c) => !hasOwn(conflicts, c.path) && (!paths.length || paths.includes(c.path)),
  );
  const unmerged = keysOf(conflicts).filter((p) => !paths.length || paths.includes(p));
  const out = [...unmerged.map((p) => `* Unmerged path ${p}`), ...changes.flatMap(fileDiffLines)];
  return success(state, out, { kind: 'diff', staged, empty: !out.length });
}
