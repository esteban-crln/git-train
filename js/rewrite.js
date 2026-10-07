/**
 * Commandes qui déplacent ou réécrivent l'historique : reset, cherry-pick, revert, rebase.
 *
 * cherry-pick, revert et rebase rejouent des commits avec la même fusion à trois voies que `git merge`
 * (mergeTrees3 + writeMerge dans engine.js). Quand un conflit les arrête, l'opération est mémorisée dans
 * state.repo.pick ou state.repo.rebase, avec ce qu'il faut pour la reprendre (--continue), la passer (--skip)
 * ou l'annuler (--abort).
 * Même contrat que le moteur : état en entrée, { state, out, ok, info } en sortie, sans effet de bord.
 */
import {
  ancestors,
  clone,
  commit,
  computeStatus,
  conflictsOf,
  createCommit,
  currentBranch,
  defaultEnv,
  failure,
  gitDate,
  hasOwn,
  headCommitId,
  isAncestor,
  keysOf,
  mergeTrees3,
  moveHead,
  operationInProgress,
  requireRepo,
  resetToTree,
  resolveRevision,
  shortLine,
  subject,
  success,
  summaryLines,
  switchTree,
  treeChanges,
  treeOf,
  UNMERGED_COMMIT_ERROR,
  writeMerge,
} from './engine.js';

const label = (c) => `${c.id} (${subject(c)})`;
const snapshot = (s) => ({ index: clone(s.repo.index), workdir: clone(s.workdir) });

function unstagedLines(state) {
  const { unstaged } = computeStatus(state);
  return unstaged.length
    ? ['Unstaged changes after reset:', ...unstaged.map((e) => `${e.kind === 'deleted' ? 'D' : 'M'}\t${e.path}`)]
    : [];
}

/* ------------------------------------------------------------------ git reset */

export function reset(state, { mode = 'mixed', target = null, paths = [] } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  const headId = headCommitId(repo);
  const id = target === null ? headId : resolveRevision(repo, target);
  if (target !== null && !id) {
    return failure(state, [
      `fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.`,
      "Use '--' to separate paths from revisions, like this:",
      "'git <command> [<revision>...] -- [<file>...]'",
    ]);
  }

  if (paths.length) {
    if (mode !== 'mixed') return failure(state, `fatal: Cannot do ${mode} reset with paths.`);
    const tree = treeOf(repo, id);
    const targets = paths.includes('.') ? keysOf(repo.index, tree) : paths;
    const s = clone(state);
    const op = s.repo.merge ?? s.repo.pick ?? s.repo.rebase;
    for (const path of targets) {
      if (hasOwn(tree, path)) s.repo.index[path] = tree[path];
      else delete s.repo.index[path];
      if (op) delete op.conflicts[path];
    }
    return success(s, unstagedLines(s), { kind: 'reset-paths', paths: targets, target });
  }

  if (!id) {
    if (mode !== 'mixed') return failure(state, "fatal: Failed to resolve 'HEAD' as a valid ref.");
    const s = clone(state);
    s.repo.index = {};
    return success(s, [], { kind: 'reset', mode, id: null, from: null, branch: currentBranch(repo), target });
  }
  if (mode === 'soft' && repo.merge) return failure(state, 'fatal: Cannot do a soft reset in the middle of a merge.');

  const s = clone(state);
  const r = s.repo;
  moveHead(r, id);
  const tree = treeOf(r, id);
  if (mode === 'hard') resetToTree(s, tree);
  else if (mode === 'mixed') r.index = { ...tree };
  if (mode !== 'soft') {
    r.merge = null;
    r.pick = null;
  }
  const out = mode === 'hard' ? [`HEAD is now at ${shortLine(r, id)}`] : mode === 'mixed' ? unstagedLines(s) : [];
  return success(s, out, { kind: 'reset', mode, id, from: headId, branch: currentBranch(r), target });
}

