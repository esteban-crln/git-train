/**
 * Commandes qui parlent à un dépôt distant : remote, fetch, push, pull, clone.
 *
 * « GitHub » est simulé par state.servers : un dépôt distant par URL, avec ses propres commits et
 * branches. Le dépôt local n'en voit que ce qu'il a récupéré : les branches de suivi (origin/main)
 * sont une copie locale de l'état du serveur au dernier fetch ou push.
 * Même contrat que le moteur : état en entrée, { state, out, ok, info } en sortie, sans effet de bord.
 */
import {
  COLLEAGUE,
  DEMO_URL,
  ancestors,
  byteOrder,
  clone,
  createRepo,
  currentBranch,
  defaultEnv,
  emptyServer,
  failure,
  get,
  hasOwn,
  headCommitId,
  isAncestor,
  isValidBranchName,
  merge,
  plural,
  requireRepo,
  success,
} from './engine.js';

const displayUrl = (url) => url.replace(/\.git$/, '');

function splitRef(ref) {
  const i = ref.indexOf('/');
  return { remote: ref.slice(0, i), branch: ref.slice(i + 1) };
}

const unreachable = (name) => [
  `fatal: '${name}' does not appear to be a git repository`,
  'fatal: Could not read from remote repository.',
  '',
  'Please make sure you have the correct access rights',
  'and the repository exists.',
];

/** Remote par défaut : celui de la branche courante, sinon origin. */
function defaultRemote(repo) {
  const branch = currentBranch(repo);
  const upstream = branch ? get(repo.upstreams, branch) : undefined;
  if (upstream) return splitRef(upstream).remote;
  return hasOwn(repo.remotes, 'origin') ? 'origin' : null;
}

/** Une ligne du résumé de fetch ou de push, alignée comme dans Git. */
const refLine = (flag, summary, from, to, width, note = '') =>
  ` ${flag} ${summary.padEnd(17)} ${from.padEnd(width)} -> ${to}${note}`;

/** Copie dans `target` les commits de `source` accessibles depuis `tips`, parents avant enfants. */
function copyCommits(source, target, tips) {
  const missing = [...ancestors(source, ...tips)]
    .filter((id) => !hasOwn(target.commits, id))
    .sort((a, b) => source.commits[a].seq - source.commits[b].seq);
  for (const id of missing) {
    const c = source.commits[id];
    target.commits[id] = {
      ...c,
      parents: [...c.parents],
      author: { ...c.author },
      tree: { ...c.tree },
      seq: ++target.seq,
    };
  }
  return missing;
}

function registerLanes(repo, ids) {
  for (const id of ids) {
    const lane = repo.commits[id].lane;
    if (lane && !repo.lanes.includes(lane)) repo.lanes.push(lane);
  }
}

/** Met à jour les branches de suivi de `remote` dans `s` (copie modifiable). */
function fetchInto(s, remote, { prune = false } = {}) {
  const repo = s.repo;
  const url = repo.remotes[remote].url;
  const server = s.servers[url];
  const changes = [];
  let newCommits = 0;
  for (const branch of Object.keys(server.branches).sort(byteOrder)) {
    const ref = `${remote}/${branch}`;
    const tip = server.branches[branch];
    const old = get(repo.remoteRefs, ref);
    if (old === tip) continue;
    const copied = copyCommits(server, repo, [tip]);
    registerLanes(repo, copied);
    if (!repo.lanes.includes(branch)) repo.lanes.push(branch);
    newCommits += copied.length;
    repo.remoteRefs[ref] = tip;
    changes.push({ branch, ref, old, tip, forced: old !== undefined && !isAncestor(repo, old, tip) });
  }
  if (prune) {
    for (const ref of Object.keys(repo.remoteRefs).sort(byteOrder)) {
      if (splitRef(ref).remote !== remote || hasOwn(server.branches, splitRef(ref).branch)) continue;
      delete repo.remoteRefs[ref];
      changes.push({ branch: '(none)', ref, deleted: true });
    }
  }
  if (!changes.length) return { lines: [], changes, newCommits };
  // Comme Git, la colonne des noms fait au moins 10 caractères dans la sortie de fetch.
  const width = Math.max(10, ...changes.map((c) => c.branch.length));
  const lines = changes.map((c) => {
    if (c.deleted) return refLine('-', '[deleted]', c.branch, c.ref, width);
    if (c.old === undefined) return refLine('*', '[new branch]', c.branch, c.ref, width);
    if (c.forced) return refLine('+', `${c.old}...${c.tip}`, c.branch, c.ref, width, ' (forced update)');
    return refLine(' ', `${c.old}..${c.tip}`, c.branch, c.ref, width);
  });
  return { lines: [`From ${displayUrl(url)}`, ...lines], changes, newCommits };
}

