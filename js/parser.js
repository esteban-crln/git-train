/**
 * Analyse de la saisie (mini-shell) et production de la sortie texte.
 * Ne touche jamais au DOM : renvoie des lignes que le terminal se charge d'afficher.
 */
import * as git from './engine.js';
import * as remote from './remote.js';
import * as rewrite from './rewrite.js';
import * as stash from './stash.js';
import * as tags from './tags.js';

const GIT_VERSION = '2.47.0';
const UNSUPPORTED = 'Commande non supportée dans ce simulateur.';
const EDITORS = ['nano', 'vim', 'vi', 'emacs', 'code', 'gedit', 'notepad'];

// Sous-commandes réelles de Git : distingue « non supportée » d'une faute de frappe.
// prettier-ignore
const REAL_GIT_COMMANDS = [
  'am', 'apply', 'archive', 'bisect', 'blame', 'bundle', 'cat-file', 'citool', 'clean', 'describe',
  'difftool', 'format-patch', 'fsck', 'gc', 'grep', 'gui', 'hash-object', 'ls-files', 'ls-tree', 'maintenance',
  'mergetool', 'mv', 'notes', 'prune', 'range-diff', 'reflog', 'rev-parse', 'shortlog', 'show',
  'show-ref', 'sparse-checkout', 'submodule', 'whatchanged', 'worktree',
];

/* ------------------------------------------------------------------ résultats */

const lines = (text) => text.split('\n');
const ok = (state, out = [], info = null) => ({ state, out, ok: true, info });
const fail = (state, out) => ({ state, out: typeof out === 'string' ? lines(out) : out, ok: false, info: null });

function unsupported(state, note = null) {
  return { state, out: [[[UNSUPPORTED, 'warn']], ...(note ? [[[note, 'dim']]] : [])], ok: false, info: null };
}

export function linesToText(out) {
  const text = out.map((line) =>
    typeof line === 'string' ? line : line.map((seg) => (typeof seg === 'string' ? seg : seg[0])).join(''),
  );
  return text.length ? `${text.join('\n')}\n` : '';
}

/* ------------------------------------------------------------------ analyse lexicale */

/** Découpe la ligne en mots (guillemets, échappements, jokers) et opérateurs (> >> && ; | & <). */
export function tokenize(input) {
  const tokens = [];
  let word = null;
  const flush = () => {
    if (word) tokens.push({ type: 'word', ...word });
    word = null;
  };
  for (let i = 0; i < input.length; ) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') {
      flush();
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('>;|&<'.includes(ch)) {
      flush();
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    word ??= { value: '', glob: false };
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) return { error: "bash: unexpected EOF while looking for matching `''" };
      word.value += input.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && '"\\$`'.includes(input[j + 1] ?? '')) j++;
        word.value += input[j++];
      }
      if (j >= input.length) return { error: 'bash: unexpected EOF while looking for matching `"\'' };
      i = j + 1;
    } else if (ch === '\\') {
      word.value += input[i + 1] ?? '';
      i += 2;
    } else {
      if (ch === '*' || ch === '?') word.glob = true;
      word.value += ch;
      i++;
    }
  }
  flush();
  return { tokens };
}

/** Regroupe les mots en commandes séparées par && ou ;, avec redirection éventuelle. */
export function parseLine(input) {
  const { tokens, error } = tokenize(input);
  if (error) return { error };
  const segments = [];
  let current = { words: [], redirect: null, op: null };
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type === 'word') {
      current.words.push(token);
    } else if (token.value === '>' || token.value === '>>') {
      const target = tokens[k + 1];
      if (!target || target.type !== 'word')
        return { error: `bash: syntax error near unexpected token \`${target ? target.value : 'newline'}'` };
      current.redirect = { file: target.value, append: token.value === '>>' };
      k++;
    } else if (token.value === '&&' || token.value === ';') {
      if (!current.words.length && !current.redirect)
        return { error: `bash: syntax error near unexpected token \`${token.value}'` };
      segments.push(current);
      current = { words: [], redirect: null, op: token.value };
    } else {
      return { unsupported: token.value };
    }
  }
  if (current.words.length || current.redirect) segments.push(current);
  else if (current.op === '&&') return { error: 'bash: syntax error: unexpected end of file' };
  return { segments };
}

function expandGlobs(words, workdir) {
  return words.flatMap(({ value, glob }) => {
    if (!glob) return [value];
    const source = value
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const pattern = new RegExp(`^${source}$`);
    const matches = Object.keys(workdir)
      .filter((name) => pattern.test(name) && (!name.startsWith('.') || value.startsWith('.')))
      .sort();
    return matches.length ? matches : [value];
  });
}

/* ------------------------------------------------------------------ options façon Git */

const flag = (key) => ({ key });
const valued = (key, multi = false) => ({ key, value: true, multi });
const counter = (key) => ({ key, count: true });

