/**
 * git tag : étiquettes légères (un nom sur un commit) et annotées (avec message, auteur et date).
 * Même contrat que le moteur : état en entrée, { state, out, ok, info } en sortie, sans effet de bord.
 */
import {
  byteOrder,
  cleanupMessage,
  clone,
  defaultEnv,
  failure,
  globToRegExp,
  hasOwn,
  isValidBranchName,
  requireRepo,
  resolveRevision,
  subject,
  success,
} from './engine.js';

export function tagList(state, { pattern = null, annotations = false } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  const { repo } = state;
  const matcher = pattern === null ? null : globToRegExp(pattern);
  const names = Object.keys(repo.tags)
    .filter((name) => !pattern || (matcher ? matcher.test(name) : name === pattern))
    .sort(byteOrder);
  const out = names.map((name) => {
    if (!annotations) return name;
    const meta = repo.tagMeta[name];
    const text = meta ? meta.message.split('\n')[0] : subject(repo.commits[repo.tags[name]]);
    return `${name.padEnd(15)} ${text}`;
  });
  return success(state, out, { kind: 'tag-list', count: names.length });
}

export function tagCreate(
  state,
  { name = null, target = null, message = null, annotate = false, force = false } = {},
  env = defaultEnv,
) {
  const error = requireRepo(state);
  if (error) return error;
  const { repo } = state;
  if (!name || !isValidBranchName(name)) return failure(state, `fatal: '${name}' is not a valid tag name.`);
  const exists = hasOwn(repo.tags, name);
  if (exists && !force) return failure(state, `fatal: tag '${name}' already exists`);
  const rev = target ?? 'HEAD';
  const id = resolveRevision(repo, rev);
  if (!id) return failure(state, `fatal: Failed to resolve '${rev}' as a valid ref.`);
  const text = message === null ? '' : cleanupMessage(message);
  if (annotate && !text) return failure(state, 'fatal: no tag message?', { kind: 'tag-no-editor' });

  const s = clone(state);
  const old = repo.tags[name];
  s.repo.tags[name] = id;
  if (annotate) s.repo.tagMeta[name] = { message: text, tagger: { ...s.user }, timestamp: env.now() };
  else delete s.repo.tagMeta[name];
  return success(s, exists ? [`Updated tag '${name}' (was ${old})`] : [], {
    kind: 'tag-create',
    name,
    id,
    annotated: annotate,
    updated: exists,
  });
}

export function tagDelete(state, { names = [] } = {}) {
  const error = requireRepo(state);
  if (error) return error;
  if (!names.length) return failure(state, 'fatal: tag name required');
  const s = clone(state);
  const out = [];
  const deleted = [];
  for (const name of names) {
    if (!hasOwn(s.repo.tags, name)) {
      out.push(`error: tag '${name}' not found.`);
      continue;
    }
    out.push(`Deleted tag '${name}' (was ${s.repo.tags[name]})`);
    delete s.repo.tags[name];
    delete s.repo.tagMeta[name];
    deleted.push(name);
  }
  return {
    state: deleted.length ? s : state,
    out,
    ok: deleted.length === names.length,
    info: deleted.length ? { kind: 'tag-delete', names: deleted } : null,
  };
}
