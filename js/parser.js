/**
 * Analyse de la saisie (mini-shell) et production de la sortie texte.
 * Ne touche jamais au DOM : renvoie des lignes que le terminal se charge d'afficher.
 */
import * as git from './engine.js';
import * as remote from './remote.js';

const GIT_VERSION = '2.47.0';
const UNSUPPORTED = 'Commande non supportée dans ce simulateur.';
const EDITORS = ['nano', 'vim', 'vi', 'emacs', 'code', 'gedit', 'notepad'];

// Sous-commandes réelles de Git : distingue « non supportée » d'une faute de frappe.
// prettier-ignore
const REAL_GIT_COMMANDS = [
  'am', 'apply', 'archive', 'bisect', 'blame', 'bundle', 'cat-file', 'citool', 'clean', 'config', 'describe',
  'difftool', 'format-patch', 'fsck', 'gc', 'grep', 'gui', 'hash-object', 'ls-files', 'ls-tree', 'maintenance',
  'mergetool', 'mv', 'notes', 'prune', 'range-diff', 'reflog', 'restore', 'rev-parse', 'rm', 'shortlog', 'show',
  'show-ref', 'sparse-checkout', 'submodule', 'whatchanged', 'worktree', ...git.PLANNED_COMMANDS,
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
    usage: 'git add [-A] [<pathspec>...]',
    help: [
      "Place la version actuelle des fichiers dans la staging area (l'index) : ils feront partie du prochain commit.",
      'git add . ajoute tous les fichiers modifiés ou nouveaux.',
    ],
    examples: ['git add README.md', 'git add .'],
    options: { A: flag('all'), all: flag('all') },
    complete: (state) => ['.', ...changedFiles(state)],
    run: (state, { opts, positional, paths }) => git.add(state, { paths: [...positional, ...paths], all: !!opts.all }),
  },
  commit: {
    summary: 'Record changes to the repository',
    usage: 'git commit [-a] -m <msg>',
    help: [
      "Enregistre une « photo » de la staging area dans l'historique, avec un message.",
      "Option -a : indexe d'abord automatiquement les fichiers déjà suivis qui ont été modifiés.",
    ],
    examples: ['git commit -m "Ajoute la page d\'accueil"', 'git commit -am "Corrige une faute"'],
    options: {
      a: flag('all'),
      all: flag('all'),
      m: valued('message', true),
      message: valued('message', true),
      'allow-empty': flag('allowEmpty'),
    },
    run: (state, { opts, positional, paths }, env) => {
      if (positional.length || paths.length)
        return unsupported(state, "Le commit de fichiers précis (git commit <fichier>) n'est pas simulé.");
      return git.commit(
        state,
        { message: opts.message ? opts.message.join('\n\n') : null, all: !!opts.all, allowEmpty: !!opts.allowEmpty },
        env,
      );
    },
  },
  log: {
    summary: 'Show commit logs',
    usage: 'git log [--oneline] [--graph] [--all] [-n <number>] [<revision>]',
    help: [
      "Affiche l'historique des commits, du plus récent au plus ancien.",
      '--oneline : une ligne par commit ; --graph : dessine les branches ; --all : toutes les branches.',
    ],
    examples: ['git log --oneline --graph --all'],
    options: {
      oneline: flag('oneline'),
      graph: flag('graph'),
      all: flag('all'),
      decorate: flag('decorate'),
      n: valued('maxCount'),
      'max-count': valued('maxCount'),
    },
    numeric: 'maxCount',
    complete: branchNames,
    run: (state, { opts, positional, paths }) => {
      if (paths.length) return unsupported(state, "Le filtrage de git log par fichier n'est pas simulé.");
      const maxCount = opts.maxCount === undefined ? Infinity : Number(opts.maxCount);
      if (!Number.isInteger(maxCount) && maxCount !== Infinity)
        return fail(state, `fatal: '${opts.maxCount}': not an integer`);
      return git.log(state, {
        oneline: !!opts.oneline,
        graph: !!opts.graph,
        all: !!opts.all,
        revs: positional,
        maxCount,
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
    usage: 'git checkout [-b <new-branch>] <branch> | git checkout <commit> | git checkout -- <file>...',
    help: [
      'Déplace HEAD sur une branche (ou un commit : HEAD détachée) et met à jour le répertoire de travail.',
      "git checkout -b <nom> crée la branche et s'y place.",
      "git checkout -- <fichier> annule les modifications non indexées d'un fichier.",
    ],
    examples: ['git checkout feature', 'git checkout -b feature'],
    options: { b: valued('newBranch'), detach: flag('detach') },
    complete: (state) => [...branchNames(state), ...remoteShortNames(state), ...trackedFiles(state)],
    run: (state, { opts, positional, paths, dashDash }) => {
      const newBranch = opts.newBranch ?? null;
      if (dashDash)
        return positional.length
          ? unsupported(state, "La restauration depuis un autre commit n'est pas simulée.")
          : git.checkout(state, { paths, quiet: true });
      if (positional.length > 1) {
        const firstIsRevision = state.repo && git.resolveRevision(state.repo, positional[0]);
        if (newBranch === null && !firstIsRevision) return git.checkout(state, { paths: positional });
        return unsupported(state, "La restauration depuis un autre commit n'est pas simulée.");
      }
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
    usage: 'git diff [--staged] [<file>...]',
    help: [
      'Sans option : montre les modifications du répertoire de travail pas encore indexées.',
      '--staged (ou --cached) : montre ce qui est dans la staging area, prêt pour le prochain commit.',
    ],
    examples: ['git diff', 'git diff --staged'],
    options: { staged: flag('staged'), cached: flag('staged') },
    complete: trackedFiles,
    run: (state, { opts, positional, paths }) => {
      const files = [...positional, ...paths];
      const isRevision = (p) => state.repo && !hasFile(state, p) && git.resolveRevision(state.repo, p);
      if (positional.some(isRevision))
        return unsupported(state, "La comparaison entre commits (git diff <commit>) n'est pas simulée.");
      return git.diff(state, { staged: !!opts.staged, paths: files });
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
    usage: 'git pull [--ff-only] [--no-rebase] [<remote> [<branch>]]',
    help: [
      'Récupère les commits du dépôt distant (git fetch) puis les fusionne dans la branche courante (git merge).',
      'Si votre branche et la branche distante ont chacune des commits nouveaux, Git demande comment réconcilier : ajoutez --no-rebase pour fusionner.',
    ],
    examples: ['git pull', 'git pull --no-rebase'],
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
      if (opts.rebase)
        return unsupported(state, 'git pull --rebase repose sur git rebase, prévu dans une prochaine version.');
      if (positional.length > 2) return unsupported(state, "Le pull de plusieurs branches n'est pas simulé.");
      const res = remote.pull(
        state,
        {
          remote: positional[0] ?? null,
          branch: positional[1] ?? null,
          ffOnly: !!opts.ffOnly,
          noRebase: !!opts.noRebase,
          noFF: !!opts.noFF,
        },
        env,
      );
      return withRemoteHint(state, positional[0], res, 'pull');
    },
  },
  push: {
    summary: 'Update remote refs along with associated objects',
    usage: 'git push [-u] [-f] [<remote> [<branch>]] | git push <remote> --delete <branch>',
    help: [
      "Envoie vos commits vers le dépôt distant. Le push est refusé si le dépôt distant contient des commits que vous n'avez pas : faites d'abord git pull.",
      '-u (--set-upstream) mémorise la branche distante à suivre : ensuite, git push et git pull suffisent. --delete supprime une branche distante.',
    ],
    examples: ['git push -u origin main', 'git push', 'git push origin --delete feature'],
    options: {
      u: flag('setUpstream'),
      'set-upstream': flag('setUpstream'),
      f: flag('force'),
      force: flag('force'),
      d: flag('delete'),
      delete: flag('delete'),
    },
    complete: (state, args) =>
      args.filter((a) => !a.startsWith('-')).length ? branchNames(state) : remoteNames(state),
    run: (state, { opts, positional }) =>
      withRemoteHint(
        state,
        positional[0],
        remote.push(state, {
          remote: positional[0] ?? null,
          refspecs: positional.slice(1),
          setUpstream: !!opts.setUpstream,
          force: !!opts.force,
          del: !!opts.delete,
        }),
        'push',
      ),
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
  ['work on the current change (see also: git help everyday)', ['add']],
  ['examine the history and state (see also: git help revisions)', ['diff', 'log', 'status']],
  ['grow, mark and tweak your common history', ['branch', 'checkout', 'commit', 'merge', 'switch']],
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
  if (!def) {
    if (git.PLANNED_COMMANDS.includes(topic))
      return ok(state, [
        [[`git ${topic} n'est pas encore simulée : elle est prévue dans une prochaine version.`, 'dim']],
      ]);
    return fail(state, `No manual entry for git${topic}`);
  }
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
  if (!def) {
    if (git.PLANNED_COMMANDS.includes(name))
      return unsupported(state, `git ${name} est prévue pour une prochaine version du simulateur.`);
    if (REAL_GIT_COMMANDS.includes(name)) return unsupported(state);
    return notAGitCommand(state, name);
  }
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
  '  git diff [--staged]         montre les modifications',
  '  git config --global user.name "Prénom Nom"  (et user.email, --list)',
  '  git clone <url>             copie un dépôt distant (essayez le dépôt de démonstration)',
  '  git remote [-v] | add <nom> <url> | remove <nom>',
  '  git fetch [remote]          télécharge les nouveautés sans fusionner',
  '  git pull [remote] [branche] fetch + merge ; git push [-u] [remote] [branche]',
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
    entries.push({ out: res.out, ok: res.ok, explanation: explain(res.info) });
  }
  return { state: current, entries };
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
      return 'Ce simulateur n\'ouvre pas d\'éditeur de texte : donnez le message directement avec git commit -m "votre message".';
    case 'init':
      return info.reinit
        ? "Le dépôt existait déjà : git init n'a rien effacé."
        : `Git a créé un dépôt vide (le dossier caché .git) : il peut maintenant suivre l'historique de ce dossier, sur la branche ${info.branch}.`;
    case 'status':
      return 'git status compare le dernier commit, la staging area et le répertoire de travail, sans rien modifier.';
    case 'add':
      if (info.resolved.length)
        return `Conflit marqué comme résolu pour ${list(info.resolved)} : une fois tous les conflits résolus, git commit crée le commit de fusion.`;
      if (!info.staged.length) return 'Rien de nouveau : la staging area contenait déjà cette version des fichiers.';
      return `Les modifications de ${list(info.staged)} sont maintenant dans la staging area : elles feront partie du prochain commit.`;
    case 'commit':
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
    case 'restore':
      return info.paths.length
        ? `${list(info.paths)} a retrouvé sa version de la staging area : les modifications non indexées ont été abandonnées.`
        : 'Rien à restaurer : les fichiers étaient déjà identiques à la staging area.';
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
      if (info.rejected === 'fetch first' || info.rejected === 'non-fast-forward') {
        return `Push refusé : ${info.remote} contient des commits que vous n'avez pas. Récupérez-les d'abord avec git pull, puis poussez à nouveau.`;
      }
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
        default:
          return null;
      }
    }
    case 'pull-divergent':
      return `Votre branche et ${info.ref} ont chacune des commits que l'autre n'a pas. Pour les fusionner : git pull --no-rebase (ou une fois pour toutes : git config pull.rebase false).`;
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
      return `Conflit : les deux branches ont modifié ${list(info.paths)} différemment. Corrigez (par exemple echo "…" > ${info.paths[0]}), puis git add et git commit, ou annulez avec git merge --abort.`;
    case 'merge-abort':
      return "Fusion annulée : la staging area et le répertoire de travail sont revenus à leur état d'avant git merge.";
    case 'diff':
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
  return {
    label: `${detached ? `(${repo.head.commit}...)` : repo.head.name}${repo.merge ? '|MERGING' : ''}`,
    branch: detached ? null : repo.head.name,
  };
}