function parseOptions(args, { options = {}, numeric = null }) {
  const opts = {};
  const positional = [];
  const paths = [];
  let dashDash = false;
  const set = (def, v) => {
    if (def.multi) (opts[def.key] ??= []).push(v);
    else if (def.count) opts[def.key] = (opts[def.key] ?? 0) + 1;
    else opts[def.key] = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (dashDash) {
      paths.push(arg);
    } else if (arg === '--') {
      dashDash = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const def = name.length > 1 ? options[name] : undefined;
      if (!def || (!def.value && eq !== -1)) return { unsupported: arg };
      if (def.value) {
        const v = eq === -1 ? args[++i] : arg.slice(eq + 1);
        if (v === undefined) return { error: `error: option \`${name}' requires a value` };
        set(def, v);
      } else set(def, true);
    } else if (arg.length > 1 && arg.startsWith('-')) {
      if (numeric && /^-\d+$/.test(arg)) {
        opts[numeric] = Number(arg.slice(1));
        continue;
      }
      for (let k = 1; k < arg.length; k++) {
        const def = options[arg[k]];
        if (!def) return { unsupported: `-${arg[k]}` };
        if (!def.value) {
          set(def, true);
          continue;
        }
        const v = k + 1 < arg.length ? arg.slice(k + 1) : args[++i];
        if (v === undefined) return { error: `error: switch \`${arg[k]}' requires a value` };
        set(def, v);
        break;
      }
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional, paths, dashDash };
}

/* ------------------------------------------------------------------ commandes Git */

const hasFile = (state, name) => Object.prototype.hasOwnProperty.call(state.workdir, name);
const branchNames = (state) => (state.repo ? Object.keys(state.repo.branches).sort() : []);
const remoteNames = (state) => (state.repo ? Object.keys(state.repo.remotes).sort() : []);
const remoteRefNames = (state) => (state.repo ? Object.keys(state.repo.remoteRefs).sort() : []);
// `git checkout feature` crée la branche locale qui suit origin/feature : on propose donc ces noms courts.
const remoteShortNames = (state) => remoteRefNames(state).map((ref) => ref.slice(ref.indexOf('/') + 1));
const trackedFiles = (state) => (state.repo ? Object.keys(state.repo.index).sort() : []);
const tagNames = (state) => (state.repo ? Object.keys(state.repo.tags).sort() : []);
const resolves = (state, rev) => !!state.repo && git.resolveRevision(state.repo, rev) !== null;
/** Un fichier que Git connaît ou voit : dans le répertoire de travail, l'index ou le dernier commit. */
const knownPath = (state, path) =>
  hasFile(state, path) ||
  (!!state.repo &&
    (Object.prototype.hasOwnProperty.call(state.repo.index, path) ||
      Object.prototype.hasOwnProperty.call(git.treeOf(state.repo, git.headCommitId(state.repo)), path)));

const ambiguous = (state, arg) =>
  fail(state, [
    `fatal: ambiguous argument '${arg}': unknown revision or path not in the working tree.`,
    "Use '--' to separate paths from revisions, like this:",
    "'git <command> [<revision>...] -- [<file>...]'",
  ]);

/** Sépare `git <cmd> [<rev>] <fichiers>` : la première valeur qui est une révision en est une, le reste sont des fichiers. */
function splitRevAndPaths(state, positional, paths, dashDash) {
  let rev = null;
  let files = [...positional];
  if (files.length && resolves(state, files[0]) && (dashDash || !knownPath(state, files[0]) || files.length === 1)) {
    rev = files.shift();
  }
  files = [...files, ...paths];
  return { rev, files };
}
const changedFiles = (state) => {
  if (!state.repo) return [];
  const st = git.computeStatus(state);
  return [...new Set([...st.untracked, ...st.unstaged.map((e) => e.path), ...st.unmerged.map((e) => e.path)])].sort();
};

/** `git push main` : Git y voit un dépôt distant nommé main ; on rappelle la forme complète. */
function withRemoteHint(state, first, res, verb) {
  const repo = state.repo;
  if (res.ok || !repo || first === undefined || Object.prototype.hasOwnProperty.call(repo.remotes, first)) return res;
  if (!Object.prototype.hasOwnProperty.call(repo.branches, first)) return res;
  const origin = Object.keys(repo.remotes).sort()[0] ?? 'origin';
  return {
    ...res,
    out: [
      ...res.out,
      [[`« ${first} » est une branche, pas un dépôt distant : écrivez git ${verb} ${origin} ${first}`, 'dim']],
    ],
  };
}

/** Partie commune de git cherry-pick et git revert : options de reprise (--continue…) ou nouveaux commits à rejouer. */
function pickRun(state, kind, opts, positional, env) {
  const actions = ['continue', 'abort', 'skip'].filter((a) => opts[a]);
  if (actions.length > 1) return fail(state, `error: options '--${actions[0]}' and '--${actions[1]}' cannot be used together`);
  if (actions.length) {
    if (positional.length) return fail(state, `fatal: cannot do --${actions[0]} with commits`);
    if (opts.continue) return rewrite.pickContinue(state, kind, env);
    if (opts.abort) return rewrite.pickAbort(state, kind);
    return rewrite.pickSkip(state, kind, env);
  }
  let mainline = null;
  if (opts.mainline !== undefined) {
    mainline = Number(opts.mainline);
    if (!Number.isInteger(mainline) || mainline < 1)
      return fail(state, "error: option `mainline' expects a number greater than zero");
  }
  return rewrite.pickCommits(
    state,
    kind,
    { revs: positional, noCommit: !!opts.noCommit, record: !!opts.record, mainline },
    env,
  );
}

/**
 * Registre des sous-commandes supportées. Ajouter une commande prévue (reset, stash…) consiste à
 * écrire sa fonction dans engine.js puis à la déclarer ici : rien d'autre à modifier.
 */
const GIT = {
  init: {
    summary: 'Create an empty Git repository or reinitialize an existing one',
    usage: 'git init',
    help: [
      'Crée un dépôt Git vide dans le dossier courant (dossier caché .git).',
      "La branche initiale s'appelle main.",
    ],
    run: (state, { positional }) =>
      positional.some((p) => p !== '.')
        ? unsupported(state, 'Ce simulateur ne gère que le dossier courant.')
        : git.init(state),
  },
  status: {
    summary: 'Show the working tree status',
    usage: 'git status [-s] [-b]',
    help: [
      "Affiche l'état des trois zones : fichiers modifiés, fichiers prêts à être commités (staging area) et fichiers non suivis.",
      'Option -s : format court (?? = non suivi, A = ajouté, M = modifié).',
    ],
    options: { s: flag('short'), short: flag('short'), b: flag('branch'), branch: flag('branch') },
    run: (state, { opts, positional }) =>
      positional.length
        ? unsupported(state, "Le filtrage par fichier de git status n'est pas simulé.")
        : git.status(state, opts),
  },
  add: {
    summary: 'Add file contents to the index',
    usage: 'git add [-A] [-f] [<pathspec>...]',
    help: [
      "Place la version actuelle des fichiers dans la staging area (l'index) : ils feront partie du prochain commit.",
      'git add . ajoute tous les fichiers modifiés ou nouveaux, sauf ceux que .gitignore ignore (-f pour les forcer).',
    ],
    examples: ['git add README.md', 'git add .'],
    options: { A: flag('all'), all: flag('all'), f: flag('force'), force: flag('force') },
    complete: (state) => ['.', ...changedFiles(state)],
    run: (state, { opts, positional, paths }) =>
      git.add(state, { paths: [...positional, ...paths], all: !!opts.all, force: !!opts.force }),
  },
  commit: {
    summary: 'Record changes to the repository',
    usage: 'git commit [-a] [--amend [--no-edit]] -m <msg>',
    help: [
      "Enregistre une « photo » de la staging area dans l'historique, avec un message.",
      "Option -a : indexe d'abord automatiquement les fichiers déjà suivis qui ont été modifiés.",
      'Option --amend : remplace le dernier commit (nouveau message avec -m, ou --no-edit pour le garder) au lieu d\'en ajouter un.',
    ],
    examples: [
      'git commit -m "Ajoute la page d\'accueil"',
      'git commit -am "Corrige une faute"',
      'git commit --amend -m "Message corrigé"',
    ],
    options: {
      a: flag('all'),
      all: flag('all'),
      m: valued('message', true),
      message: valued('message', true),
      'allow-empty': flag('allowEmpty'),
      amend: flag('amend'),
      'no-edit': flag('noEdit'),
    },
    run: (state, { opts, positional, paths }, env) => {
      if (positional.length || paths.length)
        return unsupported(state, "Le commit de fichiers précis (git commit <fichier>) n'est pas simulé.");
      return git.commit(
        state,
        {
          message: opts.message ? opts.message.join('\n\n') : null,
          all: !!opts.all,
          allowEmpty: !!opts.allowEmpty,
          amend: !!opts.amend,
          noEdit: !!opts.noEdit,
        },
        env,
      );
    },
  },
  log: {
    summary: 'Show commit logs',
    usage: 'git log [--oneline] [--graph] [--all] [-n <number>] [<revision>] [-- <file>...] | git log --merge',
    help: [
      "Affiche l'historique des commits, du plus récent au plus ancien.",
      '--oneline : une ligne par commit ; --graph : dessine les branches ; --all : toutes les branches.',
      'git log -- <fichier> : seulement les commits qui modifient ce fichier.',
      "git log --merge : pendant un conflit, les commits des deux côtés qui touchent les fichiers en conflit.",
    ],
    examples: ['git log --oneline --graph --all', 'git log --oneline -- README.md', 'git log --merge'],
    options: {
      oneline: flag('oneline'),
      graph: flag('graph'),
      all: flag('all'),
      decorate: flag('decorate'),
      merge: flag('merge'),
      n: valued('maxCount'),
      'max-count': valued('maxCount'),
    },
    numeric: 'maxCount',
    complete: (state) => [...branchNames(state), ...remoteRefNames(state), ...tagNames(state), ...trackedFiles(state)],
    run: (state, { opts, positional, paths, dashDash }) => {
      const maxCount = opts.maxCount === undefined ? Infinity : Number(opts.maxCount);
      if (!Number.isInteger(maxCount) && maxCount !== Infinity)
        return fail(state, `fatal: '${opts.maxCount}': not an integer`);
      const revs = [];
      const files = [...paths];
      for (const arg of positional) {
        if (!resolves(state, arg) && !dashDash && knownPath(state, arg)) files.push(arg);
        else revs.push(arg);
      }
      if (opts.graph && (files.length || opts.merge))
        return unsupported(state, "git log --graph n'est pas simulé avec un fichier ou --merge.");
      return git.log(state, {
        oneline: !!opts.oneline,
        graph: !!opts.graph,
        all: !!opts.all,
        revs,
        maxCount,
        paths: files,
        mergeOnly: !!opts.merge,
      });
    },
  },
  branch: {
    summary: 'List, create, or delete branches',
    usage:
      'git branch [-v] [-r | -a] | git branch <name> [<start-point>] | git branch (-d | -D) <name>... | git branch -u <upstream>',
    help: [
      'Sans argument : liste les branches (* = branche courante). -r : branches de suivi distantes, -a : toutes.',
      "git branch <nom> crée une branche (une simple étiquette sur le commit courant) sans s'y placer.",
      'git branch -d <nom> supprime une branche déjà fusionnée (-D pour forcer).',
      'git branch -vv montre la branche distante suivie ; git branch -u origin/main fait suivre origin/main à la branche courante.',
    ],
    examples: ['git branch feature', 'git branch -d feature', 'git branch -vv'],
    options: {
      d: flag('delete'),
      delete: flag('delete'),
      D: { key: 'forceDelete' },
      v: counter('verbose'),
      verbose: counter('verbose'),
      l: flag('list'),
      list: flag('list'),
      r: flag('remotes'),
      remotes: flag('remotes'),
      a: flag('all'),
      all: flag('all'),
      u: valued('setUpstream'),
      'set-upstream-to': valued('setUpstream'),
      'unset-upstream': flag('unsetUpstream'),
    },
    complete: (state) => [...branchNames(state), ...remoteRefNames(state)],
    run: (state, { opts, positional }) => {
      if (opts.unsetUpstream) return git.branchSetUpstream(state, { branch: positional[0] ?? null, unset: true });
      if (opts.setUpstream !== undefined) {
        return git.branchSetUpstream(state, { upstream: opts.setUpstream, branch: positional[0] ?? null });
      }
      if (opts.delete || opts.forceDelete)
        return git.branchDelete(state, { names: positional, force: !!opts.forceDelete });
      if (positional.length && !opts.list && !opts.remotes && !opts.all) {
        if (positional.length > 2) return fail(state, 'fatal: too many arguments for a create operation');
        return git.branchCreate(state, { name: positional[0], start: positional[1] ?? null });
      }
      return git.branchList(state, { verbose: opts.verbose ?? 0, remotes: !!opts.remotes, all: !!opts.all });
    },
  },
  checkout: {
    summary: 'Switch branches or restore working tree files',
    usage:
      'git checkout [-b <new-branch>] <branch> | git checkout <commit> | git checkout [<commit>] -- <file>... | git checkout --ours|--theirs <file>...',
    help: [
      'Déplace HEAD sur une branche (ou un commit : HEAD détachée) et met à jour le répertoire de travail.',
      "git checkout -b <nom> crée la branche et s'y place.",
      "git checkout -- <fichier> annule les modifications non indexées d'un fichier ; avec un commit devant (git checkout abc123 -- <fichier>), il rapporte la version de ce commit.",
      "Pendant un conflit, git checkout --ours <fichier> garde la version de votre branche, --theirs celle de l'autre (puis git add).",
    ],
    examples: ['git checkout feature', 'git checkout -b feature', 'git checkout --theirs README.md'],
    options: { b: valued('newBranch'), detach: flag('detach'), ours: flag('ours'), theirs: flag('theirs') },
    complete: (state) => [
      ...branchNames(state),
      ...remoteShortNames(state),
      ...tagNames(state),
      ...trackedFiles(state),
    ],
    run: (state, { opts, positional, paths, dashDash }) => {
      const newBranch = opts.newBranch ?? null;
      const fromRevision = (rev, files) => {
        if (state.repo && !resolves(state, rev)) return fail(state, `fatal: invalid reference: ${rev}`);
        const id = state.repo ? git.resolveRevision(state.repo, rev) : null;
        return git.restorePaths(state, { paths: files, source: rev, staged: true, worktree: true, from: id });
      };
      if (opts.ours || opts.theirs) {
        return git.restorePaths(state, {
          paths: [...positional, ...paths],
          side: opts.ours ? 'ours' : 'theirs',
          from: 'the index',
        });
      }
      if (dashDash) {
        if (positional.length > 1) return fail(state, 'fatal: only one reference expected');
        return positional.length ? fromRevision(positional[0], paths) : git.checkout(state, { paths, quiet: true });
      }
      if (positional.length > 1 && newBranch === null) {
        if (!resolves(state, positional[0])) return git.checkout(state, { paths: positional });
        return fromRevision(positional[0], positional.slice(1));
      }
      if (positional.length > 1)
        return unsupported(state, 'git checkout -b avec plusieurs arguments n\'est pas simulé.');
      return git.checkout(state, { target: positional[0] ?? null, newBranch, detach: !!opts.detach });
    },
  },
  switch: {
    summary: 'Switch branches',
    usage: 'git switch <branch> | git switch -c <new-branch> [<start-point>] | git switch --detach <commit>',
    help: [
      'Change de branche (version moderne et plus claire de git checkout).',
      "git switch -c <nom> crée la branche et s'y place ; git switch - revient à la branche précédente.",
    ],
    examples: ['git switch main', 'git switch -c feature'],
    options: { c: valued('create'), create: valued('create'), d: flag('detach'), detach: flag('detach') },
    complete: (state) => [...branchNames(state), ...remoteShortNames(state)],
    run: (state, { opts, positional }) => {
      if (positional.length > 1) return fail(state, 'fatal: only one reference expected');
      return git.switchBranch(state, {
        target: positional[0] ?? null,
        create: opts.create ?? null,
        detach: !!opts.detach,
      });
    },
  },
  merge: {
    summary: 'Join two or more development histories together',
    usage: 'git merge [--no-ff] [--ff-only] [-m <msg>] <branch> | git merge --abort',
    help: [
      "Intègre l'historique d'une autre branche dans la branche courante.",
      "Si la branche courante n'a pas divergé : avance rapide (fast-forward), sinon un commit de fusion à deux parents est créé.",
      'En cas de conflit : corrigez les fichiers, puis git add et git commit (ou git merge --abort).',
    ],
    examples: ['git merge feature', 'git merge --no-ff feature'],
    options: {
      'no-ff': flag('noFF'),
      'ff-only': flag('ffOnly'),
      ff: flag('ff'),
      m: valued('message'),
      message: valued('message'),
      abort: flag('abort'),
      continue: flag('continue'),
      'no-edit': flag('noEdit'),
    },
    complete: (state) => [...branchNames(state).filter((b) => b !== state.repo?.head.name), ...remoteRefNames(state)],
    run: (state, { opts, positional }, env) => {
      if (opts.continue) {
        return state.repo?.merge
          ? git.commit(state, {}, env)
          : fail(state, 'fatal: There is no merge in progress (MERGE_HEAD missing).');
      }
      if (positional.length > 1)
        return unsupported(state, "La fusion de plusieurs branches à la fois (octopus) n'est pas simulée.");
      return git.merge(
        state,
        {
          target: positional[0] ?? null,
          noFF: !!opts.noFF,
          ffOnly: !!opts.ffOnly,
          message: opts.message ?? null,
          abort: !!opts.abort,
        },
        env,
      );
    },
  },
  diff: {
    summary: 'Show changes between commits, commit and working tree, etc',
    usage: 'git diff [--staged] [--stat | --name-only | --name-status] [<commit> [<commit>]] [-- <file>...]',
    help: [
      'Sans option : montre les modifications du répertoire de travail pas encore indexées.',
      '--staged (ou --cached) : montre ce qui est dans la staging area, prêt pour le prochain commit.',
      'git diff <commit> : compare ce commit au répertoire de travail (git diff HEAD = tout ce qui a changé depuis le dernier commit).',
      'git diff <a> <b> (ou <a>..<b>) : compare deux commits ou deux branches ; --stat résume, --name-only liste les fichiers.',
    ],
    examples: ['git diff', 'git diff --staged', 'git diff HEAD', 'git diff main feature', 'git diff --stat main..feature'],
    options: {
      staged: flag('staged'),
      cached: flag('staged'),
      stat: flag('stat'),
      'name-only': flag('nameOnly'),
      'name-status': flag('nameStatus'),
    },
    complete: (state) => [...trackedFiles(state), ...branchNames(state), ...remoteRefNames(state), ...tagNames(state)],
    run: (state, { opts, positional, paths, dashDash }) => {
      const revs = [];
      const files = [...paths];
      const isRevision = (arg) => {
        const range = /^(.*?)(\.{2,3})(.*)$/.exec(arg);
        if (range) return [range[1] || 'HEAD', range[3] || 'HEAD'].every((part) => resolves(state, part));
        return !hasFile(state, arg) && resolves(state, arg);
      };
      for (const arg of positional) {
        if (!dashDash && files.length === 0 && revs.length < 2 && isRevision(arg)) revs.push(arg);
        else files.push(arg);
      }
      const format = opts.stat ? 'stat' : opts.nameOnly ? 'name-only' : opts.nameStatus ? 'name-status' : 'patch';
      return git.diff(state, { staged: !!opts.staged, paths: files, revs, format });
    },
  },
  config: {
    summary: 'Get and set repository or global options',
    usage: 'git config [--global] <name> [<value>] | git config --list',
    help: [
      "Lit ou modifie un réglage. Les plus utiles : user.name et user.email (l'auteur de vos commits).",
      'Aussi simulés : pull.rebase false (git pull fusionne) et pull.ff only (git pull refuse de fusionner).',
    ],
    examples: [
      'git config --global user.name "Prénom Nom"',
      'git config --global user.email "adresse@mail.fr"',
      'git config --list',
    ],
    options: { global: flag('global'), local: flag('local'), list: flag('list'), l: flag('list') },
    complete: () => Object.keys(git.CONFIG_KEYS),
    run: (state, { opts, positional }) => {
      if (opts.list) return git.config(state, { list: true });
      if (!positional.length || positional.length > 2) {
        return fail(state, [
          'error: wrong number of arguments, should be from 1 to 2',
          'usage: git config [<options>]',
        ]);
      }
      const key = positional[0].toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(git.CONFIG_KEYS, key)) {
        return unsupported(state, `Seuls ${Object.keys(git.CONFIG_KEYS).join(', ')} sont simulés.`);
      }
      return git.config(state, { key, value: positional[1] ?? null, global: !!opts.global });
    },
  },
  clone: {
    summary: 'Clone a repository into a new directory',
    usage: 'git clone <url> [.]',
    help: [
      'Copie un dépôt distant (tout son historique) dans le dossier courant, qui doit être vide, et le relie à lui sous le nom origin.',
      `Le simulateur héberge un dépôt de démonstration : git clone ${git.DEMO_URL}`,
    ],
    examples: [`git clone ${git.DEMO_URL}`],
    complete: () => [git.DEMO_URL],
    run: (state, { positional }) => {
      if (positional.length > 2 || (positional[1] !== undefined && positional[1] !== '.')) {
        return unsupported(
          state,
          'Ce simulateur clone toujours dans le dossier courant : git clone <url> (ou git clone <url> .).',
        );
      }
      return remote.cloneRepo(state, { url: positional[0] ?? null });
    },
  },
  remote: {
    summary: 'Manage set of tracked repositories',
    usage: 'git remote [-v] | git remote add <name> <url> | git remote remove <name>',
    help: [
      'Gère les dépôts distants : des adresses (URL) que Git retient sous un nom court. origin est le nom habituel du dépôt GitHub.',
      "git remote -v : liste les adresses ; git remote add origin <url> : en ajoute une ; git remote remove origin : l'oublie.",
    ],
    examples: [`git remote add origin ${git.DEMO_URL}`, 'git remote -v'],
    options: { v: flag('verbose'), verbose: flag('verbose') },
    complete: (state, args) => {
      const sub = args.filter((a) => !a.startsWith('-'));
      if (!sub.length) return ['add', 'remove', 'rm'];
      return ['remove', 'rm'].includes(sub[0]) && sub.length === 1 ? remoteNames(state) : [];
    },
    run: (state, { opts, positional }) => {
      const [action, ...args] = positional;
      if (action === undefined) return remote.remoteList(state, { verbose: !!opts.verbose });
      if (action === 'add') {
        if (args.length !== 2) {
          return fail(state, [
            'usage: git remote add [-t <branch>] [-m <master>] [-f] [--tags | --no-tags] [--mirror=<fetch|push>] <name> <url>',
            ...(args.length === 1
              ? [[[`Il manque le nom du dépôt distant : git remote add origin ${args[0]}`, 'dim']]]
              : []),
          ]);
        }
        return remote.remoteAdd(state, { name: args[0], url: args[1] });
      }
      if (action === 'remove' || action === 'rm') {
        if (args.length !== 1) return fail(state, 'usage: git remote remove <name>');
        return remote.remoteRemove(state, { name: args[0] });
      }
      if (['rename', 'set-url', 'show', 'get-url', 'prune', 'update', 'set-head', 'set-branches'].includes(action)) {
        return unsupported(state, `git remote ${action} n'est pas simulée (seules add, remove et -v le sont).`);
      }
      return fail(state, [`error: unknown subcommand: \`${action}'`, 'usage: git remote [-v | --verbose]']);
    },
  },
  fetch: {
    summary: 'Download objects and refs from another repository',
    usage: 'git fetch [--all] [--prune] [<remote>]',
    help: [
      'Télécharge les nouveaux commits du dépôt distant et met à jour les branches de suivi (origin/main…), sans toucher à vos branches ni à vos fichiers.',
      "On peut ensuite comparer (git log main..origin/main) puis fusionner (git merge origin/main). git pull fait les deux d'un coup.",
    ],
    examples: ['git fetch', 'git fetch origin'],
    options: { all: flag('all'), prune: flag('prune'), p: flag('prune') },
    complete: remoteNames,
    run: (state, { opts, positional }) => {
      if (positional.length > 1)
        return unsupported(state, "git fetch <remote> <branche> n'est pas simulée : utilisez git fetch <remote>.");
      return remote.fetch(state, { remote: positional[0] ?? null, all: !!opts.all, prune: !!opts.prune });
    },
  },
  pull: {
    summary: 'Fetch from and integrate with another repository or a local branch',
    usage: 'git pull [--ff-only] [--no-rebase | --rebase] [<remote> [<branch>]]',
    help: [
      'Récupère les commits du dépôt distant (git fetch) puis les fusionne dans la branche courante (git merge).',
      'Si votre branche et la branche distante ont chacune des commits nouveaux, Git demande comment réconcilier : --no-rebase fusionne (commit de fusion), --rebase rejoue vos commits par-dessus ceux du distant (historique linéaire).',
    ],
    examples: ['git pull', 'git pull --no-rebase', 'git pull --rebase'],
    options: {
      'ff-only': flag('ffOnly'),
      'no-rebase': flag('noRebase'),
      rebase: flag('rebase'),
      r: flag('rebase'),
      ff: flag('ff'),
      'no-ff': flag('noFF'),
    },
    complete: (state, args) =>
      args.filter((a) => !a.startsWith('-')).length
        ? [...branchNames(state), ...remoteShortNames(state)]
        : remoteNames(state),
    run: (state, { opts, positional }, env) => {
      if (positional.length > 2) return unsupported(state, "Le pull de plusieurs branches n'est pas simulé.");
      const res = remote.pull(
        state,
        {
          remote: positional[0] ?? null,
          branch: positional[1] ?? null,
          ffOnly: !!opts.ffOnly,
          noRebase: !!opts.noRebase,
          noFF: !!opts.noFF,
          rebase: !!opts.rebase,
        },
        env,
      );
      return withRemoteHint(state, positional[0], res, 'pull');
    },
  },
  push: {
    summary: 'Update remote refs along with associated objects',
    usage: 'git push [-u] [-f | --force-with-lease] [<remote> [<branch> | <tag>]] | git push <remote> --tags | git push <remote> --delete <branch>',
    help: [
      "Envoie vos commits vers le dépôt distant. Le push est refusé si le dépôt distant contient des commits que vous n'avez pas : faites d'abord git pull.",
      '-u (--set-upstream) mémorise la branche distante à suivre : ensuite, git push et git pull suffisent. --delete supprime une branche (ou un tag) distant.',
      "Un tag n'est pas envoyé avec les branches : git push origin <tag> (ou --tags pour tous).",
      "Après un rebase ou un amend, l'historique local a été réécrit : le push est refusé, il faut --force-with-lease (--force est plus brutal : il écrase sans vérifier).",
    ],
    examples: ['git push -u origin main', 'git push', 'git push origin v1.0', 'git push --force-with-lease'],
    options: {
      u: flag('setUpstream'),
      'set-upstream': flag('setUpstream'),
      f: flag('force'),
      force: flag('force'),
      'force-with-lease': flag('forceLease'),
      d: flag('delete'),
      delete: flag('delete'),
      tags: flag('tags'),
    },
    complete: (state, args) =>
      args.filter((a) => !a.startsWith('-')).length ? [...branchNames(state), ...tagNames(state)] : remoteNames(state),
    run: (state, { opts, positional }) =>
      withRemoteHint(
        state,
        positional[0],
        remote.push(state, {
          remote: positional[0] ?? null,
          refspecs: positional.slice(1),
          setUpstream: !!opts.setUpstream,
          force: !!opts.force,
          forceLease: !!opts.forceLease,
          del: !!opts.delete,
          tags: !!opts.tags,
        }),
        'push',
      ),
  },
  tag: {
    summary: 'Create, list, delete or verify a tag object signed with GPG',
    usage: 'git tag [-l [<pattern>]] [-n] | git tag [-a] [-m <msg>] [-f] <name> [<commit>] | git tag -d <name>...',
    help: [
      'Pose un nom durable (v1.0…) sur un commit, pour marquer une version. Contrairement à une branche, un tag ne bouge pas.',
      'Sans option : liste les tags. -a (ou -m) crée un tag annoté, avec message, auteur et date ; sinon le tag est « léger ».',
      '-d supprime un tag en local. Les tags ne partent pas avec git push : git push origin <tag> (ou --tags).',
    ],
    examples: ['git tag v1.0', 'git tag -a v1.1 -m "Version 1.1"', 'git push origin v1.1', 'git tag -d v1.0'],
    options: {
      a: flag('annotate'),
      annotate: flag('annotate'),
      m: valued('message', true),
      message: valued('message', true),
      d: flag('delete'),
      delete: flag('delete'),
      l: flag('list'),
      list: flag('list'),
      f: flag('force'),
      force: flag('force'),
      n: flag('annotations'),
    },
    complete: (state) => [...tagNames(state), ...branchNames(state)],
    run: (state, { opts, positional }, env) => {
      if (opts.delete) return tags.tagDelete(state, { names: positional });
      const creating = positional.length && !opts.list;
      if (!creating && !opts.annotate && opts.message === undefined) {
        return tags.tagList(state, { pattern: positional[0] ?? null, annotations: !!opts.annotations });
      }
      if (positional.length === 0) return fail(state, ['fatal: tag name required']);
      if (positional.length > 2) return fail(state, 'fatal: too many arguments');
      return tags.tagCreate(
        state,
        {
          name: positional[0],
          target: positional[1] ?? null,
          message: opts.message ? opts.message.join('\n\n') : null,
          annotate: !!(opts.annotate || opts.message),
          force: !!opts.force,
        },
        env,
      );
    },
  },
  stash: {
    summary: 'Stash the changes in a dirty working directory away',
    usage:
      'git stash [push] [-u] [-m <msg>] | git stash list | git stash pop|apply|drop [<stash>] | git stash show [-p] [<stash>] | git stash branch <name> [<stash>] | git stash clear',
    help: [
      "Met de côté les modifications en cours (fichiers suivis modifiés, staging area) et remet le répertoire de travail dans l'état du dernier commit. Pratique avant de changer de branche ou de faire un pull.",
      'git stash pop reprend la dernière mise de côté et la supprime de la pile ; git stash apply la reprend sans la supprimer.',
      '-u inclut aussi les fichiers non suivis ; git stash list affiche la pile (stash@{0} est le plus récent).',
    ],
    examples: ['git stash', 'git stash -u -m "essai"', 'git stash list', 'git stash pop'],
    options: {
      u: flag('untracked'),
      'include-untracked': flag('untracked'),
      m: valued('message'),
      message: valued('message'),
      p: flag('patch'),
      patch: flag('patch'),
      k: flag('keepIndex'),
      'keep-index': flag('keepIndex'),
      a: flag('all'),
      all: flag('all'),
      index: flag('index'),
    },
    complete: (state, args) => {
      const sub = args.filter((a) => !a.startsWith('-'));
      if (!sub.length) return ['push', 'list', 'pop', 'apply', 'drop', 'show', 'branch', 'clear'];
      const entries = (state.repo?.stash ?? []).map((_, i) => `stash@{${i}}`);
      return ['pop', 'apply', 'drop', 'show'].includes(sub[0]) ? entries : [];
    },
    run: (state, { opts, positional, paths }, env) => {
      const [action, ...args] = positional;
      if (opts.keepIndex || opts.all)
        return unsupported(state, "Les options --keep-index et --all de git stash ne sont pas simulées.");
      switch (action) {
        case undefined:
        case 'push':
        case 'save': {
          if (opts.patch)
            return unsupported(state, "git stash -p est interactif : il demande un choix pour chaque morceau de fichier.");
          if (paths.length || (action === 'push' && args.length))
            return unsupported(state, "Mettre de côté seulement certains fichiers n'est pas simulé.");
          const message = action === 'save' ? args.join(' ') || null : (opts.message ?? null);
          return stash.stashPush(state, { message, includeUntracked: !!opts.untracked }, env);
        }
        case 'list':
          return stash.stashList(state);
        case 'pop':
        case 'apply':
          if (opts.index) return unsupported(state, "L'option --index de git stash n'est pas simulée.");
          return stash.stashApply(state, { ref: args[0] ?? null, pop: action === 'pop' });
        case 'drop':
          return stash.stashDrop(state, { ref: args[0] ?? null });
        case 'clear':
          return stash.stashClear(state);
        case 'show':
          return stash.stashShow(state, { ref: args[0] ?? null, patch: !!opts.patch });
        case 'branch':
          return stash.stashBranch(state, { name: args[0] ?? null, ref: args[1] ?? null });
        default:
          return fail(state, [
            `error: unknown subcommand: ${action}`,
            'usage: git stash list [<log-options>]',
            '   or: git stash show [<diff-options>] [<stash>]',
            '   or: git stash drop [-q | --quiet] [<stash>]',
            '   or: git stash pop [--index] [-q | --quiet] [<stash>]',
            '   or: git stash push [-m | --message <message>] [-u]',
          ]);
      }
    },
  },
  reset: {
    summary: 'Reset current HEAD to the specified state',
    usage: 'git reset [--soft | --mixed | --hard] [<commit>] | git reset [<commit>] [--] <file>...',
    help: [
      "Déplace la branche courante sur un autre commit (HEAD~1 = le précédent). Les trois modes décident de ce qui arrive à la staging area et aux fichiers :",
      '--soft : seule la branche bouge ; les modifications restent dans la staging area. --mixed (défaut) : la staging area est aussi remise à zéro, les fichiers gardent leurs modifications.',
      '--hard : tout est remis dans l\'état du commit visé, les modifications non commitées sont PERDUES.',
      'git reset <fichier> sort simplement un fichier de la staging area (l\'inverse de git add).',
    ],
    examples: ['git reset HEAD~1', 'git reset --soft HEAD~1', 'git reset --hard origin/main', 'git reset README.md'],
    options: {
      soft: flag('soft'),
      mixed: flag('mixed'),
      hard: flag('hard'),
      q: flag('quiet'),
      quiet: flag('quiet'),
    },
    complete: (state) => [...branchNames(state), ...remoteRefNames(state), ...tagNames(state), ...trackedFiles(state)],
    run: (state, { opts, positional, paths, dashDash }) => {
      const modes = ['soft', 'mixed', 'hard'].filter((m) => opts[m]);
      if (modes.length > 1) return fail(state, `fatal: options '--${modes[0]}' and '--${modes[1]}' cannot be used together`);
      if (positional.length > 1 && dashDash) return fail(state, 'fatal: only one revision expected');
      const { rev, files } = splitRevAndPaths(state, positional, paths, dashDash);
      if (!dashDash) {
        const unknown = files.find((f) => !knownPath(state, f));
        if (unknown !== undefined) return ambiguous(state, unknown);
      }
      return rewrite.reset(state, { mode: modes[0] ?? 'mixed', target: rev, paths: files });
    },
  },
  revert: {
    summary: 'Revert some existing commits',
    usage: 'git revert [--no-edit] [-n] [-m <parent>] <commit>... | git revert --continue | --skip | --abort',
    help: [
      "Crée un NOUVEAU commit qui annule les modifications d'un ancien commit. L'historique n'est pas réécrit : c'est la bonne façon de défaire un commit déjà poussé.",
      "-n applique l'annulation sans commiter. -m 1 est nécessaire pour annuler un commit de fusion (1 = on garde le côté de la branche courante).",
      "En cas de conflit : corrigez, git add, puis git revert --continue (ou --skip, --abort). Le simulateur n'ouvre pas d'éditeur : le message par défaut est utilisé.",
    ],
    examples: ['git revert HEAD', 'git revert abc1234 --no-edit', 'git revert -m 1 <commit-de-fusion>'],
    options: {
      'no-edit': flag('noEdit'),
      n: flag('noCommit'),
      'no-commit': flag('noCommit'),
      m: valued('mainline'),
      mainline: valued('mainline'),
      continue: flag('continue'),
      abort: flag('abort'),
      skip: flag('skip'),
    },
    complete: (state) => [...branchNames(state), ...tagNames(state), 'HEAD', 'HEAD~1'],
    run: (state, { opts, positional }, env) => pickRun(state, 'revert', opts, positional, env),
  },
  'cherry-pick': {
    summary: 'Apply the changes introduced by some existing commits',
    usage:
      'git cherry-pick [-x] [-n] [-m <parent>] <commit>... | git cherry-pick <a>..<b> | git cherry-pick --continue | --skip | --abort',
    help: [
      "Copie un ou plusieurs commits (et seulement eux) sur la branche courante : mêmes modifications, mais nouveaux commits avec de nouveaux hash.",
      '-x ajoute « (cherry picked from commit …) » au message ; -n applique sans commiter ; a..b copie les commits après a jusqu\'à b.',
      "En cas de conflit : corrigez, git add, puis git cherry-pick --continue (ou --skip, --abort).",
    ],
    examples: ['git cherry-pick abc1234', 'git cherry-pick -x feature~1', 'git cherry-pick main..feature'],
    options: {
      x: flag('record'),
      n: flag('noCommit'),
      'no-commit': flag('noCommit'),
      m: valued('mainline'),
      mainline: valued('mainline'),
      continue: flag('continue'),
      abort: flag('abort'),
      skip: flag('skip'),
    },
    complete: (state) => [...branchNames(state), ...remoteRefNames(state), ...tagNames(state)],
    run: (state, { opts, positional }, env) => pickRun(state, 'cherry-pick', opts, positional, env),
  },
  rebase: {
    summary: 'Reapply commits on top of another base tip',
    usage: 'git rebase <upstream> [<branch>] | git rebase --continue | --skip | --abort',
    help: [
      "Rejoue les commits de votre branche (ceux que <upstream> n'a pas) par-dessus <upstream> : l'historique devient linéaire, sans commit de fusion. Les commits rejoués sont de NOUVEAUX commits (nouveaux hash) ; les anciens deviennent orphelins.",
      "Typiquement : git rebase origin/main sur une branche de travail pour la mettre à jour. Ne réécrivez jamais des commits déjà partagés : le push suivant exigera --force-with-lease.",
      "En cas de conflit, le rebase s'arrête sur le commit fautif : corrigez, git add, puis git rebase --continue (ou --skip pour l'ignorer, --abort pour tout annuler).",
    ],
    examples: ['git rebase main', 'git rebase origin/main', 'git rebase --continue', 'git rebase --abort'],
    options: {
      continue: flag('continue'),
      abort: flag('abort'),
      skip: flag('skip'),
      i: flag('interactive'),
      interactive: flag('interactive'),
    },
    complete: (state) => [...branchNames(state), ...remoteRefNames(state), ...tagNames(state)],
    run: (state, { opts, positional }, env) => {
      if (opts.interactive)
        return unsupported(state, "Le mode interactif (-i) demande un éditeur de texte, absent du simulateur.");
      if (opts.abort) return rewrite.rebaseAbort(state);
      if (opts.continue) return rewrite.rebaseContinue(state, env);
      if (opts.skip) return rewrite.rebaseSkip(state, env);
      if (positional.length > 2) return fail(state, 'usage: git rebase [<options>] [<upstream> [<branch>]]');
      if (positional.length === 2) {
        const switched = git.switchBranch(state, { target: positional[1] });
        if (!switched.ok) return switched;
        const res = rewrite.rebase(switched.state, { upstream: positional[0] }, env);
        return { ...res, out: [...switched.out, ...res.out] };
      }
      return rewrite.rebase(state, { upstream: positional[0] ?? null }, env);
    },
  },
  restore: {
    summary: 'Restore working tree files',
    usage:
      'git restore [--staged] [--worktree] [--source=<commit>] <file>... | git restore --ours|--theirs <file>...',
    help: [
      'Remet des fichiers dans un état précédent. Sans option : le fichier retrouve sa version de la staging area (modifications non indexées abandonnées).',
      "--staged : sort le fichier de la staging area (il garde ses modifications). --source=<commit> : prend la version de ce commit (HEAD~1, une branche, un tag…).",
      "Pendant un conflit, --ours garde la version de votre branche, --theirs celle de l'autre.",
    ],
    examples: ['git restore README.md', 'git restore --staged README.md', 'git restore --source=HEAD~2 README.md'],
    options: {
      S: flag('staged'),
      staged: flag('staged'),
      W: flag('worktree'),
      worktree: flag('worktree'),
      s: valued('source'),
      source: valued('source'),
      ours: flag('ours'),
      theirs: flag('theirs'),
    },
    complete: (state) => [...trackedFiles(state), ...changedFiles(state)],
    run: (state, { opts, positional, paths }) => {
      const files = [...positional, ...paths];
      if (!files.length) return fail(state, 'fatal: you must specify path(s) to restore');
      return git.restorePaths(state, {
        paths: files,
        source: opts.source ?? null,
        staged: !!opts.staged,
        worktree: !!opts.worktree || !opts.staged,
        side: opts.ours ? 'ours' : opts.theirs ? 'theirs' : null,
      });
    },
  },
  rm: {
    summary: 'Remove files from the working tree and from the index',
    usage: 'git rm [--cached] [-f] [-r] <file>...',
    help: [
      'Supprime un fichier suivi : il disparaît du répertoire de travail ET sera supprimé au prochain commit.',
      '--cached ne retire le fichier que de la staging area : il reste sur le disque mais n\'est plus suivi (utile avec .gitignore).',
      '-f force la suppression malgré des modifications non commitées.',
    ],
    examples: ['git rm vieux.txt', 'git rm --cached secret.env'],
    options: {
      cached: flag('cached'),
      f: flag('force'),
      force: flag('force'),
      r: flag('recursive'),
      q: flag('quiet'),
      quiet: flag('quiet'),
    },
    complete: trackedFiles,
    run: (state, { opts, positional, paths }) => {
      const res = git.rmTracked(state, { paths: [...positional, ...paths], cached: !!opts.cached, force: !!opts.force });
      return opts.quiet && res.ok ? { ...res, out: [] } : res;
    },
  },
  'check-ignore': {
    summary: 'Debug gitignore / exclude files',
    usage: 'git check-ignore [-v] <path>...',
    help: [
      'Indique si un fichier est ignoré par .gitignore (il affiche le chemin si oui, rien sinon). -v montre la ligne de .gitignore responsable.',
    ],
    examples: ['git check-ignore -v debug.log'],
    options: { v: flag('verbose'), verbose: flag('verbose') },
    complete: (state) => Object.keys(state.workdir).sort(),
    run: (state, { opts, positional, paths }) =>
      git.checkIgnore(state, { paths: [...positional, ...paths], verbose: !!opts.verbose }),
  },
  help: {
    summary: 'Display help information about Git',
    usage: 'git help [<command>]',
    help: ["Affiche l'aide de Git, ou d'une commande précise."],
    examples: ['git help commit'],
    complete: () => Object.keys(GIT),
    run: (state, { positional }) => gitHelp(state, positional[0]),
  },
};

