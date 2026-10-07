/**
 * Rendu SVG du graphe de commits : le temps va de gauche à droite, une ligne par branche.
 * Chaque commit est dessiné sur la ligne de la branche où il a été créé.
 */
import { currentBranch, headCommitId, reachableCommits, subject } from './engine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DETACHED = '\u0000detached';

export const PALETTE = [
  '#58a6ff',
  '#f778ba',
  '#3fb950',
  '#e3b341',
  '#a371f7',
  '#ff7b72',
  '#39c5cf',
  '#ff9e64',
  '#b4e14b',
  '#c69c6d',
];
export const DETACHED_COLOR = '#8b949e';

const SIZE = {
  gutter: 108, // colonne des noms de lignes, collée à gauche
  firstX: 172,
  col: 64,
  right: 150,
  top: 14,
  node: 10,
  label: 19,
  labelGap: 3,
  labelsMin: 2, // hauteur réservée au-dessus des commits, en nombre d'étiquettes
  below: 26, // place pour le hash sous le commit
  char: 7.3,
  bottom: 24,
};

/** Couleur stable : l'index d'apparition de la branche dans le dépôt, jamais réattribué. */
export function branchColor(repo, name) {
  const index = name === null ? -1 : repo.lanes.indexOf(name);
  return index === -1 ? DETACHED_COLOR : PALETTE[index % PALETTE.length];
}