/* ------------------------------------------------------------------ cherry-pick et revert */

const SKIP_HINTS = (cmd) => [
  'hint: After resolving the conflicts, mark them with',
  'hint: "git add/rm <pathspec>", then run',
  `hint: "git ${cmd} --continue".`,
  `hint: You can instead skip this commit with "git ${cmd} --skip".`,
  `hint: To abort and get back to the state before "git ${cmd}",`,
  `hint: run "git ${cmd} --abort".`,
  'hint: Disable this message with "git config advice.mergeConflict false"',
];

const alreadyRunning = (repo, cmd) => {
  const op = operationInProgress(repo);
  if (op.name === 'cherry-pick' || op.name === 'revert') {
    return [
      'error: a cherry-pick or revert is already in progress',
      `hint: try "git ${op.name} (--continue | --skip | --abort | --quit)"`,
      `fatal: ${cmd} failed`,
    ];
  }
  return [
    `fatal: You have not concluded your ${op.noun} (${op.head} exists).`,
    `Please, commit your changes before you ${cmd}.`,
  ];
};

/** Ce que `kind` change dans l'arbre : un commit rejoué tel quel (cherry-pick) ou son contraire (revert). */
function planPick(repo, kind, id, { mainline = null, record = false } = {}) {
  const c = repo.commits[id];
  const refuse = (message) => ({ error: [`error: ${message}`, `fatal: ${kind} failed`] });
  let parentId;
  if (c.parents.length > 1) {
    if (!mainline) return refuse(`commit ${c.hash} is a merge but no -m option was given.`);
    parentId = c.parents[mainline - 1];
    if (!parentId) return refuse(`commit ${c.hash} does not have parent ${mainline}`);
  } else {
    if (mainline) return refuse(`mainline was specified but commit ${c.hash} is not a merge.`);
    parentId = c.parents[0] ?? null;
  }
  const parentTree = treeOf(repo, parentId);
  if (kind === 'cherry-pick') {
    return {
      c,
      baseTree: parentTree,
      theirsTree: c.tree,
      label: label(c),
      message: record ? `${c.message}\n\n(cherry picked from commit ${c.hash})` : c.message,
      author: c.author,
      timestamp: c.timestamp,
    };
  }
  const reverted = /^Revert "(.*)"$/.exec(subject(c));
  const title = reverted ? `Reapply "${reverted[1]}"` : `Revert "${subject(c)}"`;
  const reversing = mainline ? `, reversing\nchanges made to ${repo.commits[parentId].hash}` : '';
  return {
    c,
    baseTree: c.tree,
    theirsTree: parentTree,
    label: `parent of ${label(c)}`,
    message: `${title}\n\nThis reverts commit ${c.hash}${reversing}.`,
    author: null,
    timestamp: null,
  };
}

function commitReport(repo, created, changes, withDate) {
  const branch = currentBranch(repo);
  const where = branch ? `${branch}${created.parents.length ? '' : ' (root-commit)'}` : 'detached HEAD';
  return [
    `[${where} ${created.id}] ${subject(created)}`,
    ...(withDate ? [` Date: ${gitDate(created.timestamp)}`] : []),
    ...summaryLines(changes),
  ];
}

