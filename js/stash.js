/**
 * git stash : met de côté les modifications en cours pour retrouver un répertoire propre.
 *
 * state.repo.stash est une pile (stash@{0} = le plus récent). Chaque entrée garde une copie de l'index, des
 * fichiers suivis tels qu'ils étaient dans le répertoire de travail, et éventuellement des fichiers non suivis.
 * Même contrat que le moteur : état en entrée, { state, out, ok, info } en sortie, sans effet de bord.
 */
import {
  clone,
  computeStatus,
  conflictsOf,
  currentBranch,
  defaultEnv,
  diffstatLines,
  failure,
  fileDiffLines,
  get,
  hasOwn,
  headCommitId,
  keysOf,
  mergeTrees3,
  overwriteError,
  requireRepo,
  resetToTree,
  shortLine,
  statusLines,
  success,
  summaryLines,
  switchBranch,
  treeChanges,
  treeOf,
} from './engine.js';

function pickEntry(repo, ref) {
  if (!repo.stash.length) return { error: 'No stash entries found.' };
  let n = 0;
  if (ref !== null) {
    const match = /^(?:stash@\{(\d+)\}|(\d+))$/.exec(ref);
    if (!match) return { error: `error: ${ref} is not a valid reference` };
    n = Number(match[1] ?? match[2]);
  }
  if (n >= repo.stash.length) return { error: `error: ${ref ?? 'stash@{0}'} is not a valid reference` };
  return { n, entry: repo.stash[n] };
}

export function stashPush(state, { message = null, includeUntracked = false } = {}, env = defaultEnv) {
  const error = requireRepo(state);
  if (error) return error;
  const { repo } = state;
  const headId = headCommitId(repo);
  if (!headId) return failure(state, 'You do not have the initial commit yet');
  const unmerged = keysOf(conflictsOf(repo));
  if (unmerged.length) {
    return failure(state, [
      ...unmerged.map((p) => `${p}: needs merge`),
      'error: could not write index',
      'Cannot save the current index state',
    ]);
  }
  const status = computeStatus(state);
  const untracked = includeUntracked ? status.untracked : [];
  if (!status.staged.length && !status.unstaged.length && !untracked.length)
    return success(state, 'No local changes to save', { kind: 'stash-none' });

  const s = clone(state);
  const r = s.repo;
  const tree = {};
  for (const path of Object.keys(r.index)) if (hasOwn(s.workdir, path)) tree[path] = s.workdir[path];
  const branch = currentBranch(r) ?? '(no branch)';
  const entry = {
    message: message === null ? `WIP on ${branch}: ${shortLine(r, headId)}` : `On ${branch}: ${message}`,
    branch: currentBranch(r),
    base: headId,
    index: { ...r.index },
    tree,
    untracked: Object.fromEntries(untracked.map((p) => [p, s.workdir[p]])),
    hash: env.randomHex(40),
    timestamp: env.now(),
  };
  resetToTree(s, treeOf(r, headId));
  for (const path of untracked) delete s.workdir[path];
  r.stash.unshift(entry);
  return success(s, `Saved working directory and index state ${entry.message}`, {
    kind: 'stash-push',
    message: entry.message,
    untracked: untracked.length,
    count: r.stash.length,
  });
}

export function stashList(state) {
  const error = requireRepo(state);
  if (error) return error;
  const { stash } = state.repo;
  return success(
    state,
    stash.map((e, i) => `stash@{${i}}: ${e.message}`),
    { kind: 'stash-list', count: stash.length },
  );
}