const HELP_GROUPS = [
  ['start a working area (see also: git help tutorial)', ['clone', 'init']],
  ['work on the current change (see also: git help everyday)', ['add', 'restore', 'rm', 'stash']],
  ['examine the history and state (see also: git help revisions)', ['diff', 'log', 'status']],
  [
    'grow, mark and tweak your common history',
    ['branch', 'checkout', 'cherry-pick', 'commit', 'merge', 'rebase', 'reset', 'revert', 'switch', 'tag'],
  ],
  ['collaborate (see also: git help workflows)', ['fetch', 'pull', 'push']],
];

function gitUsageLines() {
  const out = [
    'usage: git [-v | --version] [-h | --help] <command> [<args>]',
    '',
    'These are common Git commands used in various situations:',
  ];
  for (const [title, names] of HELP_GROUPS) {
    out.push('', title, ...names.map((name) => `   ${name.padEnd(10)} ${GIT[name].summary}`));
  }
  out.push('', "See 'git help <command>' to read about a specific subcommand.");
  out.push([['Aide en français : tapez « help », ou « git help <commande> » (par exemple git help merge).', 'dim']]);
  return out;
}

function gitHelp(state, topic) {
  if (!topic) return ok(state, gitUsageLines(), { kind: 'help' });
  const def = GIT[topic];
  if (!def) return fail(state, `No manual entry for git${topic}`);
  const out = [
    [[`GIT-${topic.toUpperCase()}`, 'bold']],
    '',
    [['SYNOPSIS', 'bold']],
    `    ${def.usage}`,
    '',
    [['DESCRIPTION', 'bold']],
  ];
  out.push(...def.help.map((text) => `    ${text}`));
  if (def.examples) out.push('', [['EXEMPLES', 'bold']], ...def.examples.map((e) => [`    `, [e, 'cyan']]));
  return ok(state, out, { kind: 'help' });
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

function notAGitCommand(state, name) {
  const candidates = [...new Set([...Object.keys(GIT), ...REAL_GIT_COMMANDS])];
  const scored = candidates
    .map((c) => [c, c.startsWith(name) && name.length >= 3 ? 1 : levenshtein(name, c)])
    .filter(([, d]) => d <= 2);
  const best = Math.min(...scored.map(([, d]) => d));
  const similar = scored.filter(([, d]) => d === best).map(([c]) => c);
  const out = [`git: '${name}' is not a git command. See 'git --help'.`];
  if (similar.length)
    out.push(
      '',
      similar.length === 1 ? 'The most similar command is' : 'The most similar commands are',
      ...similar.map((c) => `\t${c}`),
    );
  return fail(state, out);
}

function runGit(state, args, env) {
  if (!args.length) return ok(state, gitUsageLines());
  const [name, ...rest] = args;
  if (name === '--version' || name === '-v' || name === 'version') return ok(state, [`git version ${GIT_VERSION}`]);
  if (name === '--help' || name === '-h') return gitHelp(state, rest[0]);
  if (name.startsWith('-')) return unsupported(state, `L'option globale « ${name} » n'est pas simulée.`);
  const def = GIT[name];
  if (!def) return REAL_GIT_COMMANDS.includes(name) ? unsupported(state) : notAGitCommand(state, name);
  if (rest.includes('-h')) return ok(state, [`usage: ${def.usage}`]);
  const parsed = parseOptions(rest, def);
  if (parsed.unsupported)
    return unsupported(state, `L'option « ${parsed.unsupported} » de git ${name} n'est pas simulée.`);
  if (parsed.error) return fail(state, parsed.error);
  return def.run(state, parsed, env);
}

/* ------------------------------------------------------------------ commandes du shell */

function shellArgs(args, allowed) {
  const flags = new Set();
  const names = [];
  for (const arg of args) {
    if (arg.length > 1 && arg.startsWith('-')) {
      for (const ch of arg.slice(1)) {
        if (!allowed.includes(ch)) return { bad: arg };
        flags.add(ch);
      }
    } else names.push(arg);
  }
  return { flags, names };
}

const SHELL_HELP = [
  [['Commandes du terminal', 'bold']],
  '  touch <fichier>             crée un fichier vide',
  '  echo "texte" > <fichier>    écrit dans un fichier (remplace son contenu)',
  '  echo "texte" >> <fichier>   ajoute une ligne à la fin du fichier',
  "  cat <fichier>               affiche le contenu d'un fichier",
  '  ls [-a]                     liste les fichiers (-a : y compris .git)',
  '  rm <fichier>                supprime un fichier',
  "  clear                       efface l'écran (ou Ctrl+L)",
  '',
  [['Commandes Git', 'bold']],
  '  git init                    crée un dépôt vide',
  '  git status [-s]             état du répertoire de travail et de la staging area',
  '  git add <fichier> | .       ajoute des modifications à la staging area',
  '  git commit -m "message"     enregistre un commit (-a : indexe aussi les fichiers suivis)',
  '  git log [--oneline] [--graph] [--all]',
  '  git branch [nom] [-d nom]   liste, crée ou supprime des branches',
  '  git checkout [-b] <branche> change de branche (ou crée et change)',
  '  git switch [-c] <branche>   change de branche (version moderne)',
  '  git merge <branche>         fusionne une branche dans la branche courante',
  '  git diff [--staged] [a [b]] montre les modifications (ou compare deux commits / branches)',
  '  git restore [--staged] <fichier>  annule des modifications ; --source=<commit> prend une ancienne version',
  '  git rm [--cached] <fichier> supprime un fichier suivi (ou ne le suit plus)',
  '  git commit --amend          remplace le dernier commit',
  '  git reset [--soft|--hard] [commit]  déplace la branche ; git reset <fichier> désindexe',
  '  git revert <commit>         nouveau commit qui annule un ancien commit',
  '  git cherry-pick <commit>    copie un commit sur la branche courante',
  '  git rebase <branche>        rejoue vos commits par-dessus une autre branche',
  '  git stash [pop|list|drop]   met de côté les modifications en cours',
  '  git tag [-a] [nom] [commit] liste ou crée des tags (git push origin <tag> pour les envoyer)',
  '  .gitignore                  les fichiers listés ne sont plus proposés par git status / git add .',
  '  git config --global user.name "Prénom Nom"  (et user.email, --list)',
  '  git clone <url>             copie un dépôt distant (essayez le dépôt de démonstration)',
  '  git remote [-v] | add <nom> <url> | remove <nom>',
  '  git fetch [remote]          télécharge les nouveautés sans fusionner',
  '  git pull [--rebase] [remote] [branche]  fetch + merge (ou rebase) ; git push [-u] [--force-with-lease] [remote] [branche|tag]',
  "  git help [commande]         aide d'une commande",
  '',
  [['Collègue simulé', 'bold']],
  '  collab [branche] [fichier]  Camille pousse un commit sur le dépôt distant (pour essayer fetch et pull)',
  '  mr <source> [cible]         la merge request de <source> est acceptée sur la forge (GitLab/GitHub)',
  '',
  [['Astuces', 'bold']],
  '  ↑/↓ historique · Tab complète · cmd1 && cmd2 enchaîne · clic sur un commit = insère son hash',
];

const SHELL = {
  touch: (state, args) => {
    const { bad, names } = shellArgs(args, '');
    return bad ? unsupported(state, `L'option « ${bad} » de touch n'est pas simulée.`) : git.touch(state, names);
  },
  echo: (state, args) => ok(state, [args.join(' ')]),
  cat: (state, args) => {
    const { bad, names } = shellArgs(args, '');
    if (bad || !names.length) return unsupported(state, 'Utilisation : cat <fichier>');
    return git.cat(state, names);
  },
  ls: (state, args) => {
    const { bad, flags, names } = shellArgs(args, 'a');
    if (bad) return unsupported(state, `L'option « ${bad} » de ls n'est pas simulée (seule -a l'est).`);
    if (!names.length) return git.ls(state, { all: flags.has('a') });
    const missing = names.filter((n) => !hasFile(state, n));
    const found = names.filter((n) => hasFile(state, n));
    return {
      ...ok(state, [
        ...missing.map((n) => `ls: cannot access '${n}': No such file or directory`),
        ...(found.length ? [found.join('  ')] : []),
      ]),
      ok: !missing.length,
    };
  },
  rm: (state, args) => {
    const { bad, flags, names } = shellArgs(args, 'rRf');
    if (bad) return unsupported(state, `L'option « ${bad} » de rm n'est pas simulée.`);
    return git.rm(state, names, { recursive: flags.has('r') || flags.has('R'), force: flags.has('f') });
  },
  pwd: (state) => ok(state, [git.REPO_PATH]),
  mr: (state, args, env) => {
    const { bad, names } = shellArgs(args, '');
    if (bad || !names.length || names.length > 2)
      return unsupported(state, 'Utilisation : mr <branche source> [<branche cible>]');
    return remote.mergeRequest(state, { source: names[0], target: names[1] ?? null }, env);
  },
  collab: (state, args, env) => {
    const { bad, names } = shellArgs(args, '');
    if (bad || names.length > 2) return unsupported(state, 'Utilisation : collab [branche] [fichier]');
    return remote.collab(state, { branch: names[0] ?? null, file: names[1] ?? null }, env);
  },
  clear: (state) => ({ ...ok(state), clear: true }),
  help: (state) => ok(state, SHELL_HELP),
  cd: (state) => unsupported(state, 'Ce simulateur travaille dans un seul dossier : ~/projet.'),
  mkdir: (state) =>
    unsupported(state, 'Les sous-dossiers ne sont pas simulés : tous les fichiers sont à la racine du projet.'),
};

/* ------------------------------------------------------------------ exécution */

function runCommand(state, argv, env) {
  if (!argv.length) return ok(state);
  const [name, ...args] = argv;
  if (name === 'git') return runGit(state, args, env);
  if (Object.prototype.hasOwnProperty.call(SHELL, name)) return SHELL[name](state, args, env);
  if (EDITORS.includes(name))
    return unsupported(
      state,
      'Pour modifier un fichier : echo "texte" > fichier (remplace) ou echo "texte" >> fichier (ajoute).',
    );
  return unsupported(state);
}

/**
 * Exécute une ligne complète. Ne lève jamais d'exception : une erreur interne laisse l'état intact.
 * Renvoie { state, entries } ; chaque entrée est { out, ok, explanation } ou { clear: true }.
 */
export function execute(state, input, env = git.defaultEnv) {
  const parsed = parseLine(input);
  if (parsed.error) return { state, entries: [{ out: [parsed.error], ok: false, explanation: null }] };
  if (parsed.unsupported) {
    const note = `L'opérateur « ${parsed.unsupported} » n'est pas pris en charge (seuls >, >>, && et ; le sont).`;
    return { state, entries: [{ ...unsupported(state, note), explanation: null }] };
  }
  const entries = [];
  let current = state;
  let lastOk = true;
  for (const segment of parsed.segments) {
    if (segment.op === '&&' && !lastOk) continue;
    const argv = expandGlobs(segment.words, current.workdir);
    let res;
    try {
      if (segment.redirect) {
        const check = git.writeFile(current, segment.redirect.file, '', true);
        if (!check.ok) {
          entries.push({ out: check.out, ok: false, explanation: null });
          lastOk = false;
          continue;
        }
      }
      res = runCommand(current, argv, env);
      if (segment.redirect && !res.clear) res = redirect(res, segment.redirect);
    } catch (error) {
      res = fail(current, [[[`Erreur interne du simulateur : ${error.message}. L'état n'a pas été modifié.`, 'err']]]);
    }
    if (res.clear) {
      entries.push({ clear: true });
      lastOk = true;
      continue;
    }
    current = res.state;
    lastOk = res.ok;
    entries.push({ out: res.out, ok: res.ok, explanation: safeExplain(res.info) });
  }
  return { state: current, entries };
}

/** Une phrase d'explication manquante vaut mieux qu'une commande qui plante. */
function safeExplain(info) {
  try {
    return explain(info);
  } catch {
    return null;
  }
}

function redirect(res, { file, append }) {
  const written = git.writeFile(res.state, file, res.ok ? linesToText(res.out) : '', append);
  return { ...res, state: written.state, out: res.ok ? [] : res.out };
}

/* ------------------------------------------------------------------ explications pédagogiques */

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const newCommits = (n) => (n > 1 ? `${n} nouveaux commits` : `${n} nouveau commit`);
const list = (items) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;

/** Une phrase en français qui décrit ce que la commande vient de faire. */
export function explain(info) {
  if (!info) return null;
  switch (info.kind) {
    case 'not-a-repo':
      return "Ce dossier n'est pas encore un dépôt Git : commencez par git init.";
    case 'nothing-to-commit':
      return "Rien n'a été commité : un commit ne contient que ce qui est dans la staging area, ajoutez-y vos fichiers avec git add.";
    case 'no-editor':
      return info.amend
        ? 'Ce simulateur n\'ouvre pas d\'éditeur : gardez le message avec git commit --amend --no-edit, ou donnez-en un nouveau avec git commit --amend -m "…".'
        : 'Ce simulateur n\'ouvre pas d\'éditeur de texte : donnez le message directement avec git commit -m "votre message".';
    case 'tag-no-editor':
      return 'Un tag annoté a besoin d\'un message, et ce simulateur n\'ouvre pas d\'éditeur : git tag -a v1.0 -m "Version 1.0".';
    case 'add-ignored':
      return `${list(info.paths)} correspond à un motif de .gitignore : Git refuse de l'ajouter par erreur. git add -f force l'ajout, ou retirez le motif de .gitignore.`;
    case 'init':
      return info.reinit
        ? "Le dépôt existait déjà : git init n'a rien effacé."
        : `Git a créé un dépôt vide (le dossier caché .git) : il peut maintenant suivre l'historique de ce dossier, sur la branche ${info.branch}.`;
    case 'status':
      return 'git status compare le dernier commit, la staging area et le répertoire de travail, sans rien modifier.';
    case 'add':
      if (info.resolved.length) {
        const next =
          info.op === 'rebase' || info.op === 'cherry-pick' || info.op === 'revert'
            ? `git ${info.op} --continue reprend l'opération`
            : 'git commit crée le commit de fusion';
        return `Conflit marqué comme résolu pour ${list(info.resolved)} : une fois tous les conflits résolus, ${next}.`;
      }
      if (!info.staged.length) return 'Rien de nouveau : la staging area contenait déjà cette version des fichiers.';
      return `Les modifications de ${list(info.staged)} sont maintenant dans la staging area : elles feront partie du prochain commit.`;
    case 'commit':
      if (info.amend) {
        return `Le dernier commit a été remplacé par ${info.id} : même place dans l'historique (parent ${info.parent ?? 'aucun'}), mais un nouveau hash. L'ancien commit ${info.old} n'est plus pointé par la branche (orphelin) : si vous l'aviez déjà poussé, le push sera refusé.`;
      }
      if (info.merged)
        return `Commit de fusion ${info.id} créé : il a deux parents et termine la fusion de ${info.merged}.`;
      if (!info.branch)
        return `Commit ${info.id} créé en HEAD détachée : aucune branche ne le pointe, créez-en une (git switch -c <nom>) pour ne pas le perdre.`;
      if (!info.parent)
        return `Premier commit ${info.id} : une photo de la staging area, sans parent, sur laquelle pointe désormais ${info.branch}.`;
      if (info.autoStaged.length)
        return `L'option -a a d'abord indexé ${list(info.autoStaged)}, puis le commit ${info.id} a été ajouté sur ${info.branch} à la suite de ${info.parent}.`;
      return `Commit ${info.id} créé : Git a enregistré une photo de la staging area et ${info.branch} avance d'un cran (parent : ${info.parent}).`;
    case 'log':
      if (info.mergeOnly)
        return 'git log --merge ne garde que les commits des deux côtés du conflit qui touchent les fichiers en conflit : ce sont eux qui expliquent qui a changé quoi.';
      if (info.files) return "git log -- <fichier> ne garde que les commits qui modifient ce fichier.";
      return info.graph
        ? "git log --graph dessine l'historique : chaque * est un commit, les traits montrent les bifurcations et les fusions."
        : "git log parcourt l'historique depuis HEAD, du commit le plus récent au plus ancien, en remontant les parents.";
    case 'branch-list':
      if (info.remotes)
        return 'Les branches en rouge (origin/…) sont les branches de suivi : la dernière image connue du dépôt distant.';
      return info.count
        ? "git branch liste les branches ; l'astérisque marque la branche courante, celle où iront les prochains commits."
        : "Aucune branche n'existe encore : la branche main ne sera vraiment créée qu'au premier commit.";
    case 'branch-create':
      return `La branche ${info.name} est une simple étiquette posée sur le commit ${info.id} ; HEAD ${info.current ? `reste sur ${info.current}` : "n'a pas bougé"} (git switch ${info.name} pour s'y placer).`;
    case 'branch-delete':
      return info.force
        ? `L'étiquette ${list(info.names)} a été supprimée de force : les commits qui n'étaient accessibles que par elle deviennent orphelins (en transparence dans le graphe).`
        : `L'étiquette ${list(info.names)} a été supprimée ; ses commits restent dans l'historique de la branche courante.`;
    case 'switch':
      return info.id
        ? `HEAD pointe maintenant sur ${info.branch} : le répertoire de travail reflète son dernier commit (${info.id}).`
        : `HEAD pointe maintenant sur ${info.branch}, qui n'a pas encore de commit.`;
    case 'switch-create':
      if (info.tracking) {
        return `Nouvelle branche locale ${info.branch} créée à partir de ${info.tracking}, qu'elle suit : git pull et git push savent où aller.`;
      }
      return `Nouvelle branche ${info.branch} créée ${info.id ? `sur le commit ${info.id} ` : ''}et HEAD pointe dessus : les prochains commits iront sur ${info.branch}.`;
    case 'already-on':
      return `Vous êtes déjà sur ${info.branch} : rien n'a changé.`;
    case 'detach':
      return `HEAD est détachée : elle pointe directement sur le commit ${info.id} et non sur une branche, les nouveaux commits n'appartiendraient à aucune branche.`;
    case 'restore': {
      const from = info.source ? `du commit ${info.source}` : info.staged ? 'de HEAD' : 'de la staging area';
      if (!info.paths.length) return `Rien à restaurer : les fichiers étaient déjà identiques à la version ${from}.`;
      if (info.side) {
        const which = info.side === 'ours' ? 'de votre branche (ours)' : "de l'autre branche (theirs)";
        return `${list(info.paths)} a pris la version ${which} : le conflit n'est pas résolu pour autant, terminez avec git add.`;
      }
      if (info.staged && !info.worktree)
        return `${list(info.paths)} sort de la staging area (retour à la version ${from}) : le fichier garde ses modifications mais ne fera plus partie du prochain commit.`;
      if (info.staged)
        return `${list(info.paths)} a retrouvé la version ${from}, dans la staging area comme dans le répertoire de travail.`;
      return `${list(info.paths)} a retrouvé sa version ${from} : les modifications non indexées ont été abandonnées.`;
    }
    case 'merge-ff':
      return info.from
        ? `Avance rapide (fast-forward) : ${info.into ?? 'HEAD'} n'avait pas divergé, son étiquette a simplement avancé jusqu'à ${info.to} sans créer de commit.`
        : `La branche ${info.into} pointe maintenant sur ${info.to}, comme ${info.target}.`;
    case 'merge-commit':
      return `Commit de fusion ${info.id} créé : il a deux parents et réunit l'historique de ${info.target} dans ${info.into ?? 'HEAD'}.`;
    case 'merge-uptodate':
      return `Rien à fusionner : ${info.target} fait déjà partie de l'historique de ${info.into ?? 'HEAD'}.`;
    case 'config-set':
      return info.key.startsWith('user.')
        ? `Réglage ${info.key} enregistré : il sera utilisé comme auteur de vos prochains commits.`
        : `Réglage ${info.key} = ${info.value} enregistré : git pull en tiendra compte.`;
    case 'config-list':
      return 'git config --list montre tous les réglages, y compris ceux ajoutés par git remote add (remote.*) et git push -u (branch.*).';
    case 'clone':
      return info.empty
        ? `Le dépôt ${info.url} est vide : vous avez un dépôt local relié à origin, prêt pour un premier commit puis git push -u origin ${info.branch}.`
        : `git clone a copié les ${plural(info.commits, 'commit')} de ${info.url}, enregistré ce dépôt sous le nom origin et créé ${info.branch}, qui suit origin/${info.branch}.`;
    case 'remote-list':
      return info.count
        ? 'git remote liste les dépôts distants connus ; origin est le nom habituel du dépôt hébergé sur la forge (GitHub, GitLab).'
        : 'Aucun dépôt distant pour le moment : ajoutez-en un avec git remote add origin <url>.';
    case 'remote-add':
      return `Le dépôt distant ${info.name} est enregistré${info.created ? ' (dépôt vide, comme un projet tout juste créé sur GitHub)' : ''} : rien n'est envoyé tant que vous ne faites pas git push.`;
    case 'remote-remove':
      return `Le dépôt distant ${info.name} est oublié localement, avec ses branches de suivi ; le dépôt sur la forge, lui, n'est pas touché.`;
    case 'fetch':
      if (info.commits) {
        return `git fetch a téléchargé ${newCommits(info.commits)} de ${info.remote} et mis à jour les branches de suivi (en contour pointillé dans le graphe), sans toucher à vos branches ni à vos fichiers.`;
      }
      return info.refs
        ? 'Les branches de suivi ont été mises à jour ; aucun nouveau commit à télécharger.'
        : `Rien de nouveau sur ${info.remote} : vos branches de suivi étaient déjà à jour.`;
    case 'push':
      if (info.rejected === 'fetch first') {
        return `Push refusé : ${info.remote} contient des commits que vous n'avez pas. Récupérez-les d'abord avec git pull, puis poussez à nouveau.`;
      }
      if (info.rejected === 'non-fast-forward') {
        return `Push refusé : votre branche et ${info.remote} ont divergé. Si c'est parce que vous avez réécrit l'historique (rebase, amend, reset), poussez avec git push --force-with-lease ; sinon intégrez d'abord les commits distants avec git pull.`;
      }
      if (info.rejected === 'stale info')
        return `--force-with-lease a refusé d'écraser ${info.remote} : quelqu'un y a poussé depuis votre dernier fetch. Faites git fetch, regardez ce qui est arrivé, puis réessayez.`;
      if (info.rejected === 'already exists')
        return `Un tag du même nom existe déjà sur ${info.remote} avec un autre contenu : un tag publié ne doit pas bouger. Choisissez un nouveau nom (ou --force si vous savez ce que vous faites).`;
      if (info.deletedTags?.length) return `Le tag ${list(info.deletedTags)} a été supprimé sur ${info.remote}.`;
      if (info.tags?.length)
        return `Le tag ${list(info.tags)} est maintenant sur ${info.remote} : les tags ne partent jamais avec un simple git push, il faut les envoyer explicitement.`;
      if (info.deleted.length) return `La branche ${list(info.deleted)} a été supprimée sur ${info.remote}.`;
      if (info.created.length) {
        return `git push a envoyé vos commits : la branche ${list(info.created)} existe maintenant sur ${info.remote}, et ${info.remote}/${info.created[0]} la représente en local.`;
      }
      if (info.updated.length)
        return `git push a envoyé vos nouveaux commits : ${info.remote}/${info.updated[0]} rejoint votre branche locale.`;
      return info.upToDate ? `Rien à envoyer : ${info.remote} a déjà tous vos commits.` : null;
    case 'push-no-upstream':
      return `Git ne sait pas encore où envoyer ${info.branch} : la première fois, utilisez git push -u origin ${info.branch} (-u mémorise la destination).`;
    case 'push-no-remote':
      return "Aucun dépôt distant n'est configuré : ajoutez-en un avec git remote add origin <url>, ou partez d'un git clone.";
    case 'pull': {
      const got = info.fetched
        ? `${newCommits(info.fetched)} téléchargé${info.fetched > 1 ? 's' : ''}`
        : 'aucun commit à télécharger (déjà présents localement)';
      switch (info.merge?.kind) {
        case 'merge-ff':
          return `git pull = git fetch + git merge : ${got}, puis votre branche a avancé en avance rapide jusqu'à ${info.merge.to}.`;
        case 'merge-commit':
          return `git pull = git fetch + git merge : ${got}, puis fusionné${info.fetched > 1 ? 's' : ''} dans votre branche par le commit ${info.merge.id} (deux parents).`;
        case 'merge-uptodate':
          return `git pull : ${got} ; votre branche contient déjà tout ${info.remote}/${info.branch}.`;
        case 'merge-conflict':
          return explain(info.merge);
        case 'rebase':
          return `git pull --rebase = git fetch + git rebase : ${got}, puis ${
            info.merge.ff
              ? `votre branche a simplement avancé jusqu'à ${info.remote}/${info.branch}`
              : `vos ${plural(info.merge.count, 'commit')} ${info.merge.count > 1 ? 'ont été rejoués' : 'a été rejoué'} par-dessus : l'historique reste linéaire, sans commit de fusion`
          }.`;
        case 'rebase-conflict':
          return explain(info.merge);
        default:
          return null;
      }
    }
    case 'pull-divergent':
      return `Votre branche et ${info.ref} ont chacune des commits que l'autre n'a pas. Pour les fusionner : git pull --no-rebase (commit de fusion), ou git pull --rebase (vos commits sont rejoués par-dessus ceux du distant). Une fois pour toutes : git config pull.rebase false (ou true).`;
    case 'pull-no-tracking':
      return 'Cette branche ne suit aucune branche distante : précisez-la (git pull origin main) ou poussez-la avec git push -u.';
    case 'branch-upstream':
      return `${info.name} suit désormais ${info.upstream} : git status, git pull et git push savent avec quelle branche distante comparer.`;
    case 'branch-unset-upstream':
      return `${info.name} ne suit plus aucune branche distante.`;
    case 'collab':
      return `Un collègue a poussé sur ${info.remote}/${info.branch} : votre dépôt local ne le sait pas encore. git fetch pour le voir, git pull pour le récupérer et le fusionner.`;
    case 'mr':
      return `La fusion a eu lieu sur la forge, pas chez vous : faites git switch ${info.into} puis git pull pour récupérer le commit de fusion ${info.id}.`;
    case 'mr-conflict':
      return 'La forge ne sait pas résoudre un conflit : il faut le régler en local, sur votre branche, puis pousser de nouveau.';
    case 'merge-conflict':
      return `Conflit : les deux branches ont modifié ${list(info.paths)} différemment. Corrigez (par exemple echo "…" > ${info.paths[0]}, ou git checkout --ours|--theirs ${info.paths[0]} pour garder un seul côté), puis git add et git commit, ou annulez avec git merge --abort.`;
    case 'merge-abort':
      return "Fusion annulée : la staging area et le répertoire de travail sont revenus à leur état d'avant git merge.";
    case 'reset': {
      if (info.id === info.from && !info.mode.includes('hard'))
        return 'HEAD est resté sur le même commit : git reset a seulement réaligné la staging area sur lui.';
      const where = `${info.branch ?? 'HEAD'} pointe maintenant sur ${info.id}`;
      if (info.mode === 'soft')
        return `${where} (git reset --soft) : les commits suivants sont défaits, mais leurs modifications restent dans la staging area, prêtes à être recommitées.`;
      if (info.mode === 'hard')
        return `${where} (git reset --hard) : la staging area et les fichiers suivis ont été remis dans l'état de ce commit, les modifications non commitées sont perdues. Les commits écartés n'existent plus que comme orphelins (en transparence dans le graphe) : git reset --hard ${info.from} les rétablit.`;
      return `${where} (git reset --mixed) : la staging area est remise à zéro, mais vos fichiers gardent leurs modifications : il suffit de refaire git add puis git commit.`;
    }
    case 'reset-paths':
      return `${list(info.paths)} sort de la staging area (git reset <fichier> est l'inverse de git add) : le fichier garde ses modifications mais ne fera plus partie du prochain commit.`;
    case 'pick':
      if (info.noCommit)
        return `Les modifications sont appliquées à la staging area et au répertoire de travail, sans commit : à vous de faire git commit (ou git restore pour les abandonner).`;
      if (info.pickKind === 'revert')
        return `git revert n'efface rien de l'historique : il ajoute un nouveau commit ${list(info.created)} qui annule les modifications de l'ancien. C'est la façon sûre de défaire un commit déjà partagé.`;
      return `git cherry-pick a copié ${plural(info.created.length, 'commit')} sur la branche courante : mêmes modifications mais ${info.created.length > 1 ? 'nouveaux hash' : 'nouveau hash'} (${list(info.created)}). Les commits d'origine n'ont pas bougé.`;
    case 'pick-conflict':
      return `Conflit sur ${list(info.paths)} : le ${info.pickKind} s'est arrêté. Corrigez le fichier, git add, puis git ${info.pickKind} --continue ; ou git ${info.pickKind} --skip pour ignorer ce commit, git ${info.pickKind} --abort pour tout annuler.`;
    case 'pick-empty':
      return `Ce ${info.pickKind} ne change rien : les modifications du commit sont déjà présentes dans la branche courante, donc aucun commit n'est créé.`;
    case 'pick-continue':
      return `Le ${info.pickKind} est terminé.`;
    case 'pick-skip':
      return `Le commit en conflit est ignoré : le ${info.pickKind} continue avec la suite.`;
    case 'pick-abort':
      return `${info.pickKind === 'revert' ? 'Revert' : 'Cherry-pick'} annulé : la branche, la staging area et les fichiers sont revenus à leur état d'avant.`;
    case 'rebase':
      if (info.ff)
        return `Avance rapide : votre branche n'avait aucun commit propre, elle a simplement avancé jusqu'à ${info.upstream}, sans rien rejouer.`;
      if (!info.count)
        return `Aucun commit n'a été rejoué${info.dropped ? ` (${plural(info.dropped, 'commit')} ignoré${info.dropped > 1 ? 's' : ''} : déjà présent${info.dropped > 1 ? 's' : ''} côté ${info.upstream})` : ''} : ${info.branch ?? 'HEAD'} pointe maintenant sur le même commit que ${info.upstream}.`;
      return `git rebase a rejoué ${plural(info.count, 'commit')}${info.branch ? ` de ${info.branch}` : ''} par-dessus ${info.upstream} : même contenu, mais de NOUVEAUX commits (les anciens, en transparence dans le graphe, sont orphelins). L'historique est linéaire, sans commit de fusion.${info.dropped ? ` ${plural(info.dropped, 'commit')} ignoré${info.dropped > 1 ? 's' : ''} : déjà présent${info.dropped > 1 ? 's' : ''} côté ${info.upstream}.` : ''} Si ces commits avaient déjà été poussés, le prochain push demandera --force-with-lease : ne réécrivez jamais un historique partagé.`;
    case 'rebase-uptodate':
      return `Rien à rejouer : la branche contient déjà tout ${info.upstream}.`;
    case 'rebase-conflict':
      return `Le rebase s'est arrêté sur le commit ${info.id}, en conflit sur ${list(info.paths)}. Corrigez, git add, puis git rebase --continue ; ou git rebase --skip pour ignorer ce commit, git rebase --abort pour tout annuler. Pendant un rebase, « ours » est la branche sur laquelle on rejoue, « theirs » le commit rejoué.`;
    case 'rebase-abort':
      return `Rebase annulé : ${info.branch ?? 'HEAD'}, la staging area et les fichiers sont revenus à leur état d'avant.`;
    case 'rebase-dirty':
      return 'Un rebase refuse de partir avec des modifications non commitées : commitez-les, ou mettez-les de côté avec git stash puis reprenez-les avec git stash pop.';
    case 'rebase-no-upstream':
      return 'Précisez la branche de référence : git rebase main (ou git rebase origin/main).';
    case 'tag-list':
      return info.count
        ? 'git tag liste les tags : des noms posés sur des commits précis, qui ne bougent pas (contrairement aux branches).'
        : "Aucun tag pour le moment : git tag v1.0 en pose un sur le commit courant.";
    case 'tag-create':
      if (info.updated) return `Le tag ${info.name} pointe maintenant sur ${info.id} (il a été déplacé de force).`;
      return `Tag ${info.annotated ? 'annoté' : 'léger'} ${info.name} posé sur ${info.id}. ${info.annotated ? 'Il garde un message, un auteur et une date. ' : ''}Il reste local tant que vous ne le poussez pas : git push origin ${info.name}.`;
    case 'tag-delete':
      return `Tag ${list(info.names)} supprimé en local. Sur le dépôt distant il existe encore : git push origin --delete ${info.names[0]} pour l'y supprimer aussi.`;
    case 'stash-push':
      return `Vos modifications sont rangées dans la pile (stash@{0}) et le répertoire de travail est revenu à l'état du dernier commit${info.untracked ? ' (fichiers non suivis compris)' : ''}. git stash pop les remet.`;
    case 'stash-none':
      return 'Rien à mettre de côté : git stash ne range que les modifications des fichiers suivis (ajoutez -u pour les fichiers non suivis).';
    case 'stash-list':
      return info.count
        ? 'La pile du stash : stash@{0} est la plus récente. git stash pop reprend celle du dessus.'
        : 'La pile est vide : rien n\'a été mis de côté.';
    case 'stash-apply':
      if (info.conflicts.length)
        return `Le stash a été appliqué mais ${list(info.conflicts)} est en conflit avec des changements récents : les marqueurs sont dans le fichier. Corrigez-le puis git add ; le stash est conservé tant que vous ne faites pas git stash drop.`;
      return info.pop
        ? 'git stash pop a remis les modifications dans le répertoire de travail et retiré cette entrée de la pile.'
        : 'git stash apply a remis les modifications dans le répertoire de travail ; l\'entrée reste dans la pile (git stash drop pour la supprimer).';
    case 'stash-drop':
      return `L'entrée stash@{${info.n}} est supprimée de la pile : ses modifications ne seront pas remises.`;
    case 'stash-clear':
      return info.count ? 'La pile du stash est vidée.' : 'La pile était déjà vide.';
    case 'stash-show':
      return 'git stash show résume ce que contient une entrée du stash (-p pour le détail).';
    case 'stash-branch':
      return `Branche ${info.name} créée sur le commit où le stash avait été fait, stash appliqué puis supprimé de la pile : le moyen sûr de reprendre un travail mis de côté qui ne s'applique plus proprement.`;
    case 'git-rm':
      return info.cached
        ? `${list(info.paths)} n'est plus suivi par Git, mais reste dans votre dossier (la suppression sera enregistrée au prochain commit). Pensez à l'ajouter à .gitignore.`
        : `${list(info.paths)} est supprimé du dossier et de la staging area : la suppression sera enregistrée au prochain commit.`;
    case 'git-rm-refused':
      return 'Git protège votre travail : il refuse de supprimer un fichier modifié. --cached ne le retire que du suivi, -f force.';
    case 'check-ignore':
      return info.count
        ? 'Ces fichiers sont ignorés : git status ne les montre pas et git add . les saute.'
        : "Aucun de ces fichiers n'est ignoré par .gitignore.";
    case 'diff':
      if (info.revs === 2)
        return info.empty
          ? 'Les deux commits ont exactement le même contenu : aucune différence.'
          : 'git diff <a> <b> compare directement le contenu de deux commits (ou branches) : - = version de a, + = version de b.';
      if (info.revs === 1)
        return info.empty
          ? 'Le répertoire de travail est identique à ce commit.'
          : 'git diff <commit> compare ce commit au répertoire de travail (staging area comprise) : - = ce que le commit contenait, + = ce que vous avez maintenant.';
      if (info.staged) {
        return info.empty
          ? "La staging area est identique au dernier commit : rien n'est prêt à être commité."
          : 'git diff --staged montre ce qui est dans la staging area et partira dans le prochain commit.';
      }
      return info.empty
        ? 'Aucune modification non indexée : le répertoire de travail correspond à la staging area.'
        : 'git diff montre les modifications du répertoire de travail qui ne sont pas encore dans la staging area (- retiré, + ajouté).';
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ autocomplétion et invite */

/** Propositions pour le dernier mot de `before` (texte situé avant le curseur). */
export function getCompletions(state, before) {
  const segment = before.split(/&&|;/).pop().replace(/^\s+/, '');
  const words = segment.split(/\s+/);
  const prefix = words.pop() ?? '';
  const candidates = candidatesFor(state, words, prefix);
  const matches = [...new Set(candidates)].filter((c) => c.startsWith(prefix)).sort();
  return { prefix, matches: matches.map((m) => m.replace(/ /g, '\\ ')) };
}

function candidatesFor(state, words, prefix) {
  const files = Object.keys(state.workdir);
  if (!words.length) return [...Object.keys(SHELL).filter((c) => c !== 'cd' && c !== 'mkdir'), 'git'];
  const last = words[words.length - 1];
  if (last === '>' || last === '>>' || /[^>]>>?$/.test(last)) return files;
  const [command, sub] = words;
  if (command !== 'git') return ['cat', 'rm', 'touch'].includes(command) ? files : [];
  if (words.length === 1) return Object.keys(GIT);
  const def = GIT[sub];
  if (!def) return [];
  if (prefix.startsWith('-')) {
    return Object.keys(def.options ?? {}).map((o) => (o.length === 1 ? `-${o}` : `--${o}`));
  }
  return def.complete ? def.complete(state, words.slice(2), prefix) : [];
}

/** Informations pour l'invite `~/projet (main) $`. */
export function promptInfo(state) {
  const repo = state.repo;
  if (!repo) return { label: null, branch: null };
  const detached = repo.head.type === 'detached';
  let name = detached ? `(${repo.head.commit}...)` : repo.head.name;
  let branch = detached ? null : repo.head.name;
  let phase = '';
  if (repo.merge) phase = '|MERGING';
  else if (repo.rebase) {
    ({ branch } = repo.rebase);
    name = branch ?? name;
    phase = `|REBASE ${repo.rebase.step}/${repo.rebase.total}`;
  } else if (repo.pick) phase = repo.pick.kind === 'revert' ? '|REVERTING' : '|CHERRY-PICKING';
  return { label: `${name}${phase}`, branch };
}
