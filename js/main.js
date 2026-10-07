/**
 * Point d'entrée : assemble le moteur, l'analyseur, le graphe et le terminal.
 * C'est le seul module qui détient l'état courant de l'application.
 */
import {
  UndoStack,
  computeStatus,
  createState,
  deserialize,
  headCommitId,
  reachableCommits,
  serialize,
  subject,
  trackingInfo,
  DEMO_URL,
} from './engine.js';
import { execute, getCompletions, promptInfo } from './parser.js';
import { branchColor, createGraph } from './graph.js';
import { createTerminal } from './terminal.js';

const STORAGE_KEYS = { state: 'gitsim:state', undo: 'gitsim:undo', history: 'gitsim:history' };

const storage = {
  read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false; // stockage plein ou désactivé (navigation privée) : le simulateur continue sans sauvegarde
    }
  },
};

function readJSON(key, fallback) {
  try {
    return JSON.parse(storage.read(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const savedState = deserialize(storage.read(STORAGE_KEYS.state) ?? '');
let state = savedState ?? createState();
const undoStack = new UndoStack(readJSON(STORAGE_KEYS.undo, []));

const $ = (selector) => document.querySelector(selector);
const ui = {
  panel: $('[data-panel]'),
  panelButton: $('[data-action="panel"]'),
  undoButton: $('[data-action="undo"]'),
  help: $('[data-help]'),
  zones: {
    workdir: $('[data-zone="workdir"]'),
    index: $('[data-zone="index"]'),
    repo: $('[data-zone="repo"]'),
    remote: $('[data-zone="remote"]'),
  },
};

const terminal = createTerminal($('[data-terminal]'), {
  onSubmit: run,
  complete: (before) => getCompletions(state, before),
  history: readJSON(STORAGE_KEYS.history, []),
  onHistoryChange: (entries) => storage.write(STORAGE_KEYS.history, JSON.stringify(entries)),
});

const graph = createGraph($('[data-graph]'), { onCommitClick: (id) => terminal.insert(id) });

/* ------------------------------------------------------------------ cycle commande → état → affichage */

function run(line) {
  if (!line.trim()) return;
  const { state: next, entries } = execute(state, line);
  for (const entry of entries) {
    if (entry.clear) {
      terminal.clear();
      continue;
    }
    terminal.print(entry.out);
    if (entry.explanation) terminal.explain(entry.explanation);
  }
  if (serialize(next) !== serialize(state)) {
    undoStack.push(state, line.trim());
    state = next;
    persist();
  }
  refresh();
}

function persist() {
  storage.write(STORAGE_KEYS.state, serialize(state));
  if (!storage.write(STORAGE_KEYS.undo, JSON.stringify(undoStack))) storage.write(STORAGE_KEYS.undo, '[]');
}

function refresh({ animate = true } = {}) {
  graph.render(state, { animate });
  renderPanel();
  updatePrompt();
  const last = undoStack.entries[undoStack.size - 1];
  ui.undoButton.disabled = !last;
  ui.undoButton.title = last ? `Annuler : ${last.label}` : 'Aucune commande à annuler';
}

function updatePrompt() {
  const info = promptInfo(state);
  const parts = [['~/projet', 'prompt-path']];
  if (info.label) {
    const color = info.branch ? branchColor(state.repo, info.branch) : null;
    parts.push(' ', ['(', 'prompt-paren'], [info.label, 'prompt-branch', color], [')', 'prompt-paren']);
  }
  parts.push([' $', 'prompt-sigil']);
  terminal.setPrompt(parts);
}

function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return;
  state = entry.state;
  persist();
  terminal.notice(`↶ Annulé : ${entry.label}`);
  refresh({ animate: false });
  terminal.focus();
}

function resetAll() {
  const message =
    'Réinitialiser le simulateur ?\nLe dépôt et tous les fichiers seront effacés (le bouton « Annuler » permet de revenir en arrière).';
  if (!window.confirm(message)) return;
  if (serialize(state) !== serialize(createState())) undoStack.push(state, 'Réinitialiser');
  state = createState();
  persist();
  terminal.clear();
  welcome(false);
  refresh({ animate: false });
  terminal.focus();
}

function welcome(restored) {
  terminal.print([[['Bienvenue dans le simulateur Git !', 'bold']]]);
  terminal.notice(
    restored
      ? 'Votre session précédente a été restaurée. Tapez help pour la liste des commandes.'
      : `Tapez vos commandes ci-dessous : commencez par git init, ou clonez le dépôt de démonstration (git clone ${DEMO_URL}). Tapez help pour la liste des commandes.`,
  );
}

/* ------------------------------------------------------------------ panneau des trois zones */

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.flat().filter((c) => c !== null && c !== false && c !== undefined));
  return node;
}

const tag = (text, tone) => h('span', { className: `tag tag-${tone}`, textContent: text });
const placeholder = (text) => h('p', { className: 'zone-empty', textContent: text });
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function fileItem(name, badge, content = null, extraClass = '') {
  const label = [h('span', { className: 'file-name', textContent: name }), badge];
  const body =
    content === null
      ? h('div', { className: 'file-row' }, label)
      : h(
          'details',
          {},
          h('summary', { className: 'file-row' }, label),
          h('pre', { className: 'file-content', textContent: content || '(fichier vide)' }),
        );
  return h('li', { className: `file ${extraClass}`.trim() }, body);
}

function renderWorkdir(status) {
  const files = Object.keys(state.workdir).sort();
  const unstaged = new Map((status?.unstaged ?? []).map((e) => [e.path, e.kind]));
  const conflicts = new Set((status?.unmerged ?? []).map((e) => e.path));
  const untracked = new Set(status?.untracked ?? []);
  const items = files.map((name) => {
    let badge = null;
    if (status) {
      if (conflicts.has(name)) badge = tag('conflit', 'danger');
      else if (untracked.has(name)) badge = tag('non suivi', 'danger');
      else if (unstaged.has(name)) badge = tag('modifié', 'warn');
      else badge = tag('à jour', 'muted');
    }
    return fileItem(name, badge, state.workdir[name]);
  });
  for (const [path, kind] of unstaged) {
    if (kind === 'deleted') items.push(fileItem(path, tag('supprimé', 'warn'), null, 'is-deleted'));
  }
  ui.zones.workdir.replaceChildren(
    items.length
      ? h('ul', { className: 'file-list' }, items)
      : placeholder('Aucun fichier. Créez-en un avec touch ou echo.'),
  );
}

function renderIndex(status) {
  if (!state.repo) return ui.zones.index.replaceChildren(placeholder('Elle apparaîtra après git init.'));
  const labels = { new: ['nouveau', 'ok'], modified: ['modifié', 'ok'], deleted: ['supprimé', 'ok'] };
  const items = status.staged.map((e) =>
    fileItem(
      e.path,
      tag(...labels[e.kind]),
      state.repo.index[e.path] ?? null,
      e.kind === 'deleted' ? 'is-deleted' : '',
    ),
  );
  items.push(...status.unmerged.map((e) => fileItem(e.path, tag('en conflit', 'danger'))));
  const tracked = Object.keys(state.repo.index).length;
  ui.zones.index.replaceChildren(
    items.length
      ? h('ul', { className: 'file-list' }, items)
      : placeholder("Vide : rien n'est prêt pour le prochain commit."),
    h('p', {
      className: 'zone-foot',
      textContent: `${plural(tracked, 'fichier')} suivi${tracked > 1 ? 's' : ''} par Git.`,
    }),
  );
}

function renderRepo() {
  const repo = state.repo;
  if (!repo) return ui.zones.repo.replaceChildren(placeholder('Aucun dépôt : tapez git init.'));
  const headId = headCommitId(repo);
  const dot = (color) => {
    const d = h('span', { className: 'dot' });
    d.style.background = color;
    return d;
  };
  let headText = [h('strong', { textContent: 'HEAD détachée' }), ` sur ${repo.head.commit}`];
  if (repo.head.type === 'branch') {
    const name = h('span', { className: 'branch-name', textContent: repo.head.name });
    name.style.color = branchColor(repo, repo.head.name);
    headText = [h('strong', { textContent: 'HEAD → ' }), name];
  }

  const branches = Object.keys(repo.branches)
    .sort()
    .map((name) => {
      const id = repo.branches[name];
      return h(
        'li',
        { className: `branch${name === repo.head.name && repo.head.type === 'branch' ? ' is-current' : ''}` },
        dot(branchColor(repo, name)),
        h('span', { className: 'branch-name', textContent: name }),
        h('code', { textContent: id }),
        h('span', { className: 'branch-msg', textContent: subject(repo.commits[id]) }),
        trackingTag(repo, name),
      );
    });
  const total = Object.keys(repo.commits).length;
  const orphans = total - reachableCommits(repo).size;
  const operation = pendingOperation(repo);
  const tagNames = Object.keys(repo.tags).sort();
  ui.zones.repo.replaceChildren(
    ...[
      h('p', { className: 'repo-head' }, headText),
      operation && h('p', { className: 'repo-merge' }, ...operation),
      branches.length
        ? h('ul', { className: 'branch-list' }, branches)
        : placeholder(headId ? 'Aucune branche.' : `La branche ${repo.head.name} sera créée au premier commit.`),
      tagNames.length &&
        h(
          'p',
          { className: 'repo-extra' },
          h('strong', { textContent: 'Tags : ' }),
          ...tagNames.flatMap((name) => {
            const badge = tag(name, 'muted');
            const meta = repo.tagMeta[name];
            badge.title = `${meta ? `tag annoté : ${meta.message}` : 'tag léger'} → ${repo.tags[name]}`;
            return [badge, ' '];
          }),
        ),
      repo.stash.length > 0 &&
        h(
          'div',
          { className: 'repo-extra' },
          h('strong', { textContent: `Stash (${repo.stash.length}) :` }),
          h(
            'ul',
            { className: 'branch-list' },
            repo.stash.map((entry, i) =>
              h(
                'li',
                { className: 'stash-entry' },
                h('span', { className: 'branch-name', textContent: `stash@{${i}}` }),
                h('span', { className: 'branch-msg', textContent: entry.message }),
              ),
            ),
          ),
        ),
      h(
        'p',
        { className: 'zone-foot' },
        `${plural(total, 'commit')}`,
        headId ? ` · dernier sur HEAD : ${headId}` : '',
        orphans ? ` · ${plural(orphans, 'orphelin')}` : '',
      ),
    ].filter(Boolean),
  );
}

/** Opération arrêtée (fusion, rebase, cherry-pick, revert) à afficher sous HEAD, ou null. */
function pendingOperation(repo) {
  if (repo.merge) return [tag('fusion en cours', 'danger'), ` avec ${repo.merge.label}`];
  if (repo.rebase) {
    const { branch, upstream, onto, step, total } = repo.rebase;
    return [
      tag('rebase en cours', 'danger'),
      ` de ${branch ?? 'HEAD'} sur ${upstream ?? onto} (commit ${step}/${total})`,
    ];
  }
  if (repo.pick) {
    const { kind, id } = repo.pick;
    const label = kind === 'revert' ? 'revert en cours' : 'cherry-pick en cours';
    return [tag(label, 'danger'), id ? ` du commit ${id}` : ''];
  }
  return null;
}

/** Avance (↑ à pousser) et retard (↓ à récupérer) d'une branche sur la branche distante qu'elle suit. */
function trackingTag(repo, name) {
  const info = trackingInfo(repo, name);
  if (!info) return null;
  if (info.gone) return tag('distante supprimée', 'warn');
  if (!info.ahead && !info.behind) return tag(`= ${info.upstream}`, 'muted');
  const parts = [info.ahead && `↑${info.ahead}`, info.behind && `↓${info.behind}`].filter(Boolean).join(' ');
  return tag(`${parts} ${info.upstream}`, info.behind ? 'warn' : 'ok');
}

function renderRemote() {
  const repo = state.repo;
  const names = repo ? Object.keys(repo.remotes).sort() : [];
  if (!names.length) {
    return ui.zones.remote.replaceChildren(
      placeholder(
        repo
          ? 'Aucun dépôt distant : git remote add origin <url>.'
          : `Pour essayer, dans un dossier vide : git clone ${DEMO_URL}`,
      ),
    );
  }
  const blocks = names.flatMap((name) => {
    const url = repo.remotes[name].url;
    const server = state.servers[url];
    const branches = Object.keys(server.branches).sort();
    const rows = branches.map((branch) => {
      const id = server.branches[branch];
      const known = repo.remoteRefs[`${name}/${branch}`];
      const dot = h('span', { className: 'dot' });
      dot.style.background = branchColor(repo, branch);
      const freshness =
        known === id ? tag('à jour', 'muted') : tag(known ? 'nouveautés : git fetch' : 'inconnue : git fetch', 'warn');
      return h(
        'li',
        { className: 'branch' },
        dot,
        h('span', { className: 'branch-name', textContent: branch }),
        h('code', { textContent: id }),
        h('span', { className: 'branch-msg', textContent: subject(server.commits[id]) }),
        freshness,
      );
    });
    return [
      h(
        'p',
        { className: 'repo-head' },
        h('strong', { textContent: name }),
        ' ',
        h('span', { className: 'remote-url', textContent: url }),
      ),
      rows.length
        ? h('ul', { className: 'branch-list' }, rows)
        : placeholder("Dépôt vide : rien n'a encore été poussé."),
      h('p', {
        className: 'zone-foot',
        textContent: `${plural(Object.keys(server.commits).length, 'commit')} sur la forge.`,
      }),
    ];
  });
  ui.zones.remote.replaceChildren(...blocks);
}

function renderPanel() {
  const status = state.repo ? computeStatus(state) : null;
  renderWorkdir(status);
  renderIndex(status);
  renderRepo();
  renderRemote();
}

function setPanelOpen(open) {
  ui.panel.hidden = !open;
  ui.panelButton.setAttribute('aria-expanded', String(open));
}

/* ------------------------------------------------------------------ démarrage */

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'undo') undoLast();
  else if (action === 'reset') resetAll();
  else if (action === 'help') ui.help.showModal();
  else if (action === 'close-help') ui.help.close();
  else if (action === 'panel') setPanelOpen(ui.panel.hidden);
  else if (action === 'close-panel') setPanelOpen(false);
});
ui.help.addEventListener('close', () => terminal.focus());
ui.help.addEventListener('click', (event) => {
  if (event.target === ui.help) ui.help.close();
});

setPanelOpen(false);
welcome(!!savedState && (savedState.repo !== null || Object.keys(savedState.workdir).length > 0));
refresh({ animate: false });
terminal.focus();
document.documentElement.dataset.ready = 'true';