export function stashApply(state, { ref = null, pop = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const { repo } = state;
  const picked = pickEntry(repo, ref);
  if (picked.error) return failure(state, picked.error);
  const { n, entry } = picked;
  if (repo.merge || Object.keys(conflictsOf(repo)).length)
    return failure(state, 'error: Cannot apply a stash in the middle of a merge');
  const headId = headCommitId(repo);
  const baseTree = treeOf(repo, entry.base);
  const headTree = treeOf(repo, headId);
  const affected = keysOf(baseTree, entry.tree).filter((p) => get(baseTree, p) !== get(entry.tree, p));
  const dirty = affected.filter(
    (p) => get(state.workdir, p) !== get(headTree, p) || get(repo.index, p) !== get(headTree, p),
  );
  if (dirty.length) return failure(state, overwriteError(dirty, [], 'merge'));
  const clash = Object.entries(entry.untracked).filter(
    ([p, text]) => hasOwn(state.workdir, p) && state.workdir[p] !== text,
  );
  if (clash.length) {
    return failure(state, [
      ...clash.map(([p]) => `${p} already exists, no checkout`),
      'error: could not restore untracked files from stash',
    ]);
  }

  const s = clone(state);
  const r = s.repo;
  const merged = mergeTrees3(baseTree, headTree, entry.tree, 'Stashed changes', { oursLabel: 'Updated upstream' });
  for (const path of affected) {
    if (hasOwn(merged.conflictContent, path)) s.workdir[path] = merged.conflictContent[path];
    else if (hasOwn(merged.merged, path)) s.workdir[path] = merged.merged[path];
    else delete s.workdir[path];
    // Comme Git, un fichier créé puis indexé avant le stash revient dans l'index.
    if (get(baseTree, path) === undefined && !hasOwn(merged.conflicts, path) && hasOwn(s.workdir, path))
      r.index[path] = s.workdir[path];
  }
  for (const [path, text] of Object.entries(entry.untracked)) s.workdir[path] = text;

  const conflicts = keysOf(merged.conflicts);
  const out = [...merged.notes, ...statusLines(s)];
  if (conflicts.length) {
    out.push('The stash entry is kept in case you need it again.');
    return failure(s, out, { kind: 'stash-apply', pop, n, conflicts });
  }
  if (pop) {
    r.stash.splice(n, 1);
    out.push(`Dropped refs/stash@{${n}} (${entry.hash})`);
  }
  return success(s, out, { kind: 'stash-apply', pop, n, conflicts });
}

export function stashDrop(state, { ref = null } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const picked = pickEntry(state.repo, ref);
  if (picked.error) return failure(state, picked.error);
  const s = clone(state);
  s.repo.stash.splice(picked.n, 1);
  return success(s, `Dropped refs/stash@{${picked.n}} (${picked.entry.hash})`, { kind: 'stash-drop', n: picked.n });
}

export function stashClear(state) {
  const error = requireRepo(state);
  if (error) return error;
  if (!state.repo.stash.length) return success(state, [], { kind: 'stash-clear', count: 0 });
  const s = clone(state);
  const count = s.repo.stash.length;
  s.repo.stash = [];
  return success(s, [], { kind: 'stash-clear', count });
}

export function stashShow(state, { ref = null, patch = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const picked = pickEntry(state.repo, ref);
  if (picked.error) return failure(state, picked.error);
  const { entry } = picked;
  const changes = treeChanges(treeOf(state.repo, entry.base), entry.tree);
  const out = patch
    ? changes.flatMap(fileDiffLines)
    : [...diffstatLines(changes), ...summaryLines(changes, { modes: false })];
  return success(state, out, { kind: 'stash-show', n: picked.n, patch });
}

/** git stash branch <nom> [stash] : crée la branche sur le commit d'origine, y applique le stash, puis le supprime. */
export function stashBranch(state, { name = null, ref = null } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  if (!name) return failure(state, 'fatal: No branch name specified');
  const picked = pickEntry(state.repo, ref);
  if (picked.error) return failure(state, picked.error);
  const switched = switchBranch(state, { create: name, target: picked.entry.base });
  if (!switched.ok) return switched;
  const applied = stashApply(switched.state, { ref: String(picked.n), pop: true });
  return {
    state: applied.state,
    out: [...switched.out, ...applied.out],
    ok: applied.ok,
    info: { kind: 'stash-branch', name, n: picked.n },
  };
}