/** Rejoue `todo` un commit après l'autre sur `s` ; s'arrête sur un conflit en mémorisant repo.pick. */
function runPicks(s, kind, todo, opts, env, out = []) {
  const repo = s.repo;
  const queue = [...todo];
  const created = [];
  while (queue.length) {
    const id = queue.shift();
    const plan = planPick(repo, kind, id, opts);
    if (plan.error) return failure(s, [...out, ...plan.error]);
    const oursId = headCommitId(repo);
    const oursTree = treeOf(repo, oursId);
    const outcome = mergeTrees3(plan.baseTree, oursTree, plan.theirsTree, plan.label);
    const written = writeMerge(s, oursTree, outcome, kind);
    if (written.error) return failure(s, [...out, ...written.error, `fatal: ${kind} failed`]);
    const verb = kind === 'revert' ? 'revert' : 'apply';
    if (Object.keys(outcome.conflicts).length) {
      repo.pick = {
        kind,
        id,
        todo: queue,
        message: plan.message,
        author: plan.author,
        timestamp: plan.timestamp,
        theirsTree: plan.theirsTree,
        conflicts: outcome.conflicts,
        saved: opts.saved,
        origHead: opts.origHead,
        mainline: opts.mainline ?? null,
        record: !!opts.record,
      };
      return failure(
        s,
        [
          ...out,
          ...outcome.notes,
          `error: could not ${verb} ${plan.c.id}... ${subject(plan.c)}`,
          ...SKIP_HINTS(kind),
        ],
        { kind: 'pick-conflict', pickKind: kind, id, paths: keysOf(outcome.conflicts) },
      );
    }
    const changes = treeChanges(oursTree, repo.index);
    if (!changes.length) {
      const branch = currentBranch(repo);
      return failure(
        s,
        [
          ...out,
          branch ? `On branch ${branch}` : 'HEAD detached',
          'nothing to commit, working tree clean',
          `The previous ${kind} is now empty, possibly due to conflict resolution.`,
        ],
        { kind: 'pick-empty', pickKind: kind, id },
      );
    }
    if (opts.noCommit) continue;
    const commitObj = createCommit(repo, {
      message: plan.message,
      parents: [oursId],
      tree: repo.index,
      author: plan.author ?? s.user,
      timestamp: plan.timestamp ?? env.now(),
      env,
    });
    moveHead(repo, commitObj.id);
    out.push(...commitReport(repo, commitObj, changes, plan.timestamp !== null));
    created.push(commitObj.id);
  }
  repo.pick = null;
  return success(s, out, { kind: 'pick', pickKind: kind, created, noCommit: !!opts.noCommit });
}

/** Développe `A`, `B..C` en liste de commits à rejouer, du plus ancien au plus récent. */
function expandRevisions(repo, revs) {
  const ids = [];
  for (const rev of revs) {
    const range = /^(.*?)\.\.(.*)$/.exec(rev);
    if (range) {
      const from = resolveRevision(repo, range[1] || 'HEAD');
      const to = resolveRevision(repo, range[2] || 'HEAD');
      if (!from || !to) return { error: [`fatal: bad revision '${rev}'`] };
      const known = ancestors(repo, from);
      const added = [...ancestors(repo, to)].filter((id) => !known.has(id));
      ids.push(...added.sort((a, b) => repo.commits[a].seq - repo.commits[b].seq));
    } else {
      const id = resolveRevision(repo, rev);
      if (!id) return { error: [`fatal: bad revision '${rev}'`] };
      ids.push(id);
    }
  }
  return { ids };
}

export function pickCommits(
  state,
  kind,
  { revs = [], noCommit = false, record = false, mainline = null } = {},
  env = defaultEnv,
) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (operationInProgress(repo)) return failure(state, alreadyRunning(repo, kind));
  if (!revs.length) return failure(state, [`error: ${kind} needs at least one commit`, `fatal: ${kind} failed`]);
  if (!headCommitId(repo)) return failure(state, 'fatal: You do not have the initial commit yet');
  const expanded = expandRevisions(repo, revs);
  if (expanded.error) return failure(state, expanded.error);
  const { ids } = expanded;
  if (!ids.length) return failure(state, [`error: empty commit set passed`, `fatal: ${kind} failed`]);
  if (noCommit && ids.length > 1)
    return failure(state, `Le mode --no-commit n'est simulé que pour un seul commit à la fois.`);
  if (computeStatus(state).staged.length) {
    return failure(state, [
      `error: your local changes would be overwritten by ${kind}.`,
      'hint: commit your changes or stash them to proceed.',
      `fatal: ${kind} failed`,
    ]);
  }
  const s = clone(state);
  return runPicks(s, kind, ids, { noCommit, record, mainline, saved: snapshot(s), origHead: headCommitId(repo) }, env);
}