/** Calcule positions et étiquettes, sans toucher au DOM. */
export function computeLayout(state) {
  const repo = state.repo;
  const commits = repo ? Object.values(repo.commits).sort((a, b) => a.seq - b.seq) : [];
  if (!commits.length) return null;

  const reachable = reachableCommits(repo);
  const headId = headCommitId(repo);
  const current = currentBranch(repo);
  const laneOf = (c) => c.lane ?? DETACHED;
  const rank = (lane) => (lane === DETACHED ? Infinity : repo.lanes.indexOf(lane));
  const lanes = [...new Set(commits.map(laneOf))].sort((a, b) => rank(a) - rank(b));

  // Pile d'étiquettes au-dessus de chaque commit, de bas en haut :
  // branches de suivi (origin/…), autres branches, branche courante, HEAD.
  const refs = new Map();
  const addRef = (id, ref) => refs.set(id, [...(refs.get(id) ?? []), ref]);
  const shortName = (ref) => ref.slice(ref.indexOf('/') + 1);
  for (const ref of Object.keys(repo.remoteRefs).sort()) {
    addRef(repo.remoteRefs[ref], {
      key: `remote:${ref}`,
      text: ref,
      kind: 'remote',
      color: branchColor(repo, shortName(ref)),
    });
  }
  for (const name of Object.keys(repo.branches).sort()) {
    if (name !== current)
      addRef(repo.branches[name], {
        key: `branch:${name}`,
        text: name,
        kind: 'branch',
        color: branchColor(repo, name),
      });
  }
  for (const name of Object.keys(repo.tags).sort())
    addRef(repo.tags[name], { key: `tag:${name}`, text: name, kind: 'tag', color: '#e6edf3' });
  if (current && repo.branches[current]) {
    addRef(repo.branches[current], {
      key: `branch:${current}`,
      text: current,
      kind: 'branch current',
      color: branchColor(repo, current),
    });
  }
  if (headId) {
    const detached = repo.head.type === 'detached';
    addRef(headId, {
      key: 'HEAD',
      text: detached ? 'HEAD détachée' : 'HEAD',
      kind: detached ? 'head detached' : 'head',
      color: null,
    });
  }

  const laneY = new Map();
  let y = SIZE.top;
  for (const lane of lanes) {
    const stack = Math.max(
      SIZE.labelsMin,
      ...commits.filter((c) => laneOf(c) === lane).map((c) => refs.get(c.id)?.length ?? 0),
    );
    y += stack * (SIZE.label + SIZE.labelGap) + 8 + SIZE.node;
    laneY.set(lane, y);
    y += SIZE.node + SIZE.below;
  }

  const nodes = commits.map((c, i) => ({
    id: c.id,
    commit: c,
    x: SIZE.firstX + i * SIZE.col,
    y: laneY.get(laneOf(c)),
    color: branchColor(repo, c.lane),
    merge: c.parents.length > 1,
    head: c.id === headId,
    reachable: reachable.has(c.id),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = nodes.flatMap((n) =>
    n.commit.parents.map((p, k) => {
      const parent = byId.get(p);
      return { from: parent, to: n, merge: k > 0, color: k > 0 ? parent.color : n.color, reachable: n.reachable };
    }),
  );
  const labels = nodes.flatMap((n) =>
    (refs.get(n.id) ?? []).map((ref, i) => {
      const width = Math.round(ref.text.length * SIZE.char + 16);
      return { ...ref, width, x: n.x - width / 2, y: n.y - SIZE.node - 6 - (i + 1) * SIZE.label - i * SIZE.labelGap };
    }),
  );
  const rows = lanes.map((lane) => ({
    lane,
    y: laneY.get(lane),
    name: lane === DETACHED ? 'HEAD détachée' : lane,
    color: lane === DETACHED ? DETACHED_COLOR : branchColor(repo, lane),
    deleted:
      lane !== DETACHED &&
      !Object.prototype.hasOwnProperty.call(repo.branches, lane) &&
      !Object.keys(repo.remoteRefs).some((ref) => shortName(ref) === lane),
  }));
  return {
    nodes,
    edges,
    labels,
    rows,
    head: byId.get(headId) ?? null,
    width: SIZE.firstX + (nodes.length - 1) * SIZE.col + SIZE.right,
    height: y + SIZE.bottom,
  };
}

function edgePath({ from: p, to: c, merge }) {
  if (p.y === c.y) return `M${p.x} ${p.y} L${c.x} ${c.y}`;
  const r = Math.min(SIZE.col, c.x - p.x);
  // Une bifurcation se courbe près du parent ; une fusion rejoint sa cible juste avant le commit de fusion.
  if (!merge) return `M${p.x} ${p.y} C${p.x + r / 2} ${p.y} ${p.x + r / 2} ${c.y} ${p.x + r} ${c.y} L${c.x} ${c.y}`;
  return `M${p.x} ${p.y} L${c.x - r} ${p.y} C${c.x - r / 2} ${p.y} ${c.x - r / 2} ${c.y} ${c.x} ${c.y}`;
}

function el(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs))
    if (value !== null && value !== undefined) node.setAttribute(name, value);
  if (text !== null) node.textContent = text;
  return node;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const nextFrame = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

function emptyMessage(state) {
  if (!state.repo) return ["Aucun dépôt Git ici pour l'instant.", 'Tapez git init dans le terminal pour commencer.'];
  return [
    "Dépôt vide : aucun commit pour l'instant.",
    'Créez un fichier (touch README.md), indexez-le (git add README.md), puis validez (git commit -m "Premier commit").',
  ];
}

export function createGraph(root, { onCommitClick = null } = {}) {
  const scroller = root.querySelector('[data-graph-scroll]');
  const empty = root.querySelector('[data-graph-empty]');
  const tooltip = root.querySelector('[data-graph-tooltip]');
  const svg = el('svg', { class: 'graph-svg', 'aria-label': 'Graphe des commits' });
  const layer = Object.fromEntries(
    ['guides', 'edges', 'halo', 'nodes', 'refs', 'gutter'].map((name) => [
      name,
      svg.appendChild(el('g', { class: `layer-${name}` })),
    ]),
  );
  const headRing = el('circle', { class: 'head-ring', r: SIZE.node + 6, cx: 0, cy: 0 });
  layer.halo.append(headRing);
  scroller.append(svg);

  let known = null; // commits déjà affichés : seuls les nouveaux sont animés
  let layout = null;
  const refEls = new Map();

  function render(state, { animate = true } = {}) {
    layout = computeLayout(state);
    hideTooltip();
    empty.hidden = !!layout;
    if (!layout) {
      empty.replaceChildren(
        ...emptyMessage(state).map((text) => Object.assign(document.createElement('p'), { textContent: text })),
      );
      svg.setAttribute('width', 0);
      svg.setAttribute('height', 0);
      for (const g of Object.values(layer)) if (g !== layer.halo) g.replaceChildren();
      headRing.style.display = 'none';
      refEls.clear();
      known = new Set();
      return;
    }
    const fresh = (id) => animate && known !== null && !known.has(id);
    const entering = [];
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);

    layer.guides.replaceChildren(
      ...layout.rows.map((row) =>
        el('line', {
          class: 'lane-guide',
          x1: SIZE.gutter,
          x2: layout.width + 4000,
          y1: row.y,
          y2: row.y,
          stroke: row.color,
        }),
      ),
    );

    layer.edges.replaceChildren(
      ...layout.edges.map((edge) =>
        el('path', { class: `edge${edge.reachable ? '' : ' is-orphan'}`, d: edgePath(edge), stroke: edge.color }),
      ),
    );
    layout.edges.forEach((edge, i) => {
      if (!fresh(edge.to.id)) return;
      const path = layer.edges.children[i];
      const length = path.getTotalLength();
      path.style.strokeDasharray = length;
      path.style.strokeDashoffset = length;
      entering.push(() => (path.style.strokeDashoffset = 0));
      path.addEventListener('transitionend', () => path.removeAttribute('style'), { once: true });
    });

    layer.nodes.replaceChildren(
      ...layout.nodes.map((n) => {
        const classes = [
          'commit',
          n.merge && 'is-merge',
          n.head && 'is-head',
          !n.reachable && 'is-orphan',
          fresh(n.id) && 'enter',
        ];
        const g = el('g', {
          class: classes.filter(Boolean).join(' '),
          'data-id': n.id,
          tabindex: 0,
          role: 'button',
          'aria-label': `Commit ${n.id} : ${subject(n.commit)}`,
        });
        g.append(el('circle', { class: 'node', cx: n.x, cy: n.y, r: SIZE.node, fill: n.color }));
        if (n.merge) g.append(el('circle', { class: 'node-core', cx: n.x, cy: n.y, r: 3.5 }));
        g.append(el('text', { class: 'hash', x: n.x, y: n.y + SIZE.node + 16, 'text-anchor': 'middle' }, n.id));
        if (g.classList.contains('enter')) entering.push(() => g.classList.remove('enter'));
        return g;
      }),
    );

    const ringAppears = !headRing.style.transform || headRing.style.display === 'none';
    headRing.style.display = layout.head ? '' : 'none';
    if (layout.head) {
      // Pas de glissement depuis le coin du SVG lors de la première apparition.
      if (ringAppears) headRing.style.transition = 'none';
      headRing.style.transform = `translate(${layout.head.x}px, ${layout.head.y}px)`;
      if (ringAppears) {
        headRing.getBoundingClientRect();
        headRing.style.transition = '';
      }
    }

    renderRefs(fresh, entering);
    renderGutter();
    if (entering.length) nextFrame(() => entering.forEach((fn) => fn()));
    known = new Set(layout.nodes.map((n) => n.id));
    revealHead(animate);
  }

  // Les étiquettes sont conservées d'un rendu à l'autre pour glisser d'un commit à l'autre.
  function renderRefs(fresh, entering) {
    const seen = new Set();
    for (const label of layout.labels) {
      seen.add(label.key);
      let g = refEls.get(label.key);
      if (!g) {
        g = el('g', { class: 'ref' });
        g.append(
          el('rect', { rx: 4, height: SIZE.label }),
          el('text', { y: SIZE.label / 2, dy: '0.35em', 'text-anchor': 'middle' }),
        );
        g.style.transform = `translate(${label.x}px, ${label.y}px)`;
        if (known !== null) {
          g.classList.add('enter');
          entering.push(() => g.classList.remove('enter'));
        }
        layer.refs.append(g);
        refEls.set(label.key, g);
      }
      g.setAttribute(
        'class',
        `ref ${label.kind
          .split(' ')
          .map((k) => `ref-${k}`)
          .join(' ')}${g.classList.contains('enter') ? ' enter' : ''}`,
      );
      const [rect, text] = g.children;
      rect.setAttribute('width', label.width);
      if (label.color) rect.setAttribute('fill', label.color);
      else rect.removeAttribute('fill');
      // Branche de suivi : contour pointillé et texte de la couleur de la branche, fond neutre.
      rect.style.stroke = label.kind === 'remote' ? label.color : '';
      text.style.fill = label.kind === 'remote' ? label.color : '';
      text.setAttribute('x', label.width / 2);
      text.textContent = label.text;
      g.style.transform = `translate(${label.x}px, ${label.y}px)`;
    }
    for (const [key, g] of refEls) {
      if (!seen.has(key)) {
        g.remove();
        refEls.delete(key);
      }
    }
  }

  function renderGutter() {
    // Assez haut pour couvrir la zone visible même après un redimensionnement.
    const height = layout.height + 4000;
    layer.gutter.replaceChildren(
      el('rect', { class: 'gutter-bg', x: 0, y: 0, width: SIZE.gutter, height }),
      el('line', { class: 'gutter-edge', x1: SIZE.gutter, x2: SIZE.gutter, y1: 0, y2: height }),
      ...layout.rows.flatMap((row) => [
        el('rect', { x: 10, y: row.y - 9, width: 4, height: 18, rx: 2, fill: row.color }),
        el(
          'text',
          {
            class: `lane-name${row.deleted ? ' is-deleted' : ''}`,
            x: 20,
            y: row.y,
            dy: row.deleted ? '-0.1em' : '0.35em',
            fill: row.color,
          },
          truncate(row.name, 11),
        ),
        ...(row.deleted ? [el('text', { class: 'lane-note', x: 20, y: row.y + 13 }, 'supprimée')] : []),
      ]),
    );
    layer.gutter.setAttribute('transform', `translate(${scroller.scrollLeft} 0)`);
  }

  function revealHead(animate) {
    if (!layout.head) return;
    const { x, y } = layout.head;
    const behavior = animate ? 'smooth' : 'auto';
    const left = scroller.scrollLeft;
    const top = scroller.scrollTop;
    const target = {};
    if (x < left + SIZE.firstX - SIZE.col / 2 || x > left + scroller.clientWidth - 90)
      target.left = Math.max(0, x - scroller.clientWidth / 2);
    if (y - 60 < top || y + 40 > top + scroller.clientHeight) target.top = Math.max(0, y - scroller.clientHeight / 2);
    if (Object.keys(target).length) scroller.scrollTo({ ...target, behavior });
  }

  function showTooltip(group) {
    const node = layout?.nodes.find((n) => n.id === group.dataset.id);
    if (!node) return;
    const { commit } = node;
    const date = new Date(commit.timestamp).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' });
    const row = (term, value) => {
      const div = document.createElement('div');
      div.append(
        Object.assign(document.createElement('dt'), { textContent: term }),
        Object.assign(document.createElement('dd'), { textContent: value }),
      );
      return div;
    };
    const title = Object.assign(document.createElement('strong'), { className: 'tip-hash', textContent: commit.id });
    title.style.color = node.color;
    const details = document.createElement('dl');
    details.append(
      row('Auteur', `${commit.author.name} <${commit.author.email}>`),
      row('Date', date),
      row(commit.parents.length > 1 ? 'Parents' : 'Parent', commit.parents.join(', ') || 'aucun (premier commit)'),
    );
    if (!node.reachable) details.append(row('État', 'orphelin : plus aucune branche ne mène ici'));
    tooltip.replaceChildren(
      title,
      Object.assign(document.createElement('p'), { className: 'tip-message', textContent: commit.message }),
      details,
    );
    tooltip.hidden = false;

    const box = root.getBoundingClientRect();
    const dot = group.querySelector('.node').getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    const centerX = dot.left + dot.width / 2 - box.left;
    let top = dot.top - box.top - tip.height - 12;
    if (top < 6) top = dot.bottom - box.top + 12;
    const left = Math.min(Math.max(6, centerX - tip.width / 2), box.width - tip.width - 6);
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  const commitFrom = (event) => event.target.closest?.('.commit');
  layer.nodes.addEventListener('pointerover', (e) => commitFrom(e) && showTooltip(commitFrom(e)));
  // Au doigt, l'infobulle reste affichée après le toucher ; un toucher ailleurs la ferme.
  layer.nodes.addEventListener('pointerout', (e) => {
    const g = commitFrom(e);
    if (g && e.pointerType === 'mouse' && !g.contains(e.relatedTarget)) hideTooltip();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!commitFrom(e)) hideTooltip();
  });
  layer.nodes.addEventListener('focusin', (e) => commitFrom(e) && showTooltip(commitFrom(e)));
  layer.nodes.addEventListener('focusout', hideTooltip);
  layer.nodes.addEventListener('click', (e) => {
    const g = commitFrom(e);
    if (!g) return;
    onCommitClick?.(g.dataset.id);
    showTooltip(g); // le clic a donné le focus au terminal, ce qui avait masqué l'infobulle
  });
  layer.nodes.addEventListener('keydown', (e) => {
    const g = commitFrom(e);
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onCommitClick?.(g.dataset.id);
    }
  });
  scroller.addEventListener('scroll', () => {
    layer.gutter.setAttribute('transform', `translate(${scroller.scrollLeft} 0)`);
    hideTooltip();
  });

  return { render };
}