/* ------------------------------------------------------------------ git remote */

export function remoteList(state, { verbose = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const { remotes } = state.repo;
  const names = Object.keys(remotes).sort(byteOrder);
  const out = names.flatMap((name) =>
    verbose ? [`${name}\t${remotes[name].url} (fetch)`, `${name}\t${remotes[name].url} (push)`] : [name],
  );
  return success(state, out, { kind: 'remote-list', count: names.length });
}

export function remoteAdd(state, { name, url }) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return failure(state, `fatal: '${name}' is not a valid remote name`);
  if (hasOwn(repo.remotes, name)) return failure(state, `error: remote ${name} already exists.`);
  if (!url || /\s/.test(url) || url === '__proto__' || url.startsWith('-')) {
    return failure(state, `fatal: '${url}' is not a valid remote URL`);
  }
  const s = clone(state);
  s.repo.remotes[name] = { url };
  const created = !hasOwn(s.servers, url);
  if (created) s.servers[url] = emptyServer();
  return success(s, [], { kind: 'remote-add', name, url, created });
}

export function remoteRemove(state, { name }) {
  const error = requireRepo(state);
  if (error) return error;
  if (!hasOwn(state.repo.remotes, name)) return failure(state, `error: No such remote: '${name}'`);
  const s = clone(state);
  const repo = s.repo;
  delete repo.remotes[name];
  for (const ref of Object.keys(repo.remoteRefs)) if (splitRef(ref).remote === name) delete repo.remoteRefs[ref];
  for (const [branch, upstream] of Object.entries(repo.upstreams)) {
    if (splitRef(upstream).remote === name) delete repo.upstreams[branch];
  }
  return success(s, [], { kind: 'remote-remove', name });
}

/* ------------------------------------------------------------------ git fetch */