function pickInProgress(state, kind) {
  const error = requireRepo(state);
  if (error) return { error };
  const pick = state.repo.pick;
  if (!pick || (kind && pick.kind !== kind)) {
    return {
      error: failure(state, [
        'error: no cherry-pick or revert in progress',
        `fatal: ${kind ?? 'cherry-pick'} failed`,
      ]),
    };
  }
  return { pick };
}

const resumeOpts = (pick) => ({
  noCommit: false,
  record: pick.record,
  mainline: pick.mainline,
  saved: pick.saved,
  origHead: pick.origHead,
});

export function pickContinue(state, kind, env = defaultEnv) {
  const found = pickInProgress(state, kind);
  if (found.error) return found.error;
  const { pick } = found;
  if (Object.keys(pick.conflicts).length) {
    return failure(state, [
      ...UNMERGED_COMMIT_ERROR.slice(0, 3),
      ...keysOf(pick.conflicts).map((p) => `U\t${p}`),
      `fatal: ${pick.kind} failed`,
    ]);
  }
  let current = state;
  let out = [];
  if (pick.id !== null) {
    const committed = commit(state, {}, env);
    if (!committed.ok) return committed;
    current = committed.state;
    out = committed.out;
  }
  const rest = current.repo.pick;
  if (!rest) return success(current, out, { kind: 'pick-continue', pickKind: pick.kind });
  const s = clone(current);
  s.repo.pick = null;
  return runPicks(s, rest.kind, rest.todo, resumeOpts(rest), env, out);
}

export function pickSkip(state, kind, env = defaultEnv) {
  const found = pickInProgress(state, kind);
  if (found.error) return found.error;
  const { pick } = found;
  const s = clone(state);
  resetToTree(s, treeOf(s.repo, headCommitId(s.repo)));
  s.repo.pick = null;
  if (!pick.todo.length) return success(s, [], { kind: 'pick-skip', pickKind: pick.kind });
  return runPicks(s, pick.kind, pick.todo, resumeOpts(pick), env);
}

export function pickAbort(state, kind) {
  const found = pickInProgress(state, kind);
  if (found.error) return found.error;
  const { pick } = found;
  const s = clone(state);
  if (pick.origHead && headCommitId(s.repo) !== pick.origHead) moveHead(s.repo, pick.origHead);
  s.repo.index = pick.saved.index;
  s.workdir = pick.saved.workdir;
  s.repo.pick = null;
  return success(s, [], { kind: 'pick-abort', pickKind: pick.kind });
}

/* ------------------------------------------------------------------ git rebase */

const REBASE_HINTS = [
  'hint: Resolve all conflicts manually, mark them as resolved with',
  'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
  'hint: You can instead skip this commit: run "git rebase --skip".',
  'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".',
  'hint: Disable this message with "git config advice.mergeConflict false"',
];

const rebaseTarget = (branch) => (branch ? `refs/heads/${branch}` : 'detached HEAD');

function restoreBeforeRebase(s) {
  const r = s.repo;
  const { branch, origHead, saved } = r.rebase;
  r.index = saved.index;
  s.workdir = saved.workdir;
  r.head = branch ? { type: 'branch', name: branch } : { type: 'detached', commit: origHead, from: origHead };
  r.rebase = null;
}

