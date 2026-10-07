/**
 * Terminal minimaliste : zone de sortie, invite, saisie, historique (↑/↓) et autocomplétion (Tab).
 * Une ligne de sortie est une chaîne ou un tableau de segments : texte, ou [texte, classes, couleur?].
 */

const HISTORY_LIMIT = 200;

function span(text, classes, color) {
  const node = document.createElement('span');
  node.textContent = text;
  if (classes)
    node.className = classes
      .split(' ')
      .map((c) => `t-${c}`)
      .join(' ');
  if (color) node.style.color = color;
  return node;
}

const plainText = (segments) => segments.map((s) => (typeof s === 'string' ? s : s[0])).join('');

function commonPrefix(words) {
  let prefix = words[0];
  for (const word of words) while (!word.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

export function createTerminal(root, { onSubmit, complete, history = [], onHistoryChange = null, maxLines = 2000 }) {
  const output = root.querySelector('[data-term-output]');
  const form = root.querySelector('[data-term-form]');
  const input = root.querySelector('[data-term-input]');
  const promptEl = root.querySelector('[data-term-prompt]');
  const tabButton = root.querySelector('[data-term-tab]');

  let entries = history.filter((h) => typeof h === 'string').slice(-HISTORY_LIMIT);
  let cursor = entries.length;
  let draft = '';
  let prompt = [];

  function renderSegments(target, segments) {
    for (const seg of segments) target.append(typeof seg === 'string' ? seg : span(seg[0], seg[1], seg[2]));
  }

  function lineElement(line, extraClass = null) {
    const segments = typeof line === 'string' ? [line] : line;
    const div = document.createElement('div');
    div.className = 'term-line';
    if (extraClass) div.classList.add(extraClass);
    const text = plainText(segments);
    if (/^(fatal|error):/.test(text)) div.classList.add('t-err');
    else if (/^hint:/.test(text)) div.classList.add('t-hint');
    else if (/^warning:/i.test(text)) div.classList.add('t-warn');
    renderSegments(div, segments);
    return div;
  }

  function append(nodes) {
    output.append(...nodes);
    while (output.childElementCount > maxLines) output.firstElementChild.remove();
    output.scrollTop = output.scrollHeight;
  }

  // Si la sortie était en bas, elle y reste quand le terminal change de taille (panneau, rotation…).
  let pinned = true;
  output.addEventListener('scroll', () => {
    pinned = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
  });
  new ResizeObserver(() => {
    if (pinned) output.scrollTop = output.scrollHeight;
  }).observe(output);

  const print = (lines) => append(lines.map((line) => lineElement(line)));
  const explain = (text) => append([lineElement([`↳ ${text}`], 'term-explain')]);
  const notice = (text) => append([lineElement([[text, 'dim']], 'term-notice')]);
  const echo = (command) => append([lineElement([...prompt, ' ', command], 'term-echo')]);

  function setPrompt(parts) {
    prompt = parts;
    promptEl.replaceChildren();
    renderSegments(promptEl, parts);
  }

  function setInput(value) {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
  }

  function submit() {
    const line = input.value;
    echo(line);
    if (line.trim() && entries[entries.length - 1] !== line) {
      entries = [...entries, line].slice(-HISTORY_LIMIT);
      onHistoryChange?.(entries);
    }
    cursor = entries.length;
    draft = '';
    input.value = '';
    onSubmit(line);
  }

  function browseHistory(step) {
    if (!entries.length) return;
    if (cursor === entries.length) draft = input.value;
    cursor = Math.min(entries.length, Math.max(0, cursor + step));
    setInput(cursor === entries.length ? draft : entries[cursor]);
  }

  function autocomplete() {
    const position = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, position);
    const after = input.value.slice(position);
    const { prefix, matches } = complete(before);
    if (!matches.length) return;
    const replace = (word) => {
      const head = before.slice(0, before.length - prefix.length) + word;
      input.value = head + after;
      input.setSelectionRange(head.length, head.length);
    };
    if (matches.length === 1) return replace(`${matches[0]} `);
    const common = commonPrefix(matches);
    if (common.length > prefix.length) return replace(common);
    echo(input.value);
    print([matches.join('  ')]);
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      browseHistory(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      browseHistory(1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      autocomplete();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      output.replaceChildren();
    } else if (event.ctrlKey && event.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) {
      event.preventDefault();
      echo(`${input.value}^C`);
      input.value = '';
      cursor = entries.length;
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  tabButton?.addEventListener('click', () => {
    autocomplete();
    input.focus();
  });

  // Un clic dans le terminal redonne le focus à la saisie, sauf si l'on sélectionne du texte à copier.
  root.addEventListener('mouseup', () => {
    if (!window.getSelection()?.toString()) input.focus({ preventScroll: true });
  });

  return {
    print,
    explain,
    notice,
    setPrompt,
    clear: () => output.replaceChildren(),
    focus: () => input.focus({ preventScroll: true }),
    insert(text) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const before = input.value.slice(0, start);
      const piece = before && !before.endsWith(' ') ? ` ${text}` : text;
      input.value = before + piece + input.value.slice(end);
      input.focus({ preventScroll: true });
      input.setSelectionRange(start + piece.length, start + piece.length);
    },
  };
}