export function fetch(state, { remote = null, all = false, prune = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  let names;
  if (all) names = Object.keys(repo.remotes).sort(byteOrder);
  else {
    const name = remote ?? defaultRemote(repo);
    if (name === null) {
      return failure(state, [
        'fatal: No remote repository specified.  Please, specify either a URL or a',
        'remote name from which new revisions should be fetched.',
      ]);
    }
    if (!hasOwn(repo.remotes, name)) return failure(state, unreachable(name));
    names = [name];
  }
  const s = clone(state);
  const lines = [];
  let commits = 0;
  let refs = 0;
  for (const name of names) {
    const fetched = fetchInto(s, name, { prune });
    lines.push(...fetched.lines);
    commits += fetched.newCommits;
    refs += fetched.changes.length;
  }
  return success(refs ? s : state, lines, { kind: 'fetch', remote: names.join(', ') || 'origin', refs, commits });
}

/* ------------------------------------------------------------------ git push */

const NO_DESTINATION = [
  'fatal: No configured push destination.',
  'Either specify the URL from the command-line or configure a remote repository using',
  '',
  '    git remote add <name> <url>',
  '',
  'and then push using the remote name',
  '',
  '    git push <name>',
  '',
];

const PUSH_HINTS = {
  'fetch first': [
    'hint: Updates were rejected because the remote contains work that you do not',
    'hint: have locally. This is usually caused by another repository pushing to',
    'hint: the same ref. If you want to integrate the remote changes, use',
    "hint: 'git pull' before pushing again.",
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  ],
  'non-fast-forward': [
    'hint: Updates were rejected because the tip of your current branch is behind',
    'hint: its remote counterpart. If you want to integrate the remote changes,',
    "hint: use 'git pull' before pushing again.",
    "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
  ],
};

function parseRefspec(spec) {
  const i = spec.indexOf(':');
  return i === -1 ? { src: spec, dst: spec } : { src: spec.slice(0, i), dst: spec.slice(i + 1) };
}

export function push(state, { remote = null, refspecs = [], setUpstream = false, force = false, del = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const branch = currentBranch(repo);
  const upstream = branch ? get(repo.upstreams, branch) : undefined;

  let name = remote ?? (upstream ? splitRef(upstream).remote : null);
  if (name === null) {
    if (!Object.keys(repo.remotes).length) return failure(state, NO_DESTINATION, { kind: 'push-no-remote' });
    name = hasOwn(repo.remotes, 'origin') ? 'origin' : Object.keys(repo.remotes).sort(byteOrder)[0];
  }
  if (!hasOwn(repo.remotes, name)) return failure(state, unreachable(name));

  let pairs;
  if (del) {
    if (!refspecs.length) return failure(state, "fatal: --delete doesn't make sense without any refs");
    pairs = refspecs.map((spec) => ({ src: null, dst: spec }));
  } else if (refspecs.length) {
    pairs = refspecs.map(parseRefspec);
  } else {
    if (!branch) {
      return failure(state, [
        'fatal: You are not currently on a branch.',
        'To push the history leading to the current (detached HEAD)',
        'state now, use',
        '',
        `    git push ${name} HEAD:<name-of-remote-branch>`,
      ]);
    }
    if (remote === null && !upstream) {
      return failure(
        state,
        [
          `fatal: The current branch ${branch} has no upstream branch.`,
          'To push the current branch and set the remote as upstream, use',
          '',
          `    git push --set-upstream ${name} ${branch}`,
          '',
          'To have this happen automatically for branches without a tracking',
          "upstream, see 'push.autoSetupRemote' in 'git help config'.",
          '',
        ],
        { kind: 'push-no-upstream', branch },
      );
    }
    pairs = [{ src: branch, dst: remote === null ? splitRef(upstream).branch : branch }];
  }
  for (const pair of pairs) {
    if (pair.src === 'HEAD') pair.src = branch ?? 'HEAD';
    if (!isValidBranchName(pair.dst) && pair.dst !== 'HEAD') {
      return failure(state, `fatal: invalid refspec '${pair.src ?? ''}:${pair.dst}'`);
    }
  }

  const s = clone(state);
  const r = s.repo;
  const url = r.remotes[name].url;
  const server = s.servers[url];
  const width = Math.max(...pairs.map((p) => (p.src ?? p.dst).length));
  const lines = [];
  const errors = [];
  const created = [];
  const updated = [];
  const deleted = [];
  const trackingSet = [];
  let upToDate = 0;
  let rejected = null;

  for (const pair of pairs) {
    const { src, dst } = pair;
    if (del) {
      if (!hasOwn(server.branches, dst)) {
        errors.push(`error: unable to delete '${dst}': remote ref does not exist`);
        rejected ??= 'error';
        continue;
      }
      delete server.branches[dst];
      delete r.remoteRefs[`${name}/${dst}`];
      lines.push(` - ${'[deleted]'.padEnd(17)} ${dst}`);
      deleted.push(dst);
      continue;
    }
    const srcId = src === 'HEAD' ? headCommitId(r) : get(r.branches, src);
    if (!srcId) {
      errors.push(`error: src refspec ${src} does not match any`);
      rejected ??= 'error';
      continue;
    }
    const tip = get(server.branches, dst);
    const ref = `${name}/${dst}`;
    const addLine = (flag, summary, note = '') => lines.push(refLine(flag, summary, src, dst, width, note));
    if (tip === srcId) {
      upToDate++;
    } else if (tip === undefined) {
      registerLanes(r, copyCommits(r, server, [srcId]));
      server.branches[dst] = srcId;
      r.remoteRefs[ref] = srcId;
      addLine('*', '[new branch]');
      created.push(dst);
    } else {
      const known = hasOwn(r.commits, tip);
      const fastForward = known && isAncestor(r, tip, srcId);
      if (fastForward || force) {
        copyCommits(r, server, [srcId]);
        server.branches[dst] = srcId;
        r.remoteRefs[ref] = srcId;
        if (fastForward) addLine(' ', `${tip}..${srcId}`);
        else addLine('+', `${tip}...${srcId}`, ' (forced update)');
        updated.push(dst);
      } else {
        const reason = known ? 'non-fast-forward' : 'fetch first';
        addLine('!', '[rejected]', ` (${reason})`);
        rejected = rejected === 'fetch first' ? rejected : reason;
        continue;
      }
    }
    if (setUpstream && hasOwn(r.branches, src)) {
      r.upstreams[src] = ref;
      trackingSet.push(`branch '${src}' set up to track '${ref}'.`);
    }
  }

  const out = [...errors];
  if (lines.length) out.push(`To ${url}`, ...lines);
  if (rejected) out.push(`error: failed to push some refs to '${url}'`, ...(PUSH_HINTS[rejected] ?? []));
  out.push(...trackingSet);
  const changed = created.length + updated.length + deleted.length + trackingSet.length > 0;
  if (!lines.length && !rejected && upToDate) out.push('Everything up-to-date');
  return {
    state: changed ? s : state,
    out,
    ok: !rejected,
    info: { kind: 'push', remote: name, created, updated, deleted, upToDate: !!upToDate && !changed, rejected },
  };
}

/* ------------------------------------------------------------------ git pull */

const DIVERGENT = [
  'hint: You have divergent branches and need to specify how to reconcile them.',
  'hint: You can do so by running one of the following commands sometime before',
  'hint: your next pull:',
  'hint: ',
  'hint:   git config pull.rebase false  # merge',
  'hint:   git config pull.rebase true   # rebase',
  'hint:   git config pull.ff only       # fast-forward only',
  'hint: ',
  'hint: You can replace "git config" with "git config --global" to set a default',
  'hint: preference for all repositories. You can also pass --rebase, --no-rebase,',
  'hint: or --ff-only on the command line to override the configured default per',
  'hint: invocation.',
  'fatal: Need to specify how to reconcile divergent branches.',
];

function noTrackingLines(repo, branch) {
  const first = Object.keys(repo.remotes).sort(byteOrder)[0];
  return [
    'There is no tracking information for the current branch.',
    'Please specify which branch you want to merge with.',
    'See git-pull(1) for details.',
    '',
    '    git pull <remote> <branch>',
    '',
    'If you wish to set tracking information for this branch you can do so with:',
    '',
    `    git branch --set-upstream-to=${first ?? '<remote>'}/<branch> ${branch}`,
  ];
}

export function pull(
  state,
  { remote = null, branch = null, ffOnly = false, noRebase = false, noFF = false } = {},
  env = defaultEnv,
) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const current = currentBranch(repo);
  if (!current) {
    return failure(state, [
      'You are not currently on a branch.',
      'Please specify which branch you want to merge with.',
      'See git-pull(1) for details.',
      '',
      '    git pull <remote> <branch>',
    ]);
  }
  const upstream = get(repo.upstreams, current);
  let name = remote;
  let target = branch;
  if (name === null) {
    if (!upstream) return failure(state, noTrackingLines(repo, current), { kind: 'pull-no-tracking' });
    ({ remote: name, branch: target } = splitRef(upstream));
  } else if (target === null) {
    if (!upstream || splitRef(upstream).remote !== name) {
      return failure(state, [
        `You asked to pull from the remote '${name}', but did not specify`,
        'a branch. Because this is not the default configured remote',
        'for your current branch, you must specify a branch on the command line.',
      ]);
    }
    target = splitRef(upstream).branch;
  }
  if (!hasOwn(repo.remotes, name)) return failure(state, unreachable(name));

  const s = clone(state);
  const fetched = fetchInto(s, name);
  const ref = `${name}/${target}`;
  const dirty = fetched.changes.length ? s : state;
  if (!hasOwn(s.repo.remoteRefs, ref)) {
    return failure(
      dirty,
      branch === null && remote === null
        ? [
            ...fetched.lines,
            `Your configuration specifies to merge with the ref 'refs/heads/${target}'`,
            'from the remote, but no such ref was fetched.',
          ]
        : [...fetched.lines, `fatal: couldn't find remote ref ${target}`],
      { kind: 'pull-gone', ref },
    );
  }
  const ours = headCommitId(s.repo);
  const theirs = s.repo.remoteRefs[ref];
  const diverged = ours && !isAncestor(s.repo, theirs, ours) && !isAncestor(s.repo, ours, theirs);
  // Comme Git, on applique les réglages pull.rebase et pull.ff sauf option contraire en ligne de commande.
  const fastForwardOnly = ffOnly || (!noRebase && state.config['pull.ff'] === 'only');
  if (diverged && !noRebase && !fastForwardOnly) {
    if (state.config['pull.rebase'] === 'true') {
      return failure(dirty, [
        ...fetched.lines,
        'Commande non supportée dans ce simulateur.',
        '(pull.rebase=true demande un rebase, prévu dans une prochaine version.)',
      ]);
    }
    if (state.config['pull.rebase'] !== 'false') {
      return failure(dirty, [...fetched.lines, ...DIVERGENT], { kind: 'pull-divergent', ref });
    }
  }
  const url = s.repo.remotes[name].url;
  const merged = merge(
    s,
    { target: ref, noFF, ffOnly: fastForwardOnly, message: `Merge branch '${target}' of ${displayUrl(url)}` },
    env,
  );
  return {
    state: merged.state,
    out: [...fetched.lines, ...merged.out],
    ok: merged.ok,
    info: { kind: 'pull', remote: name, branch: target, fetched: fetched.newCommits, merge: merged.info },
  };
}

/* ------------------------------------------------------------------ git clone */

export function cloneRepo(state, { url = null } = {}) {
  if (!url) return failure(state, 'fatal: You must specify a repository to clone.');
  if (state.repo || Object.keys(state.workdir).length) {
    return failure(state, "fatal: destination path '.' already exists and is not an empty directory.", {
      kind: 'clone-not-empty',
    });
  }
  const key = [url, url.replace(/\/$/, ''), `${url.replace(/\/$/, '')}.git`].find((u) => hasOwn(state.servers, u));
  if (!key) {
    return failure(state, [
      "Cloning into '.'...",
      'remote: Repository not found.',
      `fatal: repository '${url}/' not found`,
    ]);
  }
  const server = state.servers[key];
  const s = clone(state);
  const repo = createRepo();
  s.repo = repo;
  repo.remotes.origin = { url: key };
  const branches = Object.keys(server.branches).sort(byteOrder);
  const head = hasOwn(server.branches, server.head) ? server.head : (branches[0] ?? server.head);
  repo.head = { type: 'branch', name: head };
  repo.lanes = [head];
  const copied = copyCommits(server, repo, Object.values(server.branches));
  registerLanes(repo, copied);
  for (const b of branches) {
    if (!repo.lanes.includes(b)) repo.lanes.push(b);
    repo.remoteRefs[`origin/${b}`] = server.branches[b];
  }
  if (!branches.length) {
    return success(s, ["Cloning into '.'...", 'warning: You appear to have cloned an empty repository.'], {
      kind: 'clone',
      url: key,
      empty: true,
      branch: head,
      commits: 0,
    });
  }
  repo.branches[head] = server.branches[head];
  repo.upstreams[head] = `origin/${head}`;
  const tree = repo.commits[repo.branches[head]].tree;
  repo.index = { ...tree };
  s.workdir = { ...tree };
  return success(s, ["Cloning into '.'..."], {
    kind: 'clone',
    url: key,
    empty: false,
    branch: head,
    commits: copied.length,
  });
}

/* ------------------------------------------------------------------ collègue simulé */

function noRemoteYet(state, command) {
  return failure(state, [
    `${command} : aucun dépôt distant configuré.`,
    `Clonez le dépôt de démonstration (git clone ${DEMO_URL}) ou ajoutez-en un (git remote add origin <url>).`,
  ]);
}

function newServerCommitId(server, repo, env) {
  let hash;
  do hash = env.randomHex(40);
  while (hasOwn(server.commits, hash.slice(0, 7)) || hasOwn(repo.commits, hash.slice(0, 7)));
  return hash;
}

/** Commande pédagogique : un collègue pousse un commit directement sur le dépôt distant. */
export function collab(state, { branch = null, file = null } = {}, env = defaultEnv) {
  const names = state.repo ? Object.keys(state.repo.remotes).sort(byteOrder) : [];
  if (!names.length) return noRemoteYet(state, 'collab');
  if (
    file !== null &&
    (/[\\/]/.test(file) || file === '.' || file === '..' || file === '__proto__' || file === '.git')
  ) {
    return failure(state, `collab : nom de fichier invalide : ${file}`);
  }
  const name = names.includes('origin') ? 'origin' : names[0];
  const s = clone(state);
  const server = s.servers[s.repo.remotes[name].url];
  const target = branch ?? server.head;
  const tip = get(server.branches, target);
  if (branch !== null && !tip) return failure(state, `collab : la branche '${branch}' n'existe pas sur ${name}.`);
  const tree = tip ? { ...server.commits[tip].tree } : {};
  let n = 1;
  while (hasOwn(tree, `collab-${n}.txt`)) n++;
  const path = file ?? `collab-${n}.txt`;
  const before = get(tree, path);
  tree[path] =
    before === undefined
      ? 'Ajouté par Camille.\n'
      : `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}Modifié par Camille.\n`;
  const hash = newServerCommitId(server, s.repo, env);
  const id = hash.slice(0, 7);
  server.commits[id] = {
    id,
    hash,
    message: before === undefined ? `Camille : ajoute ${path}` : `Camille : modifie ${path}`,
    parents: tip ? [tip] : [],
    author: { ...COLLEAGUE },
    timestamp: env.now(),
    tree,
    lane: target,
    seq: ++server.seq,
  };
  server.branches[target] = id;
  if (!tip && !hasOwn(server.branches, server.head)) server.head = target;
  return success(
    s,
    `${COLLEAGUE.name} a poussé ${plural(1, 'commit')} (${id}) sur ${target}, directement sur ${name}.`,
    {
      kind: 'collab',
      branch: target,
      remote: name,
      id,
      path,
    },
  );
}

/* ------------------------------------------------------------------ merge request simulée */

function serverMergeBase(server, a, b) {
  const fromA = ancestors(server, a);
  let best = null;
  for (const id of ancestors(server, b)) {
    if (fromA.has(id) && (!best || server.commits[id].seq > server.commits[best].seq)) best = id;
  }
  return best;
}

function mergeTrees(base, ours, theirs) {
  const tree = {};
  const conflicts = [];
  for (const path of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = get(base, path);
    const o = get(ours, path);
    const t = get(theirs, path);
    let value;
    if (o === t || t === b) value = o;
    else if (o === b) value = t;
    else {
      conflicts.push(path);
      continue;
    }
    if (value !== undefined) tree[path] = value;
  }
  return { tree, conflicts: conflicts.sort(byteOrder) };
}

/**
 * Commande pédagogique : la merge request de `source` vers `target` est acceptée dans l'interface
 * de la forge (GitLab, GitHub). La fusion a lieu sur le dépôt distant, avec un commit de fusion.
 */
export function mergeRequest(state, { source = null, target = null } = {}, env = defaultEnv) {
  const names = state.repo ? Object.keys(state.repo.remotes).sort(byteOrder) : [];
  if (!names.length) return noRemoteYet(state, 'mr');
  if (!source) return failure(state, 'Utilisation : mr <branche source> [<branche cible>]');
  const name = names.includes('origin') ? 'origin' : names[0];
  const s = clone(state);
  const server = s.servers[s.repo.remotes[name].url];
  const into = target ?? server.head;
  if (!hasOwn(server.branches, source)) {
    return failure(
      state,
      `mr : la branche '${source}' n'existe pas sur ${name}. Poussez-la d'abord : git push -u ${name} ${source}`,
    );
  }
  if (!hasOwn(server.branches, into))
    return failure(state, `mr : la branche cible '${into}' n'existe pas sur ${name}.`);
  if (source === into) return failure(state, 'mr : la branche source et la branche cible sont identiques.');
  const src = server.branches[source];
  const dst = server.branches[into];
  const number = (server.mergeRequests ?? 0) + 1;
  const title = `Merge request !${number} : ${source} → ${into}`;
  if (isAncestor(server, src, dst))
    return failure(state, [title, `Rien à fusionner : ${source} est déjà contenue dans ${into}.`]);
  const base = serverMergeBase(server, src, dst);
  const { tree, conflicts } = mergeTrees(
    base ? server.commits[base].tree : {},
    server.commits[dst].tree,
    server.commits[src].tree,
  );
  if (conflicts.length) {
    return failure(
      state,
      [
        title,
        `Fusion impossible depuis l'interface : conflit sur ${conflicts.join(', ')}.`,
        `Résolvez-le en local : git switch ${source}, git pull ${name} ${into} --no-rebase, corrigez, commitez, puis git push.`,
      ],
      { kind: 'mr-conflict', source, into, conflicts },
    );
  }
  server.mergeRequests = number;
  const hash = newServerCommitId(server, s.repo, env);
  const id = hash.slice(0, 7);
  server.commits[id] = {
    id,
    hash,
    message: `Merge branch '${source}' into '${into}'`,
    parents: [dst, src],
    author: { ...COLLEAGUE },
    timestamp: env.now(),
    tree,
    lane: into,
    seq: ++server.seq,
  };
  server.branches[into] = id;
  return success(
    s,
    [title, `Acceptée par ${COLLEAGUE.name} : commit de fusion ${id} créé sur ${into}, côté ${name}.`],
    {
      kind: 'mr',
      source,
      into,
      id,
      remote: name,
    },
  );
}