/** Rejoue les commits restants de repo.rebase.todo ; s'arrête sur un conflit, sinon termine le rebase. */
function runRebase(s, env, out = []) {
  const r = s.repo;
  const rb = r.rebase;
  while (rb.todo.length) {
    const id = rb.todo.shift();
    rb.step = rb.total - rb.todo.length;
    const c = r.commits[id];
    const oursId = headCommitId(r);
    const oursTree = treeOf(r, oursId);
    const outcome = mergeTrees3(treeOf(r, c.parents[0] ?? null), oursTree, c.tree, label(c));
    const written = writeMerge(s, oursTree, outcome, 'rebase');
    if (written.error) {
      restoreBeforeRebase(s);
      return failure(s, [...out, ...written.error, `error: could not apply ${c.id}... ${subject(c)}`]);
    }
    if (Object.keys(outcome.conflicts).length) {
      Object.assign(rb, { current: id, message: c.message, author: c.author, timestamp: c.timestamp });
      rb.conflicts = outcome.conflicts;
      return failure(
        s,
        [
          ...out,
          ...outcome.notes,
          `error: could not apply ${c.id}... ${subject(c)}`,
          ...REBASE_HINTS,
          `Could not apply ${c.id}... # ${subject(c)}`,
        ],
        { kind: 'rebase-conflict', paths: keysOf(outcome.conflicts), id },
      );
    }
    const changes = treeChanges(oursTree, r.index);
    if (!changes.length) {
      out.push(`dropping ${c.hash} ${subject(c)} -- patch contents already upstream`);
      rb.dropped = (rb.dropped ?? 0) + 1;
      continue;
    }
    const created = createCommit(r, {
      message: c.message,
      parents: [oursId],
      tree: r.index,
      author: c.author,
      timestamp: c.timestamp,
      lane: rb.branch,
      env,
    });
    moveHead(r, created.id);
  }
  const finalId = headCommitId(r);
  if (rb.branch) {
    r.branches[rb.branch] = finalId;
    r.head = { type: 'branch', name: rb.branch };
  } else r.head = { type: 'detached', commit: finalId, from: finalId };
  r.rebase = null;
  out.push(`Successfully rebased and updated ${rebaseTarget(rb.branch)}.`);
  return success(s, out, {
    kind: 'rebase',
    onto: rb.onto,
    upstream: rb.upstream,
    count: rb.total - (rb.dropped ?? 0),
    dropped: rb.dropped ?? 0,
    branch: rb.branch,
    ff: false,
  });
}

export function rebase(state, { upstream = null } = {}, env = defaultEnv) {
  const error = requireRepo(state);
  if (error) return error;
  const repo = state.repo;
  if (repo.rebase) {
    return failure(state, [
      'fatal: It seems that there is already a rebase-merge directory, and',
      'I wonder if you are in the middle of another rebase.  If that is the case, please try',
      '\tgit rebase (--continue | --abort | --skip)',
      'If that is not the case, please',
      '\trm -fr ".git/rebase-merge"',
      'and run me again.  I am stopping in case you still have something valuable there.',
    ]);
  }
  const op = operationInProgress(repo);
  if (op) return failure(state, `fatal: You are in the middle of a ${op.name} -- cannot rebase.`);
  const current = currentBranch(repo);
  const headId = headCommitId(repo);
  let name = upstream;
  if (name === null) {
    name = current ? (repo.upstreams[current] ?? null) : null;
    if (name === null) {
      return failure(
        state,
        current
          ? [
              'There is no tracking information for the current branch.',
              'Please specify which branch you want to rebase against.',
              'See git-rebase(1) for details.',
              '',
              "    git rebase '<branch>'",
              '',
              'If you wish to set tracking information for this branch you can do so with:',
              '',
              `    git branch --set-upstream-to=<remote>/<branch> ${current}`,
            ]
          : ['fatal: You are not currently on a branch.', 'Please specify which branch you want to rebase against.'],
        { kind: 'rebase-no-upstream' },
      );
    }
  }
  const upstreamId = resolveRevision(repo, name);
  if (!upstreamId || !headId) return failure(state, `fatal: invalid upstream '${name}'`);

  const status = computeStatus(state);
  if (status.unstaged.length || status.staged.length) {
    const unstaged = status.unstaged.length > 0;
    const staged = status.staged.length > 0;
    return failure(
      state,
      [
        `error: cannot rebase: ${unstaged ? 'You have unstaged changes.' : 'Your index contains uncommitted changes.'}`,
        ...(unstaged && staged ? ['error: Additionally, your index contains uncommitted changes.'] : []),
        'error: Please commit or stash them.',
      ],
      { kind: 'rebase-dirty' },
    );
  }
  if (isAncestor(repo, upstreamId, headId)) {
    const info = { kind: 'rebase-uptodate', upstream: name };
    return success(state, `Current branch ${current ?? 'HEAD'} is up to date.`, info);
  }

  const s = clone(state);
  const r = s.repo;
  const saved = snapshot(s);
  const failed = switchTree(s, treeOf(r, headId), treeOf(r, upstreamId), 'rebase');
  if (failed) return failure(state, failed);
  if (isAncestor(repo, headId, upstreamId)) {
    moveHead(r, upstreamId);
    return success(s, `Successfully rebased and updated ${rebaseTarget(current)}.`, {
      kind: 'rebase',
      onto: upstreamId,
      upstream: name,
      count: 0,
      dropped: 0,
      branch: current,
      ff: true,
    });
  }
  const mine = ancestors(repo, headId);
  const theirs = ancestors(repo, upstreamId);
  const todo = [...mine]
    .filter((id) => !theirs.has(id) && repo.commits[id].parents.length < 2)
    .sort((a, b) => repo.commits[a].seq - repo.commits[b].seq);
  r.rebase = {
    onto: upstreamId,
    upstream: name,
    branch: current,
    origHead: headId,
    todo,
    all: [...todo],
    total: todo.length,
    step: 0,
    dropped: 0,
    current: null,
    message: null,
    author: null,
    timestamp: null,
    conflicts: {},
    saved,
  };
  r.head = { type: 'detached', commit: upstreamId, from: upstreamId };
  return runRebase(s, env);
}

function rebaseInProgress(state) {
  const error = requireRepo(state);
  if (error) return { error };
  if (!state.repo.rebase) return { error: failure(state, 'fatal: No rebase in progress?') };
  return { rebase: state.repo.rebase };
}

export function rebaseContinue(state, env = defaultEnv) {
  const found = rebaseInProgress(state);
  if (found.error) return found.error;
  const rb = found.rebase;
  const unmerged = keysOf(conflictsOf(state.repo));
  if (unmerged.length) {
    return failure(state, [
      ...unmerged.map((p) => `${p}: needs merge`),
      'You must edit all merge conflicts and then',
      'mark them as resolved using git add',
    ]);
  }
  let current = state;
  let out = [];
  if (rb.current !== null) {
    const { repo } = state;
    if (!treeChanges(treeOf(repo, headCommitId(repo)), repo.index).length) {
      return failure(state, [
        "No changes - did you forget to use 'git add'?",
        'If there is nothing left to stage, chances are that something else',
        'already introduced the same changes; you might want to skip this patch.',
      ]);
    }
    const committed = commit(state, {}, env);
    if (!committed.ok) return committed;
    current = committed.state;
    out = committed.out;
  }
  const s = clone(current);
  return runRebase(s, env, out);
}

export function rebaseSkip(state, env = defaultEnv) {
  const found = rebaseInProgress(state);
  if (found.error) return found.error;
  const s = clone(state);
  const rb = s.repo.rebase;
  resetToTree(s, treeOf(s.repo, headCommitId(s.repo)));
  Object.assign(rb, { current: null, message: null, author: null, timestamp: null, conflicts: {} });
  rb.dropped = (rb.dropped ?? 0) + 1;
  return runRebase(s, env);
}

export function rebaseAbort(state) {
  const found = rebaseInProgress(state);
  if (found.error) return found.error;
  const s = clone(state);
  const branch = s.repo.rebase.branch;
  restoreBeforeRebase(s);
  return success(s, [], { kind: 'rebase-abort', branch });
}

