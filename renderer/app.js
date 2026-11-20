import { renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const api = window.mai;

const state = {
  settings: null,
  models: [],
  errors: {},
  sessions: [],
  sessionId: null,
  messages: [],
  toolResults: {},
  live: null,
  liveRuntimes: [],
  attachments: [],
  running: false,
  projectDir: '',
  model: '',
  runtime: 'agent',
  runtimes: {},
  renderQueued: false,
  auth: null,
  permissionMode: 'manual',
  permissionModes: [],
  approvalOpen: false,
  trust: null,
  // Открытый вопрос ask_user или карточка плана exit_plan (CC1.7, CC1.8).
  question: null,
  // Слэш-команды: null — ещё не загружены (CC7.7).
  commands: null,
  // Заполнение контекста модели (CC5.1): { used, window, exact }.
  context: null,
  // Запрос разрешения — карточкой в ленте (CC7.1).
  approval: null,
  // Живой вывод команд по id вызова (CC7.4).
  liveOutput: {},
  // Список задач агента (CC1.5) и очередь сообщений (CC7.5).
  todos: [],
  todosCollapsed: false,
  queue: [],
};

/* ---------- утилиты ---------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), kind === 'err' ? 7000 : 3500);
}

function fmtDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function shortPath(value) {
  if (!value) return 'Папка не выбрана';
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('\\');
}

function contextLabel(tokens) {
  if (!tokens) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_048_576;
    if (Math.abs(millions - Math.round(millions)) < 0.1) return `${Math.round(millions)}M`;
    return `${millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function modelEntry(key) {
  return state.models.find((m) => m.key === key) || null;
}

function modelLabel(key) {
  const entry = modelEntry(key);
  if (entry) return entry.name;
  return String(key || '').split('/').pop();
}

function providerOf(key) {
  const providerId = String(key || '').split('/')[0];
  return state.settings?.providers?.[providerId] || null;
}

function activeRuntime() {
  if (state.runtime === 'agent' || state.runtime === '__all__') return null;
  return state.runtimes[state.runtime] || null;
}

function enabledRuntimes() {
  return Object.entries(state.runtimes)
    .filter(([, runtime]) => runtime.enabled !== false && runtime.command)
    .map(([id]) => id);
}

/* ---------- вложения ---------- */

const MAX_ATTACHMENTS = 20;
// Совпадает с MAX_TOTAL_BYTES в electron/lib/attachments.js.
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/**
 * Вложения не вставляются в промпт. Файл копируется в `.mai-code/uploads/<сессия>/`,
 * а в контекст уходит манифест с путями. Агент читает файл инструментами
 * read_file и grep, поэтому размер файла не ограничен размером контекста.
 */
function attachmentBlock() {
  if (!state.attachments.length) return '';
  const lines = state.attachments.map((item) => {
    const parts = [`- ${item.name} (${formatSize(item.size)}, ${item.kind})`, `путь: ${item.path}`];
    if (item.textPath) parts.push(`извлечённый текст: ${item.textPath}`);
    if (item.meta?.extracted) parts.push(`распаковано в: ${item.meta.extracted}`);
    if (item.meta?.lines) parts.push(`строк: ${item.meta.lines}`);
    if (item.meta?.pages) parts.push(`страниц: ~${item.meta.pages}`);
    if (item.meta?.sheets) parts.push(`листов: ${item.meta.sheets}`);
    if (item.meta?.slides) parts.push(`слайдов: ${item.meta.slides}`);
    if (item.meta?.entries) parts.push(`файлов в архиве: ${item.meta.entries}`);
    if (item.note) parts.push(`примечание: ${item.note}`);
    return parts.join('\n  ');
  });
  return `\n\n[Вложения: ${state.attachments.length}. Файлы лежат в проекте, читай их через read_file и grep.]\n${lines.join('\n')}`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} МБ`;
  if (value >= 1024) return `${Math.round(value / 1024)} КБ`;
  return `${value} Б`;
}

const KIND_LABEL = {
  text: 'текст',
  image: 'изображение',
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'таблица',
  pptx: 'презентация',
  archive: 'архив',
  binary: 'двоичный',
};

/** Распознаёт текст на изображении-вложении и добавляет путь к тексту в манифест. */
async function recognizeAttachmentText(item) {
  if (!state.projectDir) {
    toast('Сначала выберите папку проекта', 'err');
    return;
  }
  item.ocrBusy = true;
  renderAttachments();
  try {
    const result = await api.ocr.recognize({ projectDir: state.projectDir, path: item.path });
    if (!result.ok) {
      toast(result.error || 'Не удалось распознать текст', 'err');
      return;
    }
    item.textPath = result.textPath;
    item.meta = { ...(item.meta || {}), lines: result.lines };
    item.note = result.note || '';
    toast(`Текст распознан: ${result.lines} строк, движок ${result.engine}`);
  } catch (err) {
    toast(err?.message || 'Не удалось распознать текст', 'err');
  } finally {
    item.ocrBusy = false;
    renderAttachments();
  }
}

function renderAttachments() {
  const box = $('#attachments');
  if (!box) return;
  box.replaceChildren();
  box.hidden = !state.attachments.length;
  state.attachments.forEach((item, index) => {
    const label = KIND_LABEL[item.kind] || item.kind;
    const chip = el('span', { class: 'attachment-chip', title: item.note || item.path }, [
      el('span', { class: 'name', text: item.name }),
      el('span', { class: 'size', text: `${formatSize(item.size)} · ${label}` }),
    ]);
    // OCR имеет смысл только для изображений и только пока текста нет.
    if (item.kind === 'image' && !item.textPath) {
      chip.append(el('button', {
        type: 'button',
        text: item.ocrBusy ? '…' : 'текст',
        title: 'Распознать текст на изображении',
        disabled: Boolean(item.ocrBusy),
        onclick: () => recognizeAttachmentText(item),
      }));
    }
    chip.append(el('button', {
      type: 'button',
      text: '×',
      title: 'Убрать вложение',
      onclick: async () => {
        state.attachments.splice(index, 1);
        renderAttachments();
        await api.attachments.remove({ projectDir: state.projectDir, path: item.path });
      },
    }));
    if (item.note) chip.classList.add('warn');
    box.append(chip);
  });
  // Суммарный размер: видно, сколько уйдёт в проект и не близко ли к лимиту.
  if (!state.attachments.length) return;
  const total = state.attachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const totalChip = el('span', { class: 'attachment-total', title: 'Суммарный размер вложений' }, [
    el('span', { text: `${state.attachments.length} из ${MAX_ATTACHMENTS} · ${formatSize(total)}` }),
  ]);
  if (total > MAX_TOTAL_BYTES) totalChip.classList.add('warn');
  box.append(totalChip);
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

/** Добавляет уже сохранённые записи манифеста в состояние. */
function pushEntries(entries) {
  for (const entry of entries || []) {
    if (state.attachments.length >= MAX_ATTACHMENTS) {
      toast(`Можно прикрепить не больше ${MAX_ATTACHMENTS} файлов`, 'err');
      break;
    }
    if (state.attachments.some((item) => item.path === entry.path)) continue;
    state.attachments.push(entry);
  }
  renderAttachments();
}

/** Прикрепляет файлы по путям на диске (drag&drop, выбор в диалоге). */
async function addPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  if (!state.projectDir) {
    toast('Сначала выберите папку проекта', 'err');
    return;
  }
  const result = await api.attachments.add({
    projectDir: state.projectDir,
    sessionId: state.sessionId,
    paths: list,
  });
  if (!result.ok) {
    toast(result.error || 'Не удалось прикрепить файлы', 'err');
    return;
  }
  for (const error of result.errors || []) toast(error, 'err');
  pushEntries(result.entries);
}

/** Прикрепляет файлы из буфера обмена или перетаскиванием без пути. */
async function addBlobs(files) {
  for (const file of Array.from(files || [])) {
    if (!file.type?.startsWith('image/')) {
      toast(`${file.name}: перетащите файл из проводника или выберите через скрепку`, 'err');
      continue;
    }
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      toast(`${file.name}: не удалось прочитать файл`, 'err');
      continue;
    }
    const result = await api.attachments.addImage({
      projectDir: state.projectDir,
      sessionId: state.sessionId,
      name: file.name,
      dataUrl,
    });
    if (!result.ok) {
      toast(result.error || 'Не удалось прикрепить изображение', 'err');
      continue;
    }
    pushEntries([result.entry]);
  }
}

/** Открывает системный диалог выбора файлов. */
async function pickAttachments() {
  if (!state.projectDir) {
    toast('Сначала выберите папку проекта', 'err');
    return;
  }
  const result = await api.attachments.pick({
    projectDir: state.projectDir,
    sessionId: state.sessionId,
  });
  if (!result.ok) {
    toast(result.error || 'Не удалось прикрепить файлы', 'err');
    return;
  }
  for (const error of result.errors || []) toast(error, 'err');
  pushEntries(result.entries);
}

/* ---------- режимы разрешений ---------- */

// Запасной список на случай, если IPC недоступен. Источник правды — MODE_INFO в main.
const MODE_FALLBACK = [
  { id: 'manual', label: 'Вручную', description: 'Спрашивать перед каждой правкой, командой и внешним инструментом.' },
  { id: 'acceptEdits', label: 'Принимать правки', description: 'Правки файлов — без вопросов, команды и внешние инструменты — с подтверждением.' },
  { id: 'plan', label: 'План', description: 'Только чтение и план с альтернативами.' },
  { id: 'dontAsk', label: 'Только разрешённое', description: 'Только то, что разрешено правилами; остальное отклоняется.' },
  { id: 'bypass', label: 'Без вопросов', description: 'Всё без подтверждения, кроме guardrails и правил deny.', warning: true, adminOnly: true },
];

async function renderModeSelect() {
  const select = $('#mode-select');
  if (!select) return;
  const modes = state.permissionModes.length ? state.permissionModes : MODE_FALLBACK;
  select.replaceChildren();
  for (const mode of modes) {
    select.append(
      el('option', {
        value: mode.id,
        text: mode.warning ? `⚠ ${mode.label}` : mode.label,
        title: mode.disabled ? `${mode.description} Недоступно для вашей роли.` : mode.description || '',
        disabled: mode.disabled ? 'disabled' : null,
      }),
    );
  }
  select.value = state.permissionMode;
  const info = modes.find((m) => m.id === state.permissionMode);
  select.title = info?.description || 'Режим разрешений';
  select.classList.toggle('mode-plan', state.permissionMode === 'plan');
  select.classList.toggle('mode-bypass', state.permissionMode === 'bypass');
  select.classList.toggle('mode-dontask', state.permissionMode === 'dontAsk');
}

/** Перечитывает режим для текущей сессии (или значение по умолчанию). */
async function refreshPermissionMode() {
  try {
    const result = await api.permissions.modes(state.sessionId);
    state.permissionMode = result.current;
    state.permissionModes = result.modes;
  } catch {
    state.permissionMode = 'manual';
    state.permissionModes = MODE_FALLBACK;
  }
  renderModeSelect();
}

async function setPermissionMode(mode) {
  const info0 = (state.permissionModes.length ? state.permissionModes : MODE_FALLBACK).find((m) => m.id === mode);
  if (info0?.warning && !window.confirm(`${info0.label}: ${info0.description}\n\nВключить?`)) {
    renderModeSelect();
    return;
  }
  const result = await api.permissions.set(mode, state.sessionId);
  if (result && result.ok === false) {
    toast(result.error || 'Режим не изменён', 'err');
    await refreshPermissionMode();
    return;
  }
  state.permissionMode = result?.mode || mode;
  renderModeSelect();
  const info = (state.permissionModes.length ? state.permissionModes : MODE_FALLBACK).find(
    (m) => m.id === state.permissionMode,
  );
  if (info) {
    const scope = result?.scope === 'session' ? 'для этого чата' : 'по умолчанию для новых чатов';
    toast(`${info.label} ${scope}: ${info.description}`, 'ok');
  }
}

/* ---------- доверие к папке (ADR 0028) ---------- */

async function refreshTrust() {
  // Свои команды проекта зависят от папки и доверия к ней.
  state.commands = null;
  if (!api.trust || !state.projectDir) {
    state.trust = null;
    updateChrome();
    return null;
  }
  try {
    state.trust = await api.trust.get(state.projectDir);
  } catch {
    state.trust = null;
  }
  updateChrome();
  return state.trust;
}

/**
 * Окно «Доверять папке?». Показывает, что в папке исполняется или влияет на
 * агента. Если есть плагины или MCP, рекомендован ответ «Ограниченно».
 * Возвращает 'trusted', 'restricted' или null (окно закрыто без ответа).
 */
function askTrust(info = {}) {
  return new Promise((resolve) => {
    const found = info.found || {};
    const recommended = found.executable ? 'restricted' : 'trusted';
    const items = [];
    if (found.plugins) items.push(`плагины .mai-code/plugins: ${found.plugins} — исполняются в приложении`);
    if (found.mcpServers?.length) items.push(`MCP-серверы .mai-code/mcp.json: ${found.mcpServers.join(', ')} — запускают процессы`);
    if (found.agents) items.push('AGENTS.md — инструкции агенту');
    if (found.memory) items.push('.mai-code/memory.md — память проекта');
    if (found.skills) items.push(`навыки проекта: ${found.skills}`);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const option = (key, label, value, hint) =>
      el(
        'button',
        {
          class: `btn approve-option${value === recommended ? ' primary recommended' : ''}`,
          type: 'button',
          'data-trust': value,
          onclick: () => {
            finish(value);
            modal.close();
          },
        },
        [
          el('span', { class: 'approve-key', text: key }),
          el('span', { class: 'trust-option-text' }, [el('b', { text: label }), el('small', { text: hint })]),
          value === recommended ? el('span', { class: 'recommended-badge', text: 'Рекомендуется' }) : null,
        ],
      );
    const isAdmin = (state.auth?.role || 'admin') === 'admin';
    const modal = openModal({
      title: 'Доверять этой папке?',
      small: true,
      onClose: () => finish(null),
      body: [
        el('div', { class: 'approve-args', text: info.projectDir || state.projectDir || '' }),
        el('p', {
          text: items.length
            ? 'В папке найдено то, что исполняется или влияет на агента:'
            : 'В папке нет плагинов, MCP-серверов и инструкций для агента.',
        }),
        items.length ? el('ul', { class: 'trust-list' }, items.map((t) => el('li', { text: t }))) : null,
        el('p', {
          class: 'hint-text',
          text: 'Доверяйте только своим папкам и проверенным репозиториям. Решение действует и для вложенных папок, его можно изменить в «Настройках».',
        }),
      ],
      footer: [
        isAdmin ? option('1', 'Доверяю', 'trusted', 'загрузить плагины, MCP, AGENTS.md, память и навыки проекта') : null,
        option(isAdmin ? '2' : '1', 'Ограниченно', 'restricted', 'работать без кода и инструкций проекта; «Без вопросов» не действует'),
      ].filter(Boolean),
    });
    modal.modal.classList.add('approve-modal', 'trust-modal');
    modal.footEl.querySelector('.recommended')?.focus();
  });
}

/** Блок «Доверие к папкам» в настройках: текущая папка и список решений. */
function trustSettingsBlock() {
  const box = el('div', { class: 'trust-settings' });
  const label = { trusted: 'доверена', restricted: 'ограниченно', unknown: 'нет решения' };
  const render = async () => {
    const [current, list] = await Promise.all([refreshTrust(), api.trust?.list ? api.trust.list() : []]);
    box.replaceChildren(
      el('div', { class: 'hint-text', text: `Текущая папка: ${label[current?.state] || 'нет решения'}${current?.inherited ? ` (наследуется от ${current.folder})` : ''}` }),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn small',
          type: 'button',
          text: 'Решить заново',
          onclick: async () => {
            if (await decideTrust(await api.trust.get(state.projectDir))) render();
          },
        }),
      ]),
      ...(list || []).map((item) =>
        el('div', { class: 'trust-row' }, [
          el('span', { class: `project-trust trust-${item.state}`, text: label[item.state] || item.state }),
          el('span', { class: 'trust-folder', text: item.folder, title: item.folder }),
          el('button', {
            class: 'btn ghost small',
            type: 'button',
            text: 'Забыть',
            onclick: async () => {
              const result = await api.trust.remove(item.folder).catch((err) => ({ ok: false, error: err.message }));
              if (result?.ok === false) toast(result.error || 'Не удалось', 'err');
              render();
            },
          }),
        ]),
      ),
    );
  };
  render();
  return box;
}

/** Решение о доверии с сохранением. true — решение принято. */
async function decideTrust(info) {
  const decision = await askTrust(info);
  if (!decision) return false;
  const result = await api.trust.set(info.projectDir || state.projectDir, decision);
  if (result?.ok === false) {
    toast(result.error || 'Решение не сохранено', 'err');
    return false;
  }
  await refreshTrust();
  toast(decision === 'trusted' ? 'Папка доверена' : 'Папка открыта ограниченно', 'ok');
  return true;
}

/** Запуск, которому может понадобиться решение о доверии: спрашиваем и повторяем один раз. */
async function withTrust(start) {
  let result = await start();
  if (result?.needTrust) {
    const decided = await decideTrust(result);
    if (!decided) return { ok: false, error: 'Запуск отменён: нет решения о доверии к папке' };
    result = await start();
  }
  return result;
}

/* ---------- модальные окна ---------- */

function openModal({ title, body, footer, small = false, wide = false, onClose }) {
  const root = $('#modal-root');
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  const head = el('div', { class: 'modal-head' }, [
    el('h2', { text: title }),
    el('button', { class: 'x', type: 'button', text: '×', onclick: close }),
  ]);
  const bodyEl = el('div', { class: 'modal-body' }, body);
  const footEl = el('div', { class: 'modal-foot' }, footer || []);
  const modal = el('div', { class: `modal${small ? ' small' : ''}${wide ? ' wide' : ''}` }, [head, bodyEl, footEl]);
  const backdrop = el('div', { class: 'modal-backdrop' }, [modal]);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  root.append(backdrop);
  return { close, bodyEl, footEl, modal };
}

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input]);
}

/* ---------- отрисовка ---------- */

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderAll();
  });
}

function isNearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function renderAll() {
  const box = $('#messages');
  const stick = isNearBottom();
  box.replaceChildren();

  if (!state.messages.length && !state.live && !state.liveRuntimes.length && !state.question && !state.approval) {
    box.append(emptyState());
    return;
  }

  for (const message of state.messages) {
    const node = messageNode(message);
    if (node) box.append(node);
  }
  if (state.live) box.append(liveNode());
  for (const live of state.liveRuntimes) {
    box.append(runtimeNode(live.name, live.output, null, true));
  }
  if (state.question) box.append(questionCard());
  if (state.approval) box.append(approvalCard());
  if (stick || state.question || state.approval) box.scrollTop = box.scrollHeight;
}

/* ---------- вопросы агента и карточка плана (CC1.7, CC1.8) ---------- */

/**
 * Системное уведомление, когда окно не в фокусе (CC7.14): агент ждёт ответа
 * или закончил. Клик возвращает окно.
 */
function notify(title, body) {
  try {
    if (document.hasFocus() || typeof Notification === 'undefined') return;
    if (Notification.permission === 'denied') return;
    const show = () => {
      const n = new Notification(title, { body: String(body || '').slice(0, 180), silent: false });
      n.onclick = () => {
        window.focus();
        api.focusMain?.();
        n.close();
      };
    };
    if (Notification.permission === 'granted') show();
    else Notification.requestPermission().then((p) => p === 'granted' && show());
  } catch {
    /* уведомления недоступны — не мешаем работе */
  }
}

function openQuestion(event) {
  notify(event.kind === 'plan' ? 'План готов' : 'Агент спрашивает', event.kind === 'plan' ? 'Выберите, как выполнить план' : event.questions?.[0]?.question);
  const questions = event.questions || [];
  state.question = {
    ...event,
    // Рекомендованный вариант выбран заранее: Enter сразу отвечает рекомендацией.
    picks: questions.map((q) => {
      const index = q.options.findIndex((o) => o.recommended);
      return index >= 0 ? [index] : [];
    }),
    other: questions.map(() => ''),
    feedback: '',
    alternative: Number.isInteger(event.recommended) ? event.recommended : 0,
  };
  renderAll();
  setTimeout(() => document.querySelector('.question-card .recommended, .question-card .primary')?.focus(), 0);
}

function answerQuestion(answer) {
  const current = state.question;
  if (!current) return;
  state.question = null;
  api.chat.answer(current.id, answer);
  renderAll();
}

function submitQuestions() {
  const q = state.question;
  const answers = q.questions.map((item, i) => {
    const labels = (q.picks[i] || []).map((index) => item.options[index]?.label).filter(Boolean);
    const other = String(q.other[i] || '').trim();
    if (item.multiSelect) return other ? [...labels, other] : labels;
    return other || labels[0] || '';
  });
  answerQuestion({ answers });
}

function questionsBody(q) {
  return q.questions.map((item, qi) =>
    el('div', { class: 'question-block' }, [
      el('div', { class: 'question-title' }, [
        item.header ? el('span', { class: 'question-chip', text: item.header }) : null,
        el('span', { text: item.question }),
        item.multiSelect ? el('span', { class: 'hint-text', text: ' (можно несколько)' }) : null,
      ]),
      el(
        'div',
        { class: 'question-options' },
        item.options.map((option, oi) => {
          const picked = (q.picks[qi] || []).includes(oi);
          return el(
            'button',
            {
              class: `question-option${picked ? ' picked' : ''}${option.recommended ? ' recommended' : ''}`,
              type: 'button',
              'aria-pressed': picked ? 'true' : 'false',
              onclick: () => {
                const list = q.picks[qi] || [];
                q.picks[qi] = item.multiSelect ? (picked ? list.filter((x) => x !== oi) : [...list, oi]) : [oi];
                if (!item.multiSelect) q.other[qi] = '';
                renderAll();
              },
            },
            [
              el('span', { class: 'approve-key', text: String(oi + 1) }),
              el('span', { class: 'question-option-text' }, [
                el('b', { text: option.label }),
                option.description ? el('small', { text: option.description }) : null,
              ]),
              option.recommended ? el('span', { class: 'recommended-badge', text: 'Рекомендуется' }) : null,
            ],
          );
        }),
      ),
      el('input', {
        class: 'question-other',
        placeholder: 'Другое…',
        value: q.other[qi] || '',
        oninput: (e) => {
          q.other[qi] = e.target.value;
        },
      }),
    ]),
  );
}

function planBody(q) {
  const tiles = (q.alternatives || []).map((alt, index) =>
    el(
      'button',
      {
        class: `plan-alt${q.alternative === index ? ' picked' : ''}${q.recommended === index ? ' recommended' : ''}`,
        type: 'button',
        onclick: () => {
          q.alternative = index;
          renderAll();
        },
      },
      [
        el('div', { class: 'plan-alt-head' }, [
          el('b', { text: alt.title }),
          el('span', { class: `risk-badge risk-${alt.risk}`, text: RISK_LABEL[alt.risk] || alt.risk }),
          q.recommended === index ? el('span', { class: 'recommended-badge', text: 'Рекомендуется' }) : null,
        ]),
        alt.summary ? el('div', { class: 'plan-alt-text', text: alt.summary }) : null,
        alt.pros ? el('div', { class: 'plan-alt-pros', text: `+ ${alt.pros}` }) : null,
        alt.cons ? el('div', { class: 'plan-alt-cons', text: `− ${alt.cons}` }) : null,
      ],
    ),
  );
  return [
    el('div', { class: 'md plan-text', html: renderMarkdown(q.plan || '') }),
    tiles.length ? el('div', { class: 'docs-group-title', text: 'Альтернативы' }) : null,
    tiles.length ? el('div', { class: 'plan-alts' }, tiles) : null,
  ];
}

function questionCard() {
  const q = state.question;
  const isPlan = q.kind === 'plan';
  const feedback = el('textarea', {
    class: 'approve-feedback',
    rows: '2',
    placeholder: isPlan ? 'Замечания к плану (необязательно)' : 'Комментарий (необязательно)',
    value: q.feedback || '',
    oninput: (e) => {
      q.feedback = e.target.value;
    },
  });
  feedback.value = q.feedback || '';
  const bypassAllowed = (state.permissionModes || []).some((m) => m.id === 'bypass' && !m.disabled);
  const approve = (mode) => answerQuestion({ action: 'approve', mode, alternative: q.alternative, feedback: q.feedback });
  const footer = isPlan
    ? [
        el('button', { class: 'btn primary recommended', type: 'button', onclick: () => approve('acceptEdits') }, [
          el('span', { text: 'Выполнить: принимать правки' }),
          el('span', { class: 'recommended-badge', text: 'Рекомендуется' }),
        ]),
        el('button', { class: 'btn', type: 'button', text: 'Выполнить: вручную', onclick: () => approve('manual') }),
        bypassAllowed ? el('button', { class: 'btn', type: 'button', text: '⚠ Без вопросов', onclick: () => approve('bypass') }) : null,
        el('button', {
          class: 'btn ghost',
          type: 'button',
          text: 'Доработать план',
          onclick: () => answerQuestion({ action: 'revise', feedback: q.feedback }),
        }),
      ]
    : [
        el('button', { class: 'btn primary recommended', type: 'button', text: 'Ответить', onclick: submitQuestions }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Пропустить', onclick: () => answerQuestion({ cancelled: true }) }),
      ];
  return el('div', { class: `question-card${isPlan ? ' plan-card' : ''}` }, [
    el('div', { class: 'question-head', text: isPlan ? 'План готов — как выполнить?' : 'Агент спрашивает' }),
    ...(isPlan ? planBody(q) : questionsBody(q)),
    feedback,
    el('div', { class: 'question-foot' }, footer.filter(Boolean)),
  ]);
}

/** Клавиши карточки: 1–4 — вариант (первый вопрос), Enter — рекомендованное, Esc — пропустить. */
document.addEventListener('keydown', (event) => {
  const q = state.question;
  if (!q || state.approvalOpen) return;
  const tag = event.target?.tagName || '';
  if (event.target?.id === 'input') return; // поле ввода чата — своё поведение
  if (tag === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return; // нативный клик
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
  // В поле «Другое…» Enter отправляет ответ; в textarea Enter — перевод строки.
  if (inField && event.key !== 'Escape' && !(event.key === 'Enter' && tag === 'INPUT')) return;
  if (!inField && q.kind === 'questions' && /^[1-4]$/.test(event.key) && q.questions.length) {
    const item = q.questions[0];
    const index = Number(event.key) - 1;
    if (!item.options[index]) return;
    q.picks[0] = item.multiSelect ? [...new Set([...(q.picks[0] || []), index])] : [index];
    renderAll();
    event.preventDefault();
  } else if (event.key === 'Enter' && !event.shiftKey) {
    if (q.kind === 'plan') answerQuestion({ action: 'approve', mode: 'acceptEdits', alternative: q.alternative, feedback: q.feedback });
    else submitQuestions();
    event.preventDefault();
  } else if (event.key === 'Escape') {
    answerQuestion(q.kind === 'plan' ? { action: 'revise', feedback: q.feedback } : { cancelled: true });
    event.preventDefault();
  }
});

function emptyState() {
  const wrap = el('div', { class: 'empty' }, [
    el('div', { class: 'empty-mark', text: 'M' }),
    el('h1', { text: 'Чем займёмся?' }),
    el('p', {
      text: 'Выберите папку проекта, модель MAI — и опишите задачу. Агент прочитает код, внесёт правки и запустит проверки.',
    }),
  ]);
  const hints = el('div', { class: 'hints' }, [
    hintButton('Разобрать проект', 'Объясни структуру этого проекта и найди слабые места'),
    hintButton('Исправить ошибки', 'Найди и исправь ошибки в последних изменениях'),
    hintButton('Написать тесты', 'Напиши тесты для основного модуля'),
  ]);
  wrap.append(hints);
  return wrap;
}

function hintButton(label, text) {
  return el('button', {
    class: 'hint',
    type: 'button',
    text: label,
    onclick: () => {
      $('#input').value = text;
      send();
    },
  });
}

/**
 * Меню «Скачать» у сообщения: md, txt, docx, xlsx.
 *
 * Содержимое собирает main-процесс (`electron/lib/export`), здесь только
 * вызов и обратная связь. См. ADR 0025.
 */
function exportMenu(markdown) {
  const menu = el('div', { class: 'msg-export' });
  const formats = [['md', 'MD'], ['txt', 'TXT'], ['docx', 'DOCX'], ['xlsx', 'XLSX']];
  for (const [format, label] of formats) {
    const button = el('button', { type: 'button', text: label, title: `Скачать в ${label}` });
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await api.export.message({ markdown, format });
      button.disabled = false;
      if (result?.ok) {
        button.classList.add('done');
        button.textContent = '✓';
        setTimeout(() => { button.classList.remove('done'); button.textContent = label; }, 1500);
      } else if (result?.error) {
        toast(result.error);
      }
    });
    menu.append(button);
  }
  return menu;
}

/**
 * Спрашивает формат у пользователя через простое меню у кнопки.
 * Возвращает `md`, `txt`, `docx`, `xlsx` или пустую строку при отмене.
 */
function pickExportFormat(anchor) {
  return new Promise((resolve) => {
    const menu = el('div', { class: 'export-picker' });
    const formats = [['md', 'Markdown'], ['txt', 'Текст'], ['docx', 'Word'], ['xlsx', 'Excel']];
    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      menu.remove();
      document.removeEventListener('click', onOutside, true);
      resolve(value);
    };
    const onOutside = (event) => {
      if (!menu.contains(event.target)) close('');
    };
    for (const [format, label] of formats) {
      menu.append(el('button', { type: 'button', text: label, onclick: () => close(format) }));
    }
    anchor.after(menu);
    setTimeout(() => document.addEventListener('click', onOutside, true), 0);
  });
}

function messageNode(message) {
  if (message.role === 'user') {
    return el('div', { class: 'msg msg-user' }, [
      el('div', { class: 'bubble', text: message.display || message.content || '' }),
    ]);
  }
  if (message.role === 'runtime') {
    return runtimeNode(message.name || 'Рантайм', message.content || '', message.code, false);
  }
  if (message.role === 'compaction') {
    return el('div', { class: 'msg msg-compaction' }, [
      el('details', { class: 'compaction-card' }, [
        el('summary', {
          text: `Контекст ${message.auto ? 'автоматически ' : ''}сжат: ${message.messages || 0} сообщений → сводка${message.instructions ? ` (учтено: ${message.instructions})` : ''}`,
        }),
        el('div', { class: 'md', html: renderMarkdown(message.content || '') }),
      ]),
    ]);
  }
  if (message.role === 'review') {
    // Замечание ревизора — не реплика пользователя (ADR 0027, A3.4).
    return el('div', { class: 'msg msg-review' }, [
      el('div', { class: 'review-card' }, [
        el('div', { class: 'review-head', text: `Ревизор · раунд ${message.round || ''} · на доработку` }),
        el('div', { class: 'md', html: renderMarkdown(String(message.content || '').replace(/^\[Ревизор, раунд \d+\]\s*/, '')) }),
      ]),
    ]);
  }
  if (message.role === 'assistant') {
    const head = el('div', { class: 'msg-head' }, [
      el('div', { class: 'msg-name', text: `MAI · ${modelLabel(message.model || state.model)}` }),
    ]);
    if (message.usage) {
      // Токены шага (A3.8): вход · выход, из входа — кэш.
      const u = message.usage;
      head.append(
        el('span', {
          class: 'msg-usage',
          text: `↑${contextLabel(u.input)} ↓${contextLabel(u.output)}`,
          title: `Токены шага: вход ${u.input}${u.cached ? ` (из кэша ${u.cached})` : ''}, выход ${u.output}, всего ${u.total}`,
        }),
      );
    }
    if (message.content) head.append(exportMenu(message.content));
    const body = el('div', { class: 'msg-body' }, [head]);
    if (message.reasoning) body.append(thinkingBlock(message.reasoning));
    if (message.content) body.append(el('div', { class: 'md', html: renderMarkdown(message.content) }));
    if (message.tool_calls?.length) {
      const tools = el('div', { class: 'tools' });
      for (const call of message.tool_calls) {
        tools.append(toolCard(call.id, call.function.name, safeJson(call.function.arguments)));
      }
      body.append(tools);
    }
    return el('div', { class: 'msg msg-assistant' }, [el('div', { class: 'avatar', text: 'M' }), body]);
  }
  return null;
}

function liveNode() {
  const body = el('div', { class: 'msg-body' }, [
    el('div', { class: 'msg-name', text: `MAI · ${modelLabel(state.model)}` }),
  ]);
  if (state.live.reasoning) body.append(thinkingBlock(state.live.reasoning, true));
  if (state.live.content) body.append(el('div', { class: 'md', html: renderMarkdown(state.live.content) }));
  if (state.live.tools.length) {
    const tools = el('div', { class: 'tools' });
    for (const tool of state.live.tools) {
      tools.append(toolCard(tool.id, tool.name, tool.args));
    }
    body.append(tools);
  }
  if (!state.live.content && !state.live.tools.length && !state.live.reasoning) {
    body.append(el('div', { class: 'typing' }, [el('i'), el('i'), el('i')]));
  }
  return el('div', { class: 'msg msg-assistant' }, [el('div', { class: 'avatar', text: 'M' }), body]);
}

function runtimeNode(name, output, code, running) {
  const body = el('div', { class: 'msg-body' }, [
    el('div', { class: 'msg-name' }, [
      name,
      running ? ' · выполняется' : code === 0 || code == null ? '' : ` · код ${code}`,
    ]),
    el('pre', { class: 'terminal', text: output || '…' }),
  ]);
  return el('div', { class: 'msg msg-assistant' }, [el('div', { class: 'avatar mono', text: '$' }), body]);
}

function thinkingBlock(text, open = false) {
  const details = el('details', { class: 'thinking' });
  if (open) details.setAttribute('open', '');
  details.append(el('summary', { text: '▸ Размышления' }));
  details.append(el('div', { class: 'think-body', text }));
  return details;
}

function safeJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'));
  } catch {
    return String(raw || '');
  }
}

/** Заголовок карточки инструмента по-человечески (CC7.2): «Edit main.js +3 −1», «Bash npm test». */
function toolTitle(name, argsText, result) {
  let args = {};
  try {
    args = JSON.parse(argsText || '{}');
  } catch {
    args = {};
  }
  const file = (value) => String(value || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  const stats = result?.diff ? ` +${result.diff.added} −${result.diff.removed}` : '';
  switch (name) {
    case 'read_file': {
      const range = args.offset || args.limit ? `:${args.offset || 1}${args.limit ? `-${(args.offset || 1) + args.limit - 1}` : ''}` : '';
      return { verb: 'Read', detail: `${file(args.path)}${range}` };
    }
    case 'list_files':
      return { verb: 'List', detail: file(args.path) || '.' };
    case 'grep':
      return { verb: 'Grep', detail: `${args.pattern || ''}${args.path ? ` в ${file(args.path)}` : ''}` };
    case 'write_file':
      return { verb: result?.diff?.created ? 'Create' : 'Write', detail: `${file(args.path)}${stats}` };
    case 'edit_file':
      return { verb: 'Edit', detail: `${file(args.path)}${stats}` };
    case 'run_shell':
      return { verb: 'Bash', detail: String(args.command || '') };
    case 'memory_append':
      return { verb: 'Memory', detail: `+ ${args.scope || 'project'}` };
    case 'ask_user':
      return { verb: 'Ask', detail: args.questions?.[0]?.question || '' };
    case 'exit_plan':
      return { verb: 'Plan', detail: 'план на согласование' };
    case 'load_skill':
      return { verb: 'Skill', detail: args.name || '' };
    default:
      return { verb: name.startsWith('mcp__') ? `MCP ${name.split('__')[1]}` : name, detail: String(argsText || '').slice(0, 160) };
  }
}

function toolCard(id, name, argsText) {
  const result = state.toolResults[id];
  const status = result ? (result.ok ? 'ok' : 'err') : 'run';
  const live = !result ? state.liveOutput[id] : '';
  // Пока команда идёт, карточка раскрыта и показывает живой вывод (CC7.4).
  const card = el('div', { class: `tool-card${(result && !result.ok) || live ? ' open' : ''}` });
  const title = toolTitle(name, argsText, result);
  const head = el('div', { class: 'tool-head' }, [
    el('span', { class: `tool-dot ${status}` }),
    el('span', { class: 'tool-name', text: title.verb, title: name }),
    el('span', { class: 'tool-args', text: String(title.detail || '').slice(0, 200) }),
  ]);
  head.addEventListener('click', () => card.classList.toggle('open'));
  const body = el('div', { class: 'tool-body' });
  body.append(el('div', { class: 'tool-label', text: 'Аргументы' }));
  body.append(el('pre', { text: String(argsText || '') }));
  if (live) {
    body.append(el('div', { class: 'tool-label', text: 'Вывод (идёт)' }));
    body.append(el('pre', { class: 'tool-live', text: live.slice(-6000) }));
  }
  if (result?.diff) body.append(diffView(result.diff, { limit: 200 }));
  if (result) {
    body.append(el('div', { class: 'tool-label', text: result.ok ? 'Результат' : 'Ошибка' }));
    body.append(el('pre', { text: String(result.content || '').slice(0, 20000) }));
  }
  card.append(head, body);
  return card;
}

function renderSessions() {
  const box = $('#sessions');
  box.replaceChildren();
  for (const session of state.sessions) {
    const node = el('button', {
      class: `session${session.id === state.sessionId ? ' active' : ''}`,
      type: 'button',
      onclick: () => loadSession(session.id),
    }, [
      el('span', { class: 'session-title', text: session.title || 'Без названия' }),
      el('span', { class: 'session-meta', text: `${modelLabel(session.model)} · ${fmtDate(session.updatedAt)}` }),
    ]);
    const del = el('span', {
      class: 'del',
      text: '✕',
      title: 'Удалить чат',
      onclick: async (event) => {
        event.stopPropagation();
        await api.sessions.remove(session.id);
        if (state.sessionId === session.id) newChat();
        await refreshSessions();
      },
    });
    node.append(del);
    box.append(node);
  }
}

function renderModels() {
  const select = $('#model-select');
  select.replaceChildren();
  if (!state.models.length) {
    select.append(el('option', { value: state.model, text: state.model || 'Модели не загружены' }));
    return;
  }

  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.provider)) groups.set(model.provider, { name: model.providerName, items: [] });
    groups.get(model.provider).items.push(model);
  }

  for (const [, group] of groups) {
    const optgroup = el('optgroup', { label: group.name });
    for (const model of group.items) {
      const suffix = model.context ? ` · ${contextLabel(model.context)}` : '';
      optgroup.append(el('option', { value: model.key, text: `${model.name}${suffix}` }));
    }
    select.append(optgroup);
  }

  if (!state.models.some((m) => m.key === state.model) && state.models[0]) {
    state.model = state.models[0].key;
  }
  select.value = state.model;
}

function renderRuntimes() {
  const select = $('#runtime-select');
  select.replaceChildren();
  select.append(el('option', { value: 'agent', text: 'Встроенный агент' }));
  const enabled = enabledRuntimes();
  if (enabled.length > 1) {
    select.append(
      el('option', {
        value: '__all__',
        text: `Все включённые (${enabled.length}, параллельно)`,
      }),
    );
  }
  for (const [id, runtime] of Object.entries(state.runtimes)) {
    const disabled = runtime.enabled === false;
    const option = el('option', {
      value: id,
      text: `${runtime.name || id}${disabled ? ' (выкл.)' : ''}`,
    });
    if (disabled) option.disabled = true;
    select.append(option);
  }
  if (state.runtime !== 'agent' && state.runtime !== '__all__' && !state.runtimes[state.runtime]) {
    state.runtime = 'agent';
  }
  if (state.runtime === '__all__' && enabled.length < 2) state.runtime = 'agent';
  select.value = state.runtime;
}

function updateChrome() {
  $('#project-name').textContent = shortPath(state.projectDir);
  $('#project-name').title = state.projectDir || '';
  const badge = $('#project-trust');
  if (badge) {
    const trust = state.trust?.projectDir === state.projectDir ? state.trust.state : '';
    badge.hidden = !trust || trust === 'trusted';
    badge.className = `project-trust trust-${trust || 'none'}`;
    badge.textContent = trust === 'restricted' ? 'ограниченно' : trust === 'unknown' ? 'не доверена' : '';
    badge.title =
      trust === 'restricted'
        ? 'Плагины, MCP, AGENTS.md, память и навыки проекта не загружаются'
        : 'Решение о доверии к папке спросим перед первым запуском';
  }
  const provider = providerOf(state.model);
  const ready = Boolean(provider?.apiKeySet);
  $('#conn').classList.toggle('bad', !ready);
  $('#conn').querySelector('span').textContent = ready
    ? `${provider?.name || 'MAI'} подключён`
    : `нет ключа · ${provider?.name || 'MAI'}`;
}

/* ---------- данные ---------- */

async function refreshSessions() {
  state.sessions = await api.sessions.list();
  renderSessions();
}

async function loadSession(id) {
  const session = await api.sessions.get(id);
  if (!session) return;
  state.sessionId = session.id;
  state.messages = session.messages || [];
  state.model = session.model || state.model;
  if (session.projectDir) state.projectDir = session.projectDir;
  refreshTrust();
  state.toolResults = {};
  state.liveOutput = {};
  state.todos = todosFromHistory(state.messages);
  renderTodos();
  refreshContext();
  state.live = null;
  state.liveRuntimes = [];
  clearAttachments();
  await refreshPermissionMode();
  for (const message of state.messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      state.toolResults[message.tool_call_id] = {
        ok: !String(message.content || '').startsWith('Ошибка'),
        content: message.content,
        diff: message.diff || null,
      };
    }
  }
  $('#model-select').value = state.model;
  updateChrome();
  renderAll();
  renderSessions();
}

function newChat() {
  state.sessionId = null;
  state.messages = [];
  state.toolResults = {};
  state.liveOutput = {};
  state.todos = [];
  renderTodos();
  state.context = null;
  renderContextMeter();
  state.live = null;
  state.liveRuntimes = [];
  clearAttachments();
  refreshPermissionMode();
  renderAll();
  renderSessions();
  $('#input').focus();
}

async function loadModels(force = false) {
  const result = await api.models(force);
  if (!result.ok) {
    toast(result.error, 'err');
    return;
  }
  state.models = result.models || [];
  state.errors = result.errors || {};
  for (const [provider, error] of Object.entries(state.errors)) {
    console.warn(`[models] ${provider}: ${error}`);
  }
  renderModels();
  updateChrome();
}

/* ---------- отправка ---------- */

/**
 * Отправка. `override` — запрос из слэш-команды: агенту уходит развёрнутый
 * шаблон, в чате видна сама команда (CC7.7, CC7.8).
 */
async function send(override = null) {
  closeSuggest();
  if (state.running) {
    await queueMessage();
    return;
  }
  const input = $('#input');
  const typed = input.value.trim();
  if (!override && typed.startsWith('/') && !typed.startsWith('//')) {
    await runSlash(typed);
    return;
  }
  const text = override ? override.text : typed;
  const hasFiles = state.attachments.length > 0;
  if (!text && !hasFiles) return;
  const display = override?.display || text || 'Прикреплённые файлы';
  const prompt = text + attachmentBlock();
  // Картинки уходят модели как изображения, если она их принимает (F1).
  const images = state.attachments.filter((item) => item.kind === 'image').map((item) => item.path);

  const runtime = activeRuntime();
  const multi = state.runtime === '__all__';
  if (!runtime && !multi) {
    const provider = providerOf(state.model);
    if (!provider?.apiKeySet) {
      toast(`Нет ключа провайдера «${provider?.name || 'MAI'}»`, 'err');
      openProviders();
      return;
    }
  }
  if (!state.projectDir) {
    toast('Выберите папку проекта', 'err');
    await pickProject();
    return;
  }

  input.value = '';
  autosize();
  clearAttachments();

  if (multi) {
    await sendRuntimeMany(prompt, display);
    return;
  }
  if (runtime) {
    await sendRuntime(runtime, prompt, display);
    return;
  }

  state.messages.push({ role: 'user', content: display, display });
  state.live = { content: '', reasoning: '', tools: [] };
  state.running = true;
  setRunning(true);
  renderAll();

  const result = await withTrust(() =>
    api.chat.start({
      sessionId: state.sessionId,
      text: prompt,
      displayText: display,
      model: state.model,
      projectDir: state.projectDir,
      permissionMode: state.permissionMode,
      images,
    }),
  );
  if (!result.ok) {
    toast(result.error, 'err');
    state.running = false;
    state.live = null;
    setRunning(false);
    state.messages.pop();
    renderAll();
    return;
  }
  state.sessionId = result.sessionId;
  await refreshSessions();
  // Сессия создана — режим теперь принадлежит ей, а не значению по умолчанию.
  await refreshPermissionMode();
}

async function sendRuntime(runtime, prompt, display = prompt) {
  state.messages.push({ role: 'user', content: display });
  const id = state.runtime;
  state.liveRuntimes = [{ id, name: runtime.name || 'Рантайм', output: '' }];
  state.running = true;
  setRunning(true);
  renderAll();

  const result = await withTrust(() =>
    api.runtimes.run({
      sessionId: state.sessionId,
      runtime: id,
      text: prompt,
      displayText: display,
      model: state.model,
      projectDir: state.projectDir,
    }),
  );

  if (!result.ok) {
    toast(result.error, 'err');
    state.running = false;
    state.liveRuntimes = [];
    setRunning(false);
    state.messages.pop();
    renderAll();
    return;
  }
  state.sessionId = result.sessionId;
  await refreshSessions();
}

async function sendRuntimeMany(prompt, display = prompt) {
  const ids = enabledRuntimes();
  if (!ids.length) {
    toast('Нет включённых рантаймов', 'err');
    return;
  }
  state.messages.push({ role: 'user', content: display });
  state.liveRuntimes = ids.map((id) => ({
    id,
    name: state.runtimes[id]?.name || id,
    output: '',
  }));
  state.running = true;
  setRunning(true);
  renderAll();

  const result = await withTrust(() =>
    api.runtimes.runMany({
      sessionId: state.sessionId,
      runtimes: ids,
      text: prompt,
      displayText: display,
      model: state.model,
      projectDir: state.projectDir,
    }),
  );

  if (!result.ok) {
    toast(result.error, 'err');
    state.running = false;
    state.liveRuntimes = [];
    setRunning(false);
    state.messages.pop();
    renderAll();
    return;
  }
  state.sessionId = result.sessionId;
  await refreshSessions();
}

function setRunning(running) {
  $('#send').hidden = running;
  $('#stop').hidden = !running;
  $('#composer-hint').textContent = running
    ? state.liveRuntimes.length
      ? 'Рантайм работает…'
      : 'Агент работает · Enter — в очередь · Esc — остановить'
    : '';
}

/* ---------- слэш-команды и @файл (CC7.7–CC7.9) ---------- */

const INIT_PROMPT = [
  'Изучи этот проект: структура, стек, команды сборки и тестов, соглашения в коде.',
  'Напиши или обнови AGENTS.md в корне проекта: короткие обязательные правила для агентов —',
  'как собирать и тестировать, где что лежит, чего не делать. Без воды, только проверенное.',
  'Если AGENTS.md уже есть — сохрани действующие правила и дополни.',
].join(' ');

async function loadCommands() {
  try {
    state.commands = await api.commands.list(state.projectDir);
  } catch {
    state.commands = [];
  }
  return state.commands;
}

function commandHelp() {
  const rows = (state.commands || []).map((c) =>
    el('div', { class: 'help-row' }, [
      el('code', { text: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}` }),
      el('span', { text: c.description || '' }),
      el('span', { class: 'hint-text', text: { builtin: '', project: 'проект', global: 'глобальная', skill: 'навык' }[c.source] || '' }),
    ]),
  );
  openModal({
    title: 'Команды и клавиши',
    body: [
      el('div', { class: 'help-table' }, rows),
      el('div', { class: 'docs-group-title', text: 'Клавиши' }),
      el('div', { class: 'hint-text', text: 'Enter — отправить (во время работы — в очередь) · Shift+Enter — новая строка · Esc — остановить · Shift+Tab — режим · ↑ — последнее сообщение · @ — файл проекта · / — команда' }),
      el('div', { class: 'hint-text', text: 'Свои команды: .mai-code/commands/<имя>.md (проект) и папка commands в данных приложения. В тексте — $ARGUMENTS и $1…$9.' }),
    ],
  });
}

/** Выполняет `/команда аргументы`. */
async function runSlash(text) {
  const input = $('#input');
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return;
  const name = match[1].toLowerCase();
  const args = match[2].trim();
  const clear = () => {
    input.value = '';
    autosize();
  };
  switch (name) {
    case 'help':
      clear();
      await loadCommands();
      commandHelp();
      return;
    case 'clear':
      clear();
      newChat();
      return;
    case 'model': {
      const q = args.toLowerCase();
      const found = state.models.find((m) => m.key.toLowerCase() === q) || state.models.find((m) => `${m.key} ${m.name || ''}`.toLowerCase().includes(q));
      if (!q || !found) {
        toast(q ? `Модель «${args}» не найдена` : 'Укажите часть названия модели: /model opus', 'err');
        return;
      }
      clear();
      state.model = found.key;
      $('#model-select').value = found.key;
      state.settings = await api.settings.save({ activeModel: found.key });
      updateChrome();
      toast(`Модель: ${modelLabel(found.key)}`, 'ok');
      return;
    }
    case 'mode': {
      const modes = state.permissionModes.length ? state.permissionModes : MODE_FALLBACK;
      const found = modes.find((m) => m.id.toLowerCase() === args.toLowerCase() || m.label.toLowerCase() === args.toLowerCase());
      if (!found) {
        toast(`Режимы: ${modes.map((m) => m.id).join(', ')}`, 'err');
        return;
      }
      clear();
      await setPermissionMode(found.id);
      return;
    }
    case 'init':
      clear();
      await send({ text: INIT_PROMPT, display: '/init' });
      return;
    case 'memory':
      clear();
      openMemory();
      return;
    case 'export':
      clear();
      $('#export-chat')?.click();
      return;
    case 'context':
      clear();
      await openContext();
      return;
    case 'compact':
      clear();
      await compactNow(args);
      return;
    case 'cost':
      clear();
      openCost();
      return;
    default: {
      const result = await api.commands.expand(state.projectDir, name, args);
      if (!result?.ok) {
        toast(result?.error || `Команда /${name} не найдена. /help — список`, 'err');
        return;
      }
      clear();
      await send({ text: result.prompt, display: text });
    }
  }
}

/* ---------- контекст, компакция, стоимость (CC5.1–CC5.5) ---------- */

function renderContextMeter() {
  const meter = $('#context-meter');
  if (!meter) return;
  const c = state.context;
  if (!c?.window || !c.used) {
    meter.hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((c.used / c.window) * 100));
  meter.hidden = false;
  meter.textContent = `контекст ${pct}%`;
  meter.className = `context-meter${pct >= 85 ? ' ctx-high' : pct >= 70 ? ' ctx-mid' : ''}`;
  meter.title = `${c.exact ? '' : '≈ '}${contextLabel(c.used)} из ${contextLabel(c.window)} токенов. С 80% ранняя часть диалога сжимается в сводку. /context — подробно`;
}

async function refreshContext() {
  if (!state.sessionId) {
    state.context = null;
    renderContextMeter();
    return;
  }
  try {
    const stats = await api.chat.context({ sessionId: state.sessionId, model: state.model });
    state.context = { used: stats.used, window: stats.window, exact: stats.exact };
  } catch {
    state.context = null;
  }
  renderContextMeter();
}

async function openContext() {
  const stats = await api.chat.context({ sessionId: state.sessionId, projectDir: state.projectDir, model: state.model });
  const max = Math.max(1, ...stats.parts.map((p) => p.tokens));
  const pct = Math.round((stats.used / stats.window) * 100);
  openModal({
    title: 'Контекст модели',
    body: [
      el('p', {
        text: `${stats.exact ? '' : '≈ '}${contextLabel(stats.used)} из ${contextLabel(stats.window)} токенов (${pct}%). ${stats.exact ? 'По данным провайдера за последний запрос и оценке новых сообщений.' : 'Оценка по размеру текста: провайдер ещё не прислал usage.'}`,
      }),
      el(
        'div',
        { class: 'context-parts' },
        stats.parts
          .filter((p) => p.tokens > 0)
          .map((p) =>
            el('div', { class: 'context-row' }, [
              el('span', { text: p.label }),
              el('span', { class: 'context-bar' }, [el('i', { style: `width:${Math.max(2, Math.round((p.tokens / max) * 100))}%` })]),
              el('span', { class: 'context-num', text: `≈ ${contextLabel(p.tokens)}` }),
            ]),
          ),
      ),
      el('p', { class: 'hint-text', text: 'С 80% ранняя часть диалога автоматически сжимается в сводку. Вручную — /compact [что сохранить].' }),
    ],
  });
}

async function compactNow(instructions = '') {
  if (state.running) {
    toast('Агент работает — сожмите контекст после ответа', 'err');
    return;
  }
  if (!state.sessionId) {
    toast('Нет чата для компакции', 'err');
    return;
  }
  setHint('Сжимаю контекст…');
  const result = await api.chat.compact(state.sessionId, instructions);
  setHint('');
  if (!result?.ok) {
    toast(result?.error || 'Компакция не удалась', 'err');
    return;
  }
  state.messages = result.messages;
  renderAll();
  await refreshContext();
  toast(`Контекст сжат: ${result.marker.messages} сообщений → сводка`, 'ok');
}

function setHint(text) {
  const hint = $('#composer-hint');
  if (hint) hint.textContent = text;
}

/** Цена модели за 1 млн токенов из настроек провайдера, если задана. */
function priceOf(modelKey) {
  const [providerId, ...rest] = String(modelKey || '').split('/');
  const id = rest.join('/');
  const provider = state.settings?.providers?.[providerId];
  return (provider?.models || []).find((m) => m.id === id)?.price || null;
}

function openCost() {
  const byModel = new Map();
  for (const m of state.messages) {
    if (m.role !== 'assistant' || !m.usage) continue;
    const key = m.model ? (m.model.includes('/') ? m.model : `${String(state.model).split('/')[0]}/${m.model}`) : state.model;
    const row = byModel.get(key) || { input: 0, output: 0, cached: 0, steps: 0 };
    row.input += m.usage.input || 0;
    row.output += m.usage.output || 0;
    row.cached += m.usage.cached || 0;
    row.steps += 1;
    byModel.set(key, row);
  }
  let total = 0;
  let priced = true;
  const rows = [...byModel.entries()].map(([key, row]) => {
    const price = priceOf(key);
    const cost = price ? (row.input * price.input + row.output * (price.output || 0)) / 1e6 : null;
    if (cost == null) priced = false;
    else total += cost;
    return el('div', { class: 'context-row' }, [
      el('span', { text: modelLabel(key) }),
      el('span', { class: 'context-num', text: `${row.steps} шагов · ↑${contextLabel(row.input)}${row.cached ? ` (кэш ${contextLabel(row.cached)})` : ''} ↓${contextLabel(row.output)}` }),
      el('span', { class: 'context-num', text: cost == null ? 'цена не задана' : `$${cost.toFixed(4)}` }),
    ]);
  });
  openModal({
    title: 'Токены и стоимость чата',
    body: [
      rows.length ? el('div', { class: 'context-parts' }, rows) : el('p', { text: 'Провайдер ещё не прислал данных о токенах для этого чата.' }),
      rows.length && total ? el('p', { text: `Итого: $${total.toFixed(4)}${priced ? '' : ' (без моделей без цены)'}` }) : null,
      el('p', { class: 'hint-text', text: 'Цена задаётся у модели провайдера: "price": { "input": 3, "output": 15 } — долларов за 1 млн токенов.' }),
    ],
  });
}

/* ---------- всплывающие подсказки ---------- */

const suggest = { kind: '', items: [], index: 0, token: null, timer: null };

function closeSuggest() {
  suggest.kind = '';
  suggest.items = [];
  const box = $('#suggest');
  if (box) box.hidden = true;
}

function renderSuggest() {
  const box = $('#suggest');
  if (!box) return;
  if (!suggest.items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(
    ...suggest.items.map((item, i) =>
      el(
        'button',
        {
          class: `suggest-item${i === suggest.index ? ' active' : ''}`,
          type: 'button',
          onmousedown: (e) => {
            e.preventDefault();
            suggest.index = i;
            acceptSuggest(false);
          },
        },
        suggest.kind === 'slash'
          ? [
              el('code', { text: `/${item.name}` }),
              item.argumentHint ? el('span', { class: 'hint-text', text: item.argumentHint }) : null,
              el('span', { class: 'suggest-desc', text: item.description || '' }),
              item.source !== 'builtin' ? el('span', { class: 'suggest-source', text: { project: 'проект', global: 'глобальная', skill: 'навык' }[item.source] || '' }) : null,
            ]
          : [el('span', { class: 'suggest-path', text: item })],
      ),
    ),
  );
}

/** Что подсказывать по тексту до курсора: команду в начале строки или файл после @. */
async function updateSuggest() {
  const input = $('#input');
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash && !input.value.includes('\n')) {
    if (!state.commands) await loadCommands();
    const q = slash[1].toLowerCase();
    const list = (state.commands || []).filter((c) => c.name.toLowerCase().startsWith(q));
    const more = (state.commands || []).filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    suggest.kind = 'slash';
    suggest.items = [...list, ...more].slice(0, 12);
    suggest.index = 0;
    suggest.token = { start: 0, end: before.length };
    renderSuggest();
    return;
  }
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention && state.projectDir) {
    const query = mention[2];
    const start = before.length - query.length - 1;
    clearTimeout(suggest.timer);
    suggest.timer = setTimeout(async () => {
      const items = await api.files.search(state.projectDir, query).catch(() => []);
      // Курсор мог уйти, пока шёл поиск.
      const now = input.value.slice(0, input.selectionStart ?? input.value.length);
      if (!/(^|\s)@([^\s@]*)$/.test(now)) return;
      suggest.kind = 'mention';
      suggest.items = items;
      suggest.index = 0;
      suggest.token = { start, end: now.length };
      renderSuggest();
    }, 120);
    return;
  }
  closeSuggest();
}

/** Подставляет выбранное. Команда без аргументов по Enter выполняется сразу. */
function acceptSuggest(run) {
  const input = $('#input');
  const item = suggest.items[suggest.index];
  if (!item || !suggest.token) return;
  const { start, end } = suggest.token;
  if (suggest.kind === 'slash') {
    input.value = `/${item.name}${item.argumentHint ? ' ' : ''}${input.value.slice(end)}`;
    closeSuggest();
    autosize();
    input.focus();
    if (run && !item.argumentHint) send();
    return;
  }
  const insert = `@${item}${item.endsWith('/') ? '' : ' '}`;
  input.value = `${input.value.slice(0, start)}${insert}${input.value.slice(end)}`;
  const caret = start + insert.length;
  input.setSelectionRange(caret, caret);
  closeSuggest();
  autosize();
  input.focus();
  // Папка: сразу показать её содержимое.
  if (item.endsWith('/')) updateSuggest();
}

function onSuggestKey(event) {
  if (!suggest.items.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const step = event.key === 'ArrowDown' ? 1 : -1;
    suggest.index = (suggest.index + step + suggest.items.length) % suggest.items.length;
    renderSuggest();
  } else if (event.key === 'Tab' && !event.shiftKey) {
    acceptSuggest(false);
  } else if (event.key === 'Enter' && !event.shiftKey) {
    acceptSuggest(true);
  } else if (event.key === 'Escape') {
    closeSuggest();
  } else {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
}

/* ---------- очередь сообщений, задачи, клавиши (CC7.5, CC1.5, CC7.6) ---------- */

/** Сообщение во время работы агента уходит в очередь и встанет в историю перед следующим шагом. */
async function queueMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (state.liveRuntimes.length) {
    toast('Внешний рантайм не принимает сообщения на ходу — дождитесь ответа', 'err');
    return;
  }
  if (state.attachments.length) toast('Вложения уйдут со следующим запросом, после ответа агента');
  const result = await api.chat.queue(text, text);
  if (result?.idle) {
    // Агент как раз закончил — отправляем обычным запросом.
    state.running = false;
    await send();
    return;
  }
  if (!result?.ok) {
    toast(result?.error || 'Сообщение не поставлено в очередь', 'err');
    return;
  }
  state.queue.push({ id: result.id, text });
  input.value = '';
  autosize();
  renderQueue();
}

function renderQueue() {
  const box = $('#queue');
  if (!box) return;
  box.hidden = !state.queue.length;
  box.replaceChildren(
    ...state.queue.map((item) =>
      el('div', { class: 'queue-item', title: 'Агент прочитает это перед следующим шагом' }, [
        el('span', { class: 'queue-label', text: 'в очереди' }),
        el('span', { class: 'queue-text', text: item.text }),
        el('button', {
          class: 'queue-remove',
          type: 'button',
          title: 'Убрать из очереди и вернуть в поле ввода',
          text: '✕',
          onclick: async () => {
            const result = await api.chat.unqueue(item.id);
            state.queue = state.queue.filter((q) => q.id !== item.id);
            if (result?.ok) {
              const input = $('#input');
              input.value = [item.text, input.value].filter(Boolean).join('\n');
              autosize();
            } else {
              toast(result?.error || 'Уже передано агенту');
            }
            renderQueue();
          },
        }),
      ]),
    ),
  );
}

/** Последний список задач из истории — при открытии чата. */
function todosFromHistory(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const calls = messages[i]?.tool_calls || [];
    for (let j = calls.length - 1; j >= 0; j -= 1) {
      if (calls[j]?.function?.name !== 'todo_write') continue;
      try {
        const todos = JSON.parse(calls[j].function.arguments || '{}').todos;
        return Array.isArray(todos) ? todos : [];
      } catch {
        return [];
      }
    }
  }
  return [];
}

function renderTodos() {
  const box = $('#todos');
  if (!box) return;
  const todos = state.todos || [];
  box.hidden = !todos.length;
  if (!todos.length) {
    box.replaceChildren();
    return;
  }
  const done = todos.filter((t) => t.status === 'completed').length;
  const icon = { pending: '☐', in_progress: '◐', completed: '☑' };
  box.replaceChildren(
    el(
      'button',
      {
        class: 'todos-head',
        type: 'button',
        onclick: () => {
          state.todosCollapsed = !state.todosCollapsed;
          renderTodos();
        },
      },
      [el('span', { text: `Задачи агента: ${done} из ${todos.length}` }), el('span', { class: 'hint-text', text: state.todosCollapsed ? '▸' : '▾' })],
    ),
    state.todosCollapsed
      ? null
      : el(
          'ul',
          { class: 'todos-list' },
          todos.map((t) =>
            el('li', { class: `todo todo-${t.status}` }, [
              el('span', { class: 'todo-icon', text: icon[t.status] || '☐' }),
              el('span', { text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content }),
            ]),
          ),
        ),
  );
}

function stopRun() {
  if (state.liveRuntimes.length) api.runtimes.stop();
  else api.chat.stop();
}

/** Режимы по кругу для Shift+Tab: недоступные пропускаются, «Без вопросов» — с подтверждением. */
function nextMode() {
  const modes = (state.permissionModes.length ? state.permissionModes : MODE_FALLBACK).filter((m) => !m.disabled);
  const index = modes.findIndex((m) => m.id === state.permissionMode);
  return modes[(index + 1) % modes.length]?.id || 'manual';
}

/**
 * Горячие клавиши (CC7.6): Esc — остановить агента, Shift+Tab — следующий
 * режим, ↑ в пустом поле — вернуть последнее сообщение.
 */
document.addEventListener('keydown', (event) => {
  if (state.approval || state.question || document.querySelector('.modal-backdrop')) return;
  const input = $('#input');
  if (event.key === 'Escape' && state.running) {
    event.preventDefault();
    stopRun();
    return;
  }
  if (event.key === 'Tab' && event.shiftKey && (event.target === input || event.target === document.body)) {
    event.preventDefault();
    setPermissionMode(nextMode());
    return;
  }
  if (event.key === 'ArrowUp' && event.target === input && !input.value) {
    const last = [...state.messages].reverse().find((m) => m.role === 'user');
    if (last) {
      event.preventDefault();
      input.value = last.display || last.content || '';
      autosize();
    }
  }
});

/* ---------- события ---------- */

function handleEvent(event) {
  switch (event.type) {
    case 'delta':
      if (!state.live) state.live = { content: '', reasoning: '', tools: [] };
      state.live.content += event.text;
      scheduleRender();
      break;
    case 'reasoning':
      if (!state.live) state.live = { content: '', reasoning: '', tools: [] };
      state.live.reasoning += event.text;
      scheduleRender();
      break;
    case 'assistant':
      state.messages.push(event.message);
      state.live = { content: '', reasoning: '', tools: [] };
      scheduleRender();
      break;
    case 'tool_call':
      if (!state.live) state.live = { content: '', reasoning: '', tools: [] };
      state.live.tools.push({ id: event.id, name: event.name, args: safeJson(JSON.stringify(event.args)) });
      scheduleRender();
      break;
    case 'tool_result':
      state.toolResults[event.id] = { ok: event.ok, content: event.content, diff: event.diff || null };
      scheduleRender();
      break;
    case 'approval':
      askApproval(event);
      break;
    case 'question':
      openQuestion(event);
      break;
    case 'context':
      state.context = { used: event.used, window: event.window, exact: event.exact };
      renderContextMeter();
      break;
    case 'compact:start':
      setHint('Сжимаю контекст…');
      break;
    case 'compaction':
      state.messages.push(event.marker);
      setHint(state.running ? 'Агент работает · Enter — в очередь · Esc — остановить' : '');
      toast(`Контекст ${event.marker.auto ? 'автоматически ' : ''}сжат: ${event.marker.messages} сообщений → сводка`, 'ok');
      scheduleRender();
      break;
    case 'tool_progress': {
      const previous = state.liveOutput[event.id] || '';
      state.liveOutput[event.id] = (previous + event.text).slice(-20000);
      scheduleRender();
      break;
    }
    case 'todos':
      state.todos = event.todos || [];
      renderTodos();
      break;
    case 'queued:consumed': {
      const ids = new Set(event.ids || []);
      for (const item of state.queue.filter((q) => ids.has(q.id))) {
        state.messages.push({ role: 'user', content: item.text, display: item.text, queued: true });
      }
      state.queue = state.queue.filter((q) => !ids.has(q.id));
      renderQueue();
      scheduleRender();
      break;
    }
    case 'queued:returned': {
      // Агент закончил, не взяв сообщения: возвращаем их в поле ввода.
      const input = $('#input');
      const texts = (event.items || []).map((item) => item.text);
      state.queue = [];
      renderQueue();
      if (texts.length) {
        input.value = [...texts, input.value].filter(Boolean).join('\n');
        autosize();
        toast('Сообщения из очереди возвращены в поле ввода');
      }
      break;
    }
    case 'question:expired':
      state.question = null;
      toast('Вопрос агента остался без ответа — агент продолжил по рекомендации', 'err');
      renderAll();
      break;
    case 'mode:changed':
      refreshPermissionMode();
      break;
    case 'approval:expired':
      state.approvalOpen = false;
      state.approval = null;
      renderAll();
      toast('Подтверждение истекло — действие отменено', 'err');
      break;
    case 'notice':
      toast(event.text || '', 'ok');
      break;
    case 'review:start':
      toast(`Ревизор ${event.model || ''} проверяет ответ…`);
      break;
    case 'review:result':
      toast(
        event.verdict === 'approve'
          ? `Ревизор: принято${event.reason ? ` — ${event.reason}` : ''}`
          : `Ревизор: на доработку${event.reason ? ` — ${event.reason}` : ''}`,
        event.verdict === 'approve' ? 'ok' : 'err',
      );
      break;
    case 'done':
      notify('Агент закончил', [...(event.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '');
      state.messages = event.messages || state.messages;
      state.live = null;
      state.running = false;
      setRunning(false);
      renderAll();
      refreshSessions();
      break;
    case 'error':
      toast(event.message || 'Ошибка', 'err');
      state.live = null;
      state.running = false;
      setRunning(false);
      renderAll();
      refreshSessions();
      break;
    case 'saved':
      if (event.sessionId) state.sessionId = event.sessionId;
      refreshSessions();
      break;
    case 'runtime:start': {
      const id = event.runtimeId || '__single__';
      let live = state.liveRuntimes.find((item) => item.id === id);
      if (!live) {
        live = { id, name: event.name || 'Рантайм', output: '' };
        state.liveRuntimes.push(live);
      }
      live.name = event.name || live.name;
      scheduleRender();
      break;
    }
    case 'runtime:chunk': {
      const id = event.runtimeId || '__single__';
      const live = state.liveRuntimes.find((item) => item.id === id) || state.liveRuntimes[0];
      if (live) {
        live.output += event.text;
        scheduleRender();
      }
      break;
    }
    case 'runtime:exit': {
      const id = event.runtimeId || '__single__';
      const index = state.liveRuntimes.findIndex((item) => item.id === id);
      const live = index >= 0 ? state.liveRuntimes[index] : null;
      const name = event.name || live?.name || 'Рантайм';
      const output = event.output ?? live?.output ?? '';
      if (index >= 0) state.liveRuntimes.splice(index, 1);
      const remaining = event.pending ?? state.liveRuntimes.length;
      state.running = remaining > 0;
      setRunning(state.running);
      state.messages.push({ role: 'runtime', runtimeId: event.runtimeId || '', name, content: output, code: event.code });
      if (event.sessionId) state.sessionId = event.sessionId;
      if (event.error) toast(`${name}: ${event.error}`, 'err');
      renderAll();
      refreshSessions();
      break;
    }
    default:
      break;
  }
}

const RISK_LABEL = { low: 'Низкий риск', medium: 'Средний риск', high: 'Высокий риск' };
const CLASS_LABEL = {
  read: 'чтение',
  write: 'правка файла',
  exec: 'команда',
  memory: 'память',
  network: 'сеть',
  external: 'внешний инструмент',
};

/** Diff правки: строки с подсветкой, счётчики +/−. */
function diffView(diff, { limit = 400 } = {}) {
  if (!diff?.lines?.length) return null;
  const rows = diff.lines.slice(0, limit).map((line) =>
    el('div', { class: `diff-row diff-${line.type === '+' ? 'add' : line.type === '-' ? 'del' : line.type === '@' ? 'hunk' : 'ctx'}` }, [
      el('span', { class: 'diff-sign', text: line.type === '@' ? '' : line.type }),
      el('span', { class: 'diff-text', text: line.text }),
    ]),
  );
  return el('div', { class: 'diff-view' }, [
    el('div', { class: 'diff-stats' }, [
      diff.created ? el('span', { text: 'новый файл · ' }) : null,
      el('span', { class: 'diff-plus', text: `+${diff.added}` }),
      el('span', { text: ' ' }),
      el('span', { class: 'diff-minus', text: `−${diff.removed}` }),
      diff.truncated ? el('span', { class: 'hint-text', text: ' · показано не всё' }) : null,
    ]),
    el('div', { class: 'diff-body' }, rows),
  ]);
}

/**
 * Запрос разрешения (ADR 0027, CC7.1) — карточкой в ленте. Три ответа, как в
 * Claude Code: 1 — да; 2 — да и не спрашивать (правило на чат или всегда);
 * 3 — нет, с пояснением для агента. Рекомендованный ответ подсвечен и в фокусе.
 */
function askApproval(event) {
  notify('Нужно разрешение', event.summary || event.tool || '');
  // Второй запрос не должен перекрывать первый: первый остался бы без ответа.
  if (state.approval) {
    api.chat.approve(event.id, false, { feedback: 'Предыдущий запрос ещё открыт.' });
    toast('Предыдущее подтверждение ещё открыто — новое действие отклонено', 'err');
    return;
  }
  state.approvalOpen = true;
  state.approval = { ...event, feedback: '', scope: 'session' };
  renderAll();
  setTimeout(() => document.querySelector('.approval-card .recommended')?.focus(), 0);
}

function answerApproval(allow, extra = {}) {
  const current = state.approval;
  if (!current) return;
  // Пояснение берём из поля: вставка и автозаполнение не всегда шлют input.
  const typed = document.querySelector('.approval-card .approve-feedback')?.value;
  if (!allow && typed !== undefined) extra = { ...extra, feedback: typed };
  state.approval = null;
  state.approvalOpen = false;
  api.chat.approve(current.id, allow, extra);
  renderAll();
}

function approvalCard() {
  const a = state.approval;
  const recommended = a.recommended === 'deny' ? 'deny' : 'allow';
  const suggestions = Array.isArray(a.suggestions) ? a.suggestions : [];
  const risk = a.risk || 'medium';
  const feedback = el('textarea', {
    class: 'approve-feedback',
    rows: '2',
    placeholder: 'Что сделать иначе (необязательно, уйдёт агенту при отказе)',
    oninput: (e) => {
      a.feedback = e.target.value;
    },
  });
  feedback.value = a.feedback || '';
  const scope = el('select', { class: 'approve-scope', onchange: (e) => (a.scope = e.target.value) }, [
    el('option', { value: 'session', text: 'в этом чате' }),
    el('option', { value: 'global', text: 'всегда (все чаты)' }),
  ]);
  scope.value = a.scope || 'session';
  const option = (key, label, kind, onclick) =>
    el(
      'button',
      { class: `btn approve-option${kind === recommended ? ' primary recommended' : ''}`, type: 'button', 'data-key': key, onclick },
      [
        el('span', { class: 'approve-key', text: key }),
        el('span', { text: label }),
        kind === recommended ? el('span', { class: 'recommended-badge', text: 'Рекомендуется' }) : null,
      ],
    );
  return el('div', { class: 'approval-card' }, [
    el('div', { class: 'question-head', text: 'Разрешить действие?' }),
    el('div', { class: 'approve-meta' }, [
      el('span', { class: `risk-badge risk-${risk}`, text: RISK_LABEL[risk] || risk }),
      el('span', { class: 'approve-class', text: CLASS_LABEL[a.cls] || a.cls || '' }),
      el('span', { class: 'hint-text', text: a.tool || a.name || '' }),
    ]),
    el('div', { class: 'approve-args', text: a.summary || '' }),
    diffView(a.diff),
    a.why ? el('p', { class: 'hint-text', text: `Почему спрашиваем: ${a.why}.` }) : null,
    a.rule ? el('p', { class: 'hint-text', text: `Сработало правило ask: ${a.rule}` }) : null,
    a.args && a.cls === 'external'
      ? el('details', { class: 'approve-details' }, [el('summary', { text: 'Аргументы' }), el('pre', { text: a.args })])
      : null,
    feedback,
    el('div', { class: 'approve-actions' }, [
      option('1', 'Да', 'allow', () => answerApproval(true)),
      suggestions.length
        ? el('div', { class: 'approve-always' }, [
            option('2', `Да, и не спрашивать: ${suggestions.join(', ')}`, 'always', () =>
              answerApproval(true, { remember: a.scope || 'session', rules: suggestions }),
            ),
            scope,
          ])
        : null,
      option('3', 'Нет', 'deny', () => answerApproval(false, { feedback: a.feedback })),
    ]),
  ]);
}

/** Клавиши запроса разрешения: 1 — да, 2 — да и не спрашивать, 3/Esc — нет. */
document.addEventListener('keydown', (event) => {
  const a = state.approval;
  if (!a) return;
  const tag = event.target?.tagName || '';
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && event.key !== 'Escape') return;
  const suggestions = Array.isArray(a.suggestions) ? a.suggestions : [];
  if (event.key === '1') answerApproval(true);
  else if (event.key === '2' && suggestions.length) answerApproval(true, { remember: a.scope || 'session', rules: suggestions });
  else if (event.key === '3' || event.key === 'Escape') answerApproval(false, { feedback: a.feedback });
  else return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

/* ---------- настройки ---------- */

async function openSettings() {
  const settings = state.settings;
  const temperature = el('input', { type: 'number', step: '0.1', min: '0', max: '2', value: settings.temperature });
  const maxIterations = el('input', { type: 'number', min: '1', max: '100', value: settings.maxIterations });
  const outside = el('input', { type: 'checkbox' });
  outside.checked = Boolean(settings.allowOutsideProject);
  const reviewerEnabled = el('input', { type: 'checkbox' });
  reviewerEnabled.checked = Boolean(settings.reviewer?.enabled);
  const reviewerModel = el('input', {
    value: settings.reviewer?.model || '',
    placeholder: 'провайдер/модель или пусто — модель агента',
  });
  const reviewerRounds = el('input', {
    type: 'number',
    min: '0',
    max: '5',
    value: settings.reviewer?.maxRounds ?? 2,
  });
  const guard = settings.guardrails || {};
  const guardEnabled = el('input', { type: 'checkbox' });
  guardEnabled.checked = guard.enabled !== false;
  const guardDangerous = el('input', { type: 'checkbox' });
  guardDangerous.checked = guard.blockDangerous !== false;
  const guardSecrets = el('input', { type: 'checkbox' });
  guardSecrets.checked = guard.protectSecrets !== false;
  const guardAllowSecrets = el('input', { type: 'checkbox' });
  guardAllowSecrets.checked = Boolean(guard.allowSecrets);
  const guardMaxLength = el('input', {
    type: 'number',
    min: '100',
    max: '20000',
    value: guard.maxCommandLength ?? 4000,
  });
  const guardExtra = el('textarea', {
    rows: '3',
    placeholder: 'Дополнительные запреты: по одному регулярному выражению в строке',
  });
  guardExtra.value = (guard.extraDeny || []).join('\n');
  const telemetry = settings.telemetry || {};
  const telemetryEnabled = el('input', { type: 'checkbox' });
  telemetryEnabled.checked = Boolean(telemetry.enabled);
  const telemetryEndpoint = el('input', {
    value: telemetry.endpoint || 'http://127.0.0.1:4318',
    placeholder: 'http://127.0.0.1:4318',
  });
  const mas = settings.mas || {};
  const masEnabled = el('input', { type: 'checkbox' });
  masEnabled.checked = mas.enabled !== false;
  const masUrl = el('input', {
    value: mas.url || 'http://127.0.0.1:8765',
    placeholder: 'http://127.0.0.1:8765',
  });
  const masModel = el('input', {
    value: mas.model || 'gigaam-v3-e2e-ctc',
    placeholder: 'gigaam-v3-e2e-ctc',
  });
  const masToken = el('input', {
    value: '',
    placeholder: mas.tokenSet ? 'токен сохранён — оставьте пусто' : 'автоматически из %APPDATA%\\MAS\\data\\api-token',
  });
  const masCheck = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Проверить связь',
    onclick: async () => {
      const status = await api.mas.status();
      if (status.ok) toast(`MAS ${status.version}: связь есть, модель ${status.model}`, 'ok');
      else toast(status.error || 'MAS недоступен', 'error');
    },
  });

  const ocr = settings.ocr || {};
  const ocrEnabled = el('input', { type: 'checkbox' });
  ocrEnabled.checked = ocr.enabled !== false;
  const ocrEngine = el('select', {}, [
    el('option', { value: 'auto', text: 'Авто — локальный движок, сеть последней' }),
    el('option', { value: 'winrt', text: 'Windows (WinRT) — офлайн' }),
    el('option', { value: 'vision', text: 'macOS Vision — офлайн' }),
    el('option', { value: 'tesseract', text: 'tesseract — офлайн, нужен в PATH' }),
    el('option', { value: 'mai', text: 'Шлюз MAI — сеть, расход токенов' }),
  ]);
  ocrEngine.value = ocr.engine || 'auto';
  const ocrLanguage = el('input', { value: ocr.language || 'ru', placeholder: 'ru' });
  const ocrCheck = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Проверить движки',
    onclick: async () => {
      const status = await api.ocr.status({ force: true });
      if (!status.ok) {
        toast(status.error || 'OCR недоступен', 'error');
        return;
      }
      const ready = Object.entries(status.engines || {})
        .filter(([, info]) => info.available)
        .map(([id]) => id);
      if (ready.length) {
        toast(`OCR: доступны ${ready.join(', ')}. Выбран ${status.preferred || 'нет'}`, 'ok');
      } else {
        toast('OCR: ни один движок не доступен', 'error');
      }
    },
  });
  const modal = openModal({
    title: 'Настройки',
    body: [
      el('div', { class: 'row' }, [
        field('Температура', temperature),
        field('Максимум шагов агента', maxIterations),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Доступ к файлам вне проекта' }),
        el('label', { class: 'hint-text' }, [outside, ' разрешить абсолютные пути вне папки проекта']),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Ревизор: вторая модель проверяет ответ' }),
        el('label', { class: 'hint-text' }, [reviewerEnabled, ' включить approve/revise']),
      ]),
      el('div', { class: 'row' }, [
        field('Модель ревизора', reviewerModel),
        field('Раундов доработки', reviewerRounds),
      ]),
      el('div', { class: 'docs-group-title', text: 'Ключи и токены' }),
      el('p', {
        class: `hint-text secrets-${settings.secretsProtection || 'none'}`,
        text:
          settings.secretsProtection === 'os'
            ? 'Ключи провайдеров, токены Vault и MAS зашифрованы хранилищем ОС: в settings.json их не прочитать.'
            : settings.secretsProtection === 'weak'
              ? 'Хранилище ключей ОС недоступно (Linux без keyring): ключи зашифрованы без ключа ОС — это слабая защита.'
              : 'Хранилище ключей ОС недоступно: ключи лежат в settings.json открытым текстом.',
      }),
      settings.secretsUnreadable?.length
        ? el('p', {
            class: 'hint-text secrets-none',
            text: `Не удалось расшифровать: ${settings.secretsUnreadable.join(', ')}. Ключи на диске сохранены; введите их заново, если хранилище ОС сменилось.`,
          })
        : null,
      el('div', { class: 'docs-group-title', text: 'Доверие к папкам' }),
      trustSettingsBlock(),
      el('div', { class: 'docs-group-title', text: 'Guardrails' }),
      el('label', { class: 'hint-text' }, [guardEnabled, ' включить guardrails для встроенного агента']),
      el('label', { class: 'hint-text' }, [guardDangerous, ' блокировать разрушительные команды (rm -rf /, format, pipe-to-shell и т. п.)']),
      el('label', { class: 'hint-text' }, [guardSecrets, ' защищать секретные файлы (.env, ключи, .ssh, .npmrc)']),
      el('label', { class: 'hint-text' }, [guardAllowSecrets, ' разрешить доступ к секретам (осторожно)']),
      el('div', { class: 'row' }, [
        field('Максимальная длина команды', guardMaxLength),
        field('Дополнительные запреты', guardExtra),
      ]),
      el('p', {
        class: 'hint-text',
        text: 'Guardrails не заменяют песочницу: внешние рантаймы запускаются как отдельные процессы/контейнеры и не проходят эти проверки.',
      }),
      el('div', { class: 'docs-group-title', text: 'OpenTelemetry' }),
      el('label', { class: 'hint-text' }, [telemetryEnabled, ' отправлять логи и трейсы в OTLP-коллектор']),
      field('OTLP HTTP endpoint', telemetryEndpoint),
      el('p', {
        class: 'hint-text',
        text: 'Локальный стек: npm run obs:up. Grafana — http://localhost:3001, Tempo/Loki — 72 часа.',
      }),
      el('div', { class: 'docs-group-title', text: 'MAS — распознавание речи' }),
      el('label', { class: 'hint-text' }, [masEnabled, ' кнопка микрофона отправляет запись в локальный MAS']),
      el('div', { class: 'row' }, [field('Адрес MAS', masUrl), field('Модель', masModel)]),
      el('div', { class: 'row' }, [field('Токен', masToken), masCheck]),
      el('p', {
        class: 'hint-text',
        text: 'MAS слушает только 127.0.0.1. Токен лежит в %APPDATA%\\MAS\\data\\api-token и подхватывается сам.',
      }),
      el('div', { class: 'docs-group-title', text: 'OCR — текст на изображениях' }),
      el('label', { class: 'hint-text' }, [ocrEnabled, ' кнопка «текст» у изображения распознаёт его']),
      el('div', { class: 'row' }, [field('Движок', ocrEngine), field('Язык', ocrLanguage)]),
      el('div', { class: 'row' }, [ocrCheck]),
      el('p', {
        class: 'hint-text',
        text: 'Локальные движки не отправляют изображение в сеть. Шлюз MAI отправляет и расходует токены.',
      }),
      el('p', {
        class: 'hint-text',
        text: 'Провайдеры и ключи — в панели «Провайдеры». Настройки лежат в %APPDATA%\\mai-code\\settings.json',
      }),
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Отмена',
        onclick: () => modal.close(),
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          state.settings = await api.settings.save({
            temperature: Number(temperature.value),
            maxIterations: Number(maxIterations.value),
            allowOutsideProject: outside.checked,
            reviewer: {
              enabled: reviewerEnabled.checked,
              model: reviewerModel.value.trim(),
              maxRounds: Math.max(0, Math.min(5, Number(reviewerRounds.value || 0))),
            },
            guardrails: {
              enabled: guardEnabled.checked,
              blockDangerous: guardDangerous.checked,
              protectSecrets: guardSecrets.checked,
              allowSecrets: guardAllowSecrets.checked,
              maxCommandLength: Math.max(100, Math.min(20000, Number(guardMaxLength.value || 4000))),
              extraDeny: guardExtra.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
            },
            telemetry: {
              enabled: telemetryEnabled.checked,
              endpoint: telemetryEndpoint.value.trim() || 'http://127.0.0.1:4318',
              serviceName: 'mai-code',
            },
            mas: {
              enabled: masEnabled.checked,
              url: masUrl.value.trim() || 'http://127.0.0.1:8765',
              model: masModel.value.trim() || 'gigaam-v3-e2e-ctc',
              // Пустое поле значит «оставить прежний токен»: иначе сохранение
              // настроек стирало токен удалённого MAS.
              token: masToken.value.trim() || String(mas.token || ''),
            },
            ocr: {
              enabled: ocrEnabled.checked,
              engine: ocrEngine.value || 'auto',
              language: ocrLanguage.value.trim() || 'ru',
            },
          });
          updateChrome();
          modal.close();
          toast('Настройки сохранены', 'ok');
        },
      }),
    ],
  });
}

/* ---------- AGENTS.md ---------- */

async function openAgents() {
  if (!state.projectDir) return toast('Сначала выберите папку проекта', 'err');
  const data = await api.agents.read(state.projectDir);
  const projectArea = el('textarea', { rows: '12', placeholder: 'Инструкции для этого проекта…' });
  projectArea.value = data.project;
  const globalArea = el('textarea', { rows: '8', placeholder: 'Глобальные инструкции для всех проектов…' });
  globalArea.value = data.global;

  const modal = openModal({
    title: 'AGENTS.md',
    body: [
      el('p', { class: 'hint-text', text: data.projectFile }),
      projectArea,
      el('p', { class: 'hint-text', text: data.globalFile }),
      globalArea,
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Открыть папку',
        onclick: () => api.showItem(data.projectFile),
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          await api.agents.write(data.projectFile, projectArea.value);
          await api.agents.write(data.globalFile, globalArea.value);
          modal.close();
          toast('AGENTS.md сохранён', 'ok');
        },
      }),
    ],
  });
}

/* ---------- память ---------- */

async function openMemory() {
  if (!state.projectDir) return toast('Сначала выберите папку проекта', 'err');
  const data = await api.memory.read(state.projectDir);
  const versions = data.versions || {};

  const projectArea = el('textarea', { rows: '12', placeholder: 'Уроки и решения этого проекта…' });
  projectArea.value = data.project;
  const globalArea = el('textarea', { rows: '8', placeholder: 'Общие уроки для всех проектов…' });
  globalArea.value = data.global;

  const historyTitle = el('p', { class: 'hint-text', text: 'История версий: проект' });
  const historyBox = el('div', { class: 'list' });

  const renderHistory = (scope) => {
    historyTitle.textContent = `История версий: ${scope === 'project' ? 'проект' : 'глобальная'}`;
    historyBox.replaceChildren();
    const items = versions[scope] || [];
    if (!items.length) {
      historyBox.append(el('p', { class: 'hint-text', text: 'Версий пока нет: первая появится после сохранения.' }));
      return;
    }
    for (const version of [...items].reverse()) {
      historyBox.append(
        el('div', { class: 'list-item' }, [
          el('div', {}, [
            el('div', { class: 'title', text: `v${version.version}${version.current ? ' · текущая' : ''}` }),
            el('div', {
              class: 'sub',
              text: `${fmtDate(version.at)} · ${version.size} Б · ${version.note || 'без пометки'}`,
            }),
          ]),
          el('div', { class: 'actions' }, [
            el('button', {
              class: 'btn ghost',
              type: 'button',
              text: 'Показать',
              onclick: async () => {
                try {
                  const text = await api.memory.version({ projectDir: state.projectDir, scope, version: version.version });
                  (scope === 'project' ? projectArea : globalArea).value = text;
                  toast(`Версия ${version.version} загружена в поле`, 'ok');
                } catch (err) {
                  toast(`Память: ${err.message}`, 'err');
                }
              },
            }),
            el('button', {
              class: 'btn ghost',
              type: 'button',
              text: 'Откатить',
              onclick: async () => {
                try {
                  await api.memory.restore({ projectDir: state.projectDir, scope, version: version.version });
                  modal.close();
                  toast(`Память откатана к версии ${version.version}`, 'ok');
                  openMemory();
                } catch (err) {
                  toast(`Память: ${err.message}`, 'err');
                }
              },
            }),
          ]),
        ]),
      );
    }
  };

  const modal = openModal({
    title: 'Память (memory.md)',
    body: [
      el('p', {
        class: 'hint-text',
        text: 'Память подмешивается в системный промпт: сначала глобальная, затем проектная. Пишите только подтверждённые уроки.',
      }),
      el('p', { class: 'hint-text', text: data.projectFile }),
      projectArea,
      el('p', { class: 'hint-text', text: data.globalFile }),
      globalArea,
      el('hr', { style: 'border:0;border-top:1px solid var(--border-soft)' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn ghost', type: 'button', text: 'Версии проекта', onclick: () => renderHistory('project') }),
        el('button', { class: 'btn ghost', type: 'button', text: 'Версии глобальной', onclick: () => renderHistory('global') }),
      ]),
      historyTitle,
      historyBox,
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Открыть папку',
        onclick: () => api.showItem(data.projectFile),
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          try {
            const project = await api.memory.save({
              projectDir: state.projectDir,
              scope: 'project',
              content: projectArea.value,
            });
            const globalResult = await api.memory.save({
              projectDir: state.projectDir,
              scope: 'global',
              content: globalArea.value,
            });
            versions.project = project.versions;
            versions.global = globalResult.versions;
            renderHistory('project');
            toast(project.changed || globalResult.changed ? 'Память сохранена' : 'Изменений нет', 'ok');
          } catch (err) {
            toast(`Память: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });

  renderHistory('project');
}

/* ---------- доступ и роли ---------- */

function applyRoleGuard() {
  const admin = !state.auth || state.auth.role === 'admin';
  document.body.classList.toggle('role-guest', !admin);
  for (const panel of ['providers', 'runtimes', 'skills', 'agents', 'memory', 'plugins', 'multica', 'sandbox']) {
    const button = document.querySelector(`[data-panel="${panel}"]`);
    if (!button) continue;
    button.disabled = !admin;
    button.title = admin ? '' : 'Недоступно для роли guest';
  }
  const newProject = $('#new-project-btn');
  if (newProject) {
    newProject.disabled = !admin;
    newProject.title = admin ? 'Создать изолированную песочницу проекта' : 'Создание проектов доступно роли admin';
  }
  const projectButton = $('#project-btn');
  if (projectButton) {
    projectButton.disabled = !admin;
    projectButton.title = admin ? 'Сменить папку проекта' : 'Смена проекта доступна роли admin';
  }
  const authButton = $('#auth-btn');
  if (authButton) {
    const role = state.auth?.role || 'admin';
    authButton.textContent = `Доступ · ${role}`;
  }
}

async function openAuth() {
  const auth = await api.auth.status();
  state.auth = auth;
  applyRoleGuard();

  const issuer = el('input', {
    value: auth.issuer || '',
    placeholder: 'https://keycloak.example.com/realms/mai-code',
  });
  const clientId = el('input', { value: auth.clientId || 'mai-code-desktop' });
  const role = el('select', {}, [
    el('option', { value: 'admin', text: 'admin — полный доступ' }),
    el('option', { value: 'guest', text: 'guest — только чтение и чат' }),
  ]);
  role.value = auth.role || 'admin';
  const status = el('p', {
    class: 'hint-text',
    text: auth.mode === 'keycloak'
      ? `Keycloak: ${auth.user?.name || 'пользователь'}${auth.user?.email ? ` (${auth.user.email})` : ''}`
      : `Локальный режим: ${auth.user?.name || 'администратор'}`,
  });

  const modal = openModal({
    title: 'Доступ и роли',
    body: [
      el('p', {
        class: 'hint-text',
        text: 'Локальные роли разграничивают интерфейс, но не защищают данные от владельца машины. Настоящая граница появляется только при входе через Keycloak и серверном режиме.',
      }),
      status,
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Режим' }),
        el('dd', { text: auth.mode === 'keycloak' ? 'Keycloak (OIDC)' : 'локальный' }),
        el('dt', { text: 'Роль' }),
        el('dd', { text: auth.role }),
        el('dt', { text: 'Шифрование токенов' }),
        el('dd', { text: auth.encryption ? 'доступно (safeStorage)' : 'недоступно' }),
        el('dt', { text: 'Сессия Keycloak' }),
        el('dd', { text: auth.loggedIn ? 'активна' : 'нет' }),
      ]),
      el('div', { class: 'row' }, [field('Issuer Keycloak', issuer), field('Client ID', clientId)]),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Сохранить Keycloak',
          onclick: async () => {
            try {
              state.auth = await api.auth.configure({ issuer: issuer.value.trim(), clientId: clientId.value.trim() });
              status.textContent = 'Настройки Keycloak сохранены. Теперь нажмите «Войти через Keycloak».';
              toast('Keycloak настроен', 'ok');
            } catch (err) {
              toast(`Доступ: ${err.message}`, 'err');
            }
          },
        }),
        el('button', {
          class: 'btn primary',
          type: 'button',
          text: 'Войти через Keycloak',
          onclick: async () => {
            status.textContent = 'Открываю браузер. Подтвердите вход и вернитесь в приложение…';
            const res = await api.auth.login();
            if (!res.ok) {
              status.textContent = `Не удалось войти: ${res.error}`;
              toast(`Keycloak: ${res.error}`, 'err');
              return;
            }
            state.auth = res;
            applyRoleGuard();
            status.textContent = `Вход выполнен: ${res.user?.name || 'пользователь'} · роль ${res.role}`;
            toast(`Вход выполнен, роль ${res.role}`, 'ok');
            modal.close();
            openAuth();
          },
        }),
        el('button', {
          class: 'btn ghost',
          type: 'button',
          text: 'Выйти',
          onclick: async () => {
            state.auth = await api.auth.logout();
            applyRoleGuard();
            modal.close();
            toast('Вы вышли, включён локальный admin', 'ok');
            openAuth();
          },
        }),
      ]),
      el('div', { class: 'row' }, [
        field('Локальная роль', role),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Применить локальную роль',
          onclick: async () => {
            try {
              state.auth = await api.auth.setRole(role.value);
              applyRoleGuard();
              modal.close();
              toast(`Роль: ${state.auth.role}`, 'ok');
              openAuth();
            } catch (err) {
              toast(`Роль: ${err.message}`, 'err');
            }
          },
        }),
      ]),
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Где хранится',
        onclick: () => toast('%APPDATA%\\mai-code\\auth.json'),
      }),
      el('button', { class: 'btn primary', type: 'button', text: 'Закрыть', onclick: () => modal.close() }),
    ],
  });
}

/* ---------- новый проект / песочница ---------- */

async function newProjectModal() {
  let root = '';
  try {
    root = await api.workspace.root();
  } catch {
    root = '';
  }

  const name = el('input', { placeholder: 'например, acme-portal' });
  const description = el('textarea', { rows: '3', placeholder: 'Одно предложение о проекте' });
  const parent = el('input', { value: root });
  const template = el('select', {}, [
    el('option', { value: 'blank', text: 'Пустой проект' }),
    el('option', { value: 'service', text: 'Сервис: Node + тесты + Docker + CI' }),
    el('option', { value: 'agent-app', text: 'Агентское приложение: каркас агента' }),
  ]);
  const repoHost = el('select', {}, [
    el('option', { value: 'none', text: 'Только локальный git' }),
    el('option', { value: 'github', text: 'GitHub (gh CLI)' }),
    el('option', { value: 'gitlab', text: 'GitLab (glab CLI)' }),
    el('option', { value: 'openscion', text: 'OpenScion (сервер SCM)' }),
  ]);
  const visibility = el('select', {}, [
    el('option', { value: 'private', text: 'Приватный' }),
    el('option', { value: 'public', text: 'Публичный' }),
  ]);

  const modal = openModal({
    title: 'Новый проект в песочнице',
    body: [
      el('p', {
        class: 'hint-text',
        text: 'Проект получит отдельную папку, свой .mai-code, memory.md и загрузки. Глобальные навыки и AGENTS.md остаются общими.',
      }),
      el('div', { class: 'row' }, [field('Имя проекта', name), field('Шаблон', template)]),
      field('Описание', description),
      field('Где создать (родительская папка)', parent),
      el('div', { class: 'row' }, [field('Репозиторий', repoHost), field('Доступ', visibility)]),
      el('p', {
        class: 'hint-text',
        text: 'OpenScion — серверная SCM-система, а не git-хостинг. Будет создан локальный git и инструкция по импорту.',
      }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Создать',
        onclick: async () => {
          if (!name.value.trim()) return toast('Нужно имя проекта', 'err');
          try {
            const res = await api.workspace.create({
              name: name.value.trim(),
              description: description.value.trim(),
              parentDir: parent.value.trim() || root,
              template: template.value,
              repoHost: repoHost.value,
              visibility: visibility.value,
            });
            if (!res.ok) return toast(res.error || 'Не удалось создать проект', 'err');
            state.projectDir = res.projectDir;
            state.settings = await api.settings.get();
            updateChrome();
            modal.close();
            toast(`Проект создан: ${res.projectDir}`, 'ok');
            if (res.remote?.instructions || res.remote?.url) {
              openModal({
                title: 'Проект создан',
                body: [
                  el('p', { class: 'hint-text', text: res.projectDir }),
                  res.remote?.url ? el('p', { text: `Remote: ${res.remote.url}` }) : null,
                  res.remote?.instructions
                    ? el('pre', { class: 'hint-text', text: res.remote.instructions })
                    : el('p', { class: 'hint-text', text: 'Локальный git-репозиторий создан.' }),
                  el('p', {
                    class: 'hint-text',
                    text: res.git?.ok ? 'Начальный коммит создан.' : `git: ${res.git?.error || 'не инициализирован'}`,
                  }),
                ].filter(Boolean),
                footer: [
                  el('button', { class: 'btn', type: 'button', text: 'Открыть папку', onclick: () => api.showItem(res.projectDir) }),
                  el('button', { class: 'btn primary', type: 'button', text: 'Готово', onclick: () => document.querySelector('.modal-backdrop')?.remove() }),
                ],
              });
            }
          } catch (err) {
            toast(`Проект: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });
}

/* ---------- навыки ---------- */

async function openSkills() {
  if (!state.projectDir) return toast('Сначала выберите папку проекта', 'err');
  const skills = await api.skills.list(state.projectDir);
  const list = el('div', { class: 'list' });
  if (!skills.length) list.append(el('p', { class: 'hint-text', text: 'Навыков пока нет.' }));
  for (const skill of skills) {
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title', text: skill.name }),
          el('div', { class: 'sub', text: `${skill.description || 'без описания'} · ${skill.scope}` }),
        ]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn ghost', type: 'button', text: 'Файл', onclick: () => api.showItem(skill.file) }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Удалить',
            onclick: async () => {
              await api.skills.remove(skill.file);
              modal.close();
              openSkills();
            },
          }),
        ]),
      ]),
    );
  }

  const name = el('input', { placeholder: 'например, review' });
  const description = el('input', { placeholder: 'когда применять навык' });
  const body = el('textarea', { rows: '6', placeholder: 'Инструкции навыка…' });

  const modal = openModal({
    title: 'Навыки',
    body: [
      list,
      el('hr', { style: 'border:0;border-top:1px solid var(--border-soft)' }),
      el('div', { class: 'row' }, [field('Имя', name), field('Описание', description)]),
      field('Текст навыка', body),
      el('p', { class: 'hint-text', text: 'Файл: <проект>/.mai-code/skills/<имя>/SKILL.md — агент видит список и загружает навык по необходимости.' }),
    ],
    footer: [
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Создать навык',
        onclick: async () => {
          if (!name.value.trim()) return toast('Нужно имя навыка', 'err');
          await api.skills.create({
            projectDir: state.projectDir,
            name: name.value,
            description: description.value,
            body: body.value,
            scope: 'project',
          });
          modal.close();
          openSkills();
        },
      }),
    ],
  });
}

/* ---------- провайдеры ---------- */

function parseModelsText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, context] = line.split('|').map((part) => part.trim());
      return { id, name: name || '', context: context ? Number(context) : null };
    })
    .filter((model) => model.id);
}

function modelsToText(models) {
  return (models || []).map((m) => [m.id, m.name || '', m.context || ''].join(' | ')).join('\n');
}

function providerForm({ id = '', provider = {}, onDone }) {
  const idInput = el('input', { placeholder: 'agentrouter', value: id });
  if (id) idInput.disabled = true;
  const nameInput = el('input', { placeholder: 'AgentRouter', value: provider.name || '' });
  const baseInput = el('input', { placeholder: 'https://agentrouter.org/v1', value: provider.baseURL || '' });
  const keyInput = el('input', {
    type: 'password',
    placeholder: provider.apiKeySet ? `ключ сохранён (${provider.keyHint}…)` : 'sk-…',
  });
  const modelsArea = el('textarea', {
    rows: '4',
    placeholder: 'claude-opus-5-5 | Claude Opus 5.5 | 200000',
  });
  modelsArea.value = modelsToText(provider.models);

  const modal = openModal({
    title: id ? `Провайдер: ${provider.name || id}` : 'Новый провайдер',
    body: [
      el('div', { class: 'row' }, [field('ID', idInput), field('Название', nameInput)]),
      field('Base URL (OpenAI-совместимый)', baseInput),
      field('API-ключ', keyInput),
      field('Модели (если шлюз не отдаёт /models)', modelsArea),
      el('p', { class: 'hint-text', text: 'Формат строки: id | Название | контекст. Пустое поле — список возьмётся из /models.' }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          const result = await api.providers.save(id || idInput.value, {
            name: nameInput.value.trim(),
            baseURL: baseInput.value.trim(),
            apiKey: keyInput.value.trim(),
            models: parseModelsText(modelsArea.value),
          });
          if (!result.ok) return toast(result.error, 'err');
          state.settings = await api.settings.get();
          await loadModels(true);
          renderRuntimes();
          modal.close();
          onDone?.();
          toast('Провайдер сохранён', 'ok');
        },
      }),
    ],
  });
}

async function openProviders() {
  const providers = await api.providers.list();
  const list = el('div', { class: 'list' });
  for (const [id, provider] of Object.entries(providers)) {
    const badge = el('span', {
      class: `badge ${provider.apiKeySet ? 'ok' : 'err'}`,
      text: provider.apiKeySet ? 'ключ есть' : 'нет ключа',
    });
    const live = state.models.filter((m) => m.provider === id).length;
    const status = el('span', { class: 'badge', text: `${live || provider.models?.length || 0} моделей` });
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [provider.name || id, ' ', badge, ' ', status]),
          el('div', { class: 'sub', text: provider.baseURL }),
        ]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Проверить',
            onclick: async () => {
              const res = await api.providers.test(id);
              if (res.ok) toast(`${provider.name || id}: HTTP ${res.status}, моделей ${res.count}`, 'ok');
              else toast(`${provider.name || id}: ${res.error}`, 'err');
            },
          }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Изменить',
            onclick: () => {
              modal.close();
              providerForm({ id, provider, onDone: openProviders });
            },
          }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Удалить',
            onclick: async () => {
              const res = await api.providers.remove(id);
              if (!res.ok) return toast(res.error, 'err');
              state.settings = await api.settings.get();
              await loadModels(true);
              modal.close();
              openProviders();
            },
          }),
        ]),
      ]),
    );
  }

  const modal = openModal({
    title: 'Провайдеры',
    body: [
      list,
      el('p', {
        class: 'hint-text',
        text: 'Любой OpenAI-совместимый шлюз: MAI, AgentRouter, OpenAI, DeepSeek. Anthropic подключается через совместимый режим.',
      }),
    ],
    footer: [
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Добавить провайдера',
        onclick: () => {
          modal.close();
          providerForm({ onDone: openProviders });
        },
      }),
    ],
  });
}

/* ---------- рантаймы ---------- */

function runtimeForm({ id, runtime = {}, onDone }) {
  const idInput = el('input', { placeholder: 'opencode', value: id || '' });
  if (id) idInput.disabled = true;
  const nameInput = el('input', { placeholder: 'OpenCode', value: runtime.name || '' });
  const commandInput = el('input', { placeholder: 'opencode', value: runtime.command || '' });
  const argsArea = el('textarea', {
    rows: '5',
    placeholder: 'run\n--format\njson\n{prompt}',
  });
  argsArea.value = (runtime.args || []).join('\n');
  const targetInput = el('input', { placeholder: 'имя агента в herdr (для {target})', value: runtime.target || '' });
  const parserSelect = el('select', {}, [
    el('option', { value: '', text: 'Обычный текст' }),
    el('option', { value: 'opencode-json', text: 'OpenCode JSON-события' }),
  ]);
  parserSelect.value = runtime.parser || '';
  const modeSelect = el('select', {}, [
    el('option', { value: 'host', text: 'host — CLI на этой машине' }),
    el('option', { value: 'docker', text: 'docker — отдельный контейнер' }),
  ]);
  modeSelect.value = runtime.mode || 'host';
  const imageInput = el('input', { placeholder: 'например, ghcr.io/org/agent:latest', value: runtime.image || '' });
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = runtime.enabled !== false;

  const modal = openModal({
    title: id ? `Рантайм: ${runtime.name || id}` : 'Новый рантайм',
    body: [
      el('div', { class: 'row' }, [field('ID', idInput), field('Название', nameInput)]),
      field('Команда', commandInput),
      field('Аргументы (по одному в строке)', argsArea),
      el('div', { class: 'row' }, [field('Цель {target} (herdr)', targetInput), field('Формат вывода', parserSelect)]),
      el('div', { class: 'row' }, [field('Режим запуска', modeSelect), field('Docker-образ', imageInput)]),
      el('label', { class: 'hint-text' }, [enabled, ' включить рантайм (показывать в списке и разрешать запуск)']),
      el('p', {
        class: 'hint-text',
        text: 'Подстановки: {prompt}, {model}, {projectDir}, {target}. Если {prompt} не указан, запрос добавится последним аргументом.',
      }),
      el('p', {
        class: 'hint-text',
        text: 'Docker-режим: папка проекта монтируется в /workspace, сеть bridge, память 2g, CPU 2, cap-drop ALL. Образ должен содержать CLI рантайма.',
      }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          const nextId = (id || idInput.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
          if (!nextId) return toast('Нужен ID рантайма', 'err');
          const next = {
            ...state.runtimes,
            [nextId]: {
              ...runtime,
              name: nameInput.value.trim() || nextId,
              command: commandInput.value.trim(),
              args: argsArea.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
              target: targetInput.value.trim(),
              parser: parserSelect.value,
              mode: modeSelect.value,
              image: imageInput.value.trim(),
              enabled: enabled.checked,
            },
          };
          state.runtimes = await api.runtimes.save(next);
          state.settings = await api.settings.get();
          renderRuntimes();
          modal.close();
          onDone?.();
          toast('Рантайм сохранён', 'ok');
        },
      }),
    ],
  });
}

async function openRuntimes() {
  state.runtimes = await api.runtimes.list();
  const probes = await api.runtimes.probe();
  const list = el('div', { class: 'list' });
  const entries = Object.entries(state.runtimes);
  if (!entries.length) list.append(el('p', { class: 'hint-text', text: 'Рантаймов нет.' }));
  for (const [id, runtime] of entries) {
    const enabled = runtime.enabled !== false;
    const probe = probes[id] || {};
    const badge = el('span', {
      class: `badge ${enabled ? 'ok' : ''}`,
      text: enabled ? 'включён' : 'выключен',
    });
    const availability = el('span', {
      class: `badge ${probe.available ? 'ok' : 'err'}`,
      text: runtime.mode === 'docker'
        ? (probe.available ? 'образ есть' : 'образа нет')
        : (probe.available ? 'CLI найден' : 'CLI не найден'),
    });
    const sub = el('div', { class: 'sub' }, [
      `${runtime.command || 'команда не задана'}${runtime.mode === 'docker' ? ` · docker ${runtime.image || ''}` : ''}`,
      probe.error ? ` · ${probe.error}` : '',
    ]);
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [runtime.name || id, ' ', badge, ' ', availability]),
          sub,
          runtime.note ? el('div', { class: 'sub', text: runtime.note }) : null,
        ]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: enabled ? 'Выключить' : 'Включить',
            onclick: async () => {
              const next = {
                ...state.runtimes,
                [id]: { ...runtime, enabled: !enabled },
              };
              state.runtimes = await api.runtimes.save(next);
              state.settings = await api.settings.get();
              renderRuntimes();
              modal.close();
              openRuntimes();
            },
          }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Изменить',
            onclick: () => {
              modal.close();
              runtimeForm({ id, runtime, onDone: openRuntimes });
            },
          }),
        ]),
      ]),
    );
  }

  const modal = openModal({
    title: 'Рантаймы',
    body: [
      list,
      el('p', {
        class: 'hint-text',
        text: '«Включить» добавляет рантайм в список рядом с моделью. Можно включить несколько: тогда в списке появится «Все включённые» и запрос уйдёт им параллельно. Без этого одновременно выполняется только один рантайм.',
      }),
      el('p', {
        class: 'hint-text',
        text: 'Режим host запускает CLI на этой машине. Режим docker запускает образ с папкой проекта в /workspace (нужен Docker).',
      }),
    ],
    footer: [
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Добавить рантайм',
        onclick: () => {
          modal.close();
          runtimeForm({ onDone: openRuntimes });
        },
      }),
    ],
  });
}

/* ---------- встроенная документация (GitBook) ---------- */

function slugHeading(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function openDocs(start = 'README.md') {
  const listing = await api.docs.list();
  if (!listing.files.length) return toast('Документация не найдена', 'err');

  const sidebar = el('nav', { class: 'docs-sidebar' });
  const content = el('article', { class: 'docs-content md' });
  const toc = el('aside', { class: 'docs-toc' });
  const search = el('input', {
    class: 'docs-search',
    type: 'search',
    placeholder: 'Поиск по документации…',
  });
  let current = listing.files.some((f) => f.path === start) ? start : listing.files[0].path;

  const renderSidebar = (items, active) => {
    sidebar.replaceChildren();
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.section)) groups.set(item.section, []);
      groups.get(item.section).push(item);
    }
    for (const [section, docs] of groups) {
      sidebar.append(el('div', { class: 'docs-group-title', text: section }));
      for (const doc of docs) {
        sidebar.append(
          el('button', {
            class: `docs-link${doc.path === active ? ' active' : ''}`,
            type: 'button',
            title: doc.path,
            text: doc.title,
            onclick: () => load(doc.path),
          }),
        );
      }
    }
  };

  const renderToc = () => {
    toc.replaceChildren(el('div', { class: 'docs-group-title', text: 'На этой странице' }));
    const headings = [...content.querySelectorAll('h1, h2, h3')];
    if (!headings.length) {
      toc.append(el('p', { class: 'hint-text', text: 'Нет заголовков' }));
      return;
    }
    for (const heading of headings) {
      const id = heading.id || slugHeading(heading.textContent);
      heading.id = id;
      toc.append(
        el('a', {
          class: `docs-toc-link level-${heading.tagName.slice(1)}`,
          href: `#${id}`,
          text: heading.textContent,
          onclick: (event) => {
            event.preventDefault();
            heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        }),
      );
    }
  };

  const load = async (relative) => {
    current = relative;
    try {
      const doc = await api.docs.read(relative);
      content.innerHTML = renderMarkdown(doc.content);
      for (const heading of content.querySelectorAll('h1, h2, h3, h4')) {
        heading.id = slugHeading(heading.textContent);
      }
      for (const button of content.querySelectorAll('.copy-code')) {
        button.addEventListener('click', () => {
          const code = button.closest('pre')?.querySelector('code')?.textContent || '';
          api.clipboard.writeText(code);
          button.textContent = 'Скопировано';
          setTimeout(() => (button.textContent = 'Копировать'), 1200);
        });
      }
      renderSidebar(listing.files, current);
      renderToc();
      content.scrollTop = 0;
      search.value = '';
    } catch (err) {
      toast(`Документ: ${err.message}`, 'err');
    }
  };

  let searchSeq = 0;
  search.addEventListener('input', async () => {
    const query = search.value.trim();
    if (query.length < 2) {
      renderSidebar(listing.files, current);
      return;
    }
    const seq = ++searchSeq;
    const results = await api.docs.search(query);
    if (seq !== searchSeq) return;
    sidebar.replaceChildren(el('div', { class: 'docs-group-title', text: `Найдено: ${results.length}` }));
    if (!results.length) {
      sidebar.append(el('p', { class: 'hint-text', text: 'Ничего не найдено' }));
      return;
    }
    for (const result of results) {
      sidebar.append(
        el('button', {
          class: 'docs-link',
          type: 'button',
          title: `${result.path}:${result.line}`,
          onclick: async () => {
            await load(result.path);
            toast(`${result.path}, строка ${result.line}`, 'ok');
          },
        }, [
          el('span', { class: 'docs-result-title', text: result.title }),
          el('span', { class: 'docs-result-snippet', text: result.snippet }),
        ]),
      );
    }
  });

  const modal = openModal({
    title: 'Документация MAI Code',
    wide: true,
    body: [
      el('div', { class: 'docs-toolbar' }, [
        search,
        el('button', {
          class: 'btn ghost small',
          type: 'button',
          text: 'Открыть папку',
          onclick: () => api.openPath(listing.root),
        }),
      ]),
      el('div', { class: 'docs-shell' }, [sidebar, content, toc]),
    ],
    footer: [
      el('button', {
        class: 'btn ghost',
        type: 'button',
        text: 'Multica: синхронизировать задачи',
        onclick: async () => {
          try {
            const res = await api.multica.syncDocs();
            toast(`Multica: создано ${res.created}, обновлено ${res.updated}, пропущено ${res.skipped}`, 'ok');
          } catch (err) {
            toast(`Multica: ${err.message}`, 'err');
          }
        },
      }),
      el('button', { class: 'btn primary', type: 'button', text: 'Закрыть', onclick: () => modal.close() }),
    ],
  });
  await load(current);
}

/* ---------- MCP ---------- */

async function openMcp() {
  const status = await api.mcp.status();
  const servers = (await api.mcp.configs(state.projectDir)) || {};
  const list = el('div', { class: 'list' });
  const names = new Set([...Object.keys(servers), ...status.map((s) => s.name)]);
  if (!names.size) list.append(el('p', { class: 'hint-text', text: 'MCP-серверы не настроены.' }));
  for (const name of names) {
    const info = status.find((s) => s.name === name);
    const badge = el('span', {
      class: `badge ${info?.status === 'ready' ? 'ok' : info?.status === 'error' ? 'err' : ''}`,
      text: info?.status || (servers[name]?.disabled ? 'выключен' : 'не подключён'),
    });
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [name, ' ', badge]),
          el('div', {
            class: 'sub',
            text: info?.tools?.length ? `инструменты: ${info.tools.join(', ')}` : servers[name]?.url || servers[name]?.command || '',
          }),
        ]),
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Подключить',
            onclick: async () => {
              const res = await api.mcp.connect(name, state.projectDir);
              if (!res.ok) toast(res.error, 'err');
              else toast(`Подключено: ${name}`, 'ok');
              modal.close();
              openMcp();
            },
          }),
          el('button', {
            class: 'btn ghost',
            type: 'button',
            text: 'Удалить',
            onclick: async () => {
              await api.mcp.remove(name);
              state.settings = await api.settings.get();
              modal.close();
              openMcp();
            },
          }),
        ]),
      ]),
    );
  }

  const name = el('input', { placeholder: 'filesystem' });
  const command = el('input', { placeholder: 'npx' });
  const args = el('input', { placeholder: '-y @modelcontextprotocol/server-filesystem C:\\project' });
  const url = el('input', { placeholder: 'https://… (для HTTP-сервера)' });

  const modal = openModal({
    title: 'MCP-серверы',
    body: [
      list,
      el('hr', { style: 'border:0;border-top:1px solid var(--border-soft)' }),
      el('div', { class: 'row' }, [field('Имя', name), field('Команда', command)]),
      field('Аргументы (через пробел)', args),
      field('или URL', url),
      el('p', { class: 'hint-text', text: 'Локальный сервер: команда + аргументы. Удалённый: URL (streamable HTTP).' }),
    ],
    footer: [
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Добавить',
        onclick: async () => {
          if (!name.value.trim()) return toast('Нужно имя сервера', 'err');
          const config = url.value.trim()
            ? { url: url.value.trim() }
            : { command: command.value.trim(), args: args.value.trim().split(/\s+/).filter(Boolean) };
          if (!config.url && !config.command) return toast('Нужна команда или URL', 'err');
          const serversNext = { ...(state.settings.mcpServers || {}), [name.value.trim()]: config };
          state.settings = await api.settings.save({ mcpServers: serversNext });
          await api.mcp.sync(state.projectDir);
          modal.close();
          openMcp();
        },
      }),
    ],
  });
}

/* ---------- плагины ---------- */

async function openPlugins() {
  if (!state.projectDir) return toast('Сначала выберите папку проекта', 'err');
  const { plugins, dirs } = await api.plugins.list(state.projectDir);
  const list = el('div', { class: 'list' });
  if (!plugins.length) list.append(el('p', { class: 'hint-text', text: 'Плагинов пока нет.' }));
  for (const plugin of plugins) {
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title', text: plugin.name }),
          el('div', { class: 'sub', text: plugin.error ? plugin.error : `инструментов: ${plugin.tools}` }),
        ]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn ghost', type: 'button', text: 'Файл', onclick: () => api.showItem(plugin.file) }),
        ]),
      ]),
    );
  }

  const modal = openModal({
    title: 'Плагины',
    body: [
      list,
      el('p', { class: 'hint-text', text: dirs[0] }),
      el('p', { class: 'hint-text', text: 'Плагин — это .js-модуль: export default { name, tools: [{ schema, run }] }.' }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Открыть папку', onclick: () => api.plugins.openFolder(state.projectDir) }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Создать пример',
        onclick: async () => {
          await api.plugins.createExample(state.projectDir);
          modal.close();
          openPlugins();
        },
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Обновить',
        onclick: () => {
          modal.close();
          openPlugins();
        },
      }),
    ],
  });
}

/* ---------- Multica ---------- */

async function openMultica() {
  const status = await api.multica.status();
  const issues = await api.multica.issues(20);
  const config = status.config || {};
  const serverUrl = el('input', { value: config.url || 'http://localhost:8080' });
  const appUrl = el('input', { value: config.appUrl || 'http://localhost:3000' });
  const workspaceId = el('input', { value: config.workspaceId || '', placeholder: 'workspace id или slug (необязательно)' });
  const command = el('input', { value: config.command || 'multica' });

  const badge = el('span', {
    class: `badge ${status.available ? 'ok' : 'err'}`,
    text: status.available ? `CLI ${status.version || 'найден'}` : 'CLI не найден',
  });
  const list = el('div', { class: 'list' });
  if (!issues.ok) {
    list.append(el('p', { class: 'hint-text', text: `Задачи: ${issues.error}` }));
  } else if (!issues.issues.length) {
    list.append(el('p', { class: 'hint-text', text: 'Задач нет или CLI не авторизован.' }));
  } else {
    for (const issue of issues.issues) {
      list.append(
        el('div', { class: 'list-item' }, [
          el('div', {}, [
            el('div', { class: 'title', text: `${issue.key ? `${issue.key} · ` : ''}${issue.title}` }),
            el('div', { class: 'sub', text: `${issue.status || 'без статуса'}${issue.priority ? ` · ${issue.priority}` : ''}` }),
          ]),
        ]),
      );
    }
  }

  const modal = openModal({
    title: 'Multica — задачи из OpenSpec',
    body: [
      el('div', { class: 'row' }, [field('CLI', command), field('API', serverUrl)]),
      el('div', { class: 'row' }, [field('Web UI', appUrl), field('Workspace', workspaceId)]),
      el('p', { class: 'hint-text' }, [badge, ' Синхронизация идёт через официальный CLI: multica issue create/update/list.']),
      status.available
        ? null
        : el('p', { class: 'hint-text', text: status.hint || status.error || 'CLI не найден в PATH.' }),
      el('p', {
        class: 'hint-text',
        text: 'Идемпотентность: в описание задачи пишется маркер OpenSpec. Повторный sync обновляет задачу, а не создаёт дубль.',
      }),
      el('div', { class: 'docs-group-title', text: 'Последние задачи' }),
      list,
    ],
    footer: [
      status.available
        ? null
        : el('button', {
            class: 'btn',
            type: 'button',
            text: 'Установить CLI',
            onclick: async () => {
              toast('Устанавливаю Multica CLI через официальный скрипт…', 'ok');
              const res = await api.multica.install();
              if (!res.ok) return toast(`Multica: ${res.error}`, 'err');
              modal.close();
              toast(res.note || 'CLI установлен', 'ok');
              openMultica();
            },
          }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Проверить вход',
        onclick: async () => {
          const res = await api.multica.auth();
          toast(res.ok ? res.output : `Multica: ${res.error}`, res.ok ? 'ok' : 'err');
        },
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Открыть Web UI',
        onclick: () => api.openExternal(appUrl.value || 'http://localhost:3000'),
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          state.settings = await api.settings.save({
            multica: {
              url: serverUrl.value.trim(),
              appUrl: appUrl.value.trim(),
              workspaceId: workspaceId.value.trim(),
              command: command.value.trim() || 'multica',
            },
          });
          toast('Настройки Multica сохранены', 'ok');
        },
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Синхронизировать OpenSpec',
        onclick: async () => {
          try {
            const res = await api.multica.syncDocs(state.projectDir);
            modal.close();
            toast(res.message || `Создано ${res.created}, обновлено ${res.updated}`, 'ok');
          } catch (err) {
            toast(`Multica: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });
}

/* ---------- Docker-песочницы ---------- */

async function openSandboxes() {
  const status = await api.sandbox.status();
  const listing = await api.sandbox.list();
  const image = el('input', { value: 'node:22-alpine' });
  const ports = el('input', { placeholder: '3000:3000, 127.0.0.1:8080:8080' });
  const network = el('select', {}, [
    el('option', { value: 'bridge', text: 'bridge — сеть с доступом наружу' }),
    el('option', { value: 'none', text: 'none — без сети' }),
  ]);
  const memory = el('input', { value: '2g' });
  const cpus = el('input', { value: '2' });
  const command = el('input', { placeholder: 'необязательно: npm run dev' });

  const list = el('div', { class: 'list' });
  if (!status.available) {
    list.append(el('p', { class: 'hint-text', text: `Docker недоступен: ${status.error || 'не запущен'}` }));
  } else if (!listing.containers.length) {
    list.append(el('p', { class: 'hint-text', text: 'Контейнеров пока нет.' }));
  } else {
    for (const item of listing.containers) {
      list.append(
        el('div', { class: 'list-item' }, [
          el('div', {}, [
            el('div', { class: 'title' }, [item.name, ' ', el('span', { class: `badge ${item.running ? 'ok' : ''}`, text: item.state })]),
            el('div', {
              class: 'sub',
              text: `${item.image}${item.ports.length ? ` · ${item.ports.join(', ')}` : ''}${item.project ? ` · ${item.project}` : ''}`,
            }),
          ]),
          el('div', { class: 'actions' }, [
            el('button', {
              class: 'btn ghost',
              type: 'button',
              text: 'Логи',
              onclick: async () => {
                try {
                  const res = await api.sandbox.logs({ name: item.name, lines: 200 });
                  openModal({
                    title: `Логи: ${item.name}`,
                    body: [el('pre', { class: 'terminal', text: res.output || '(пусто)' })],
                    footer: [el('button', { class: 'btn', type: 'button', text: 'Закрыть', onclick: () => document.querySelector('.modal-backdrop')?.remove() })],
                  });
                } catch (err) {
                  toast(`Логи: ${err.message}`, 'err');
                }
              },
            }),
            el('button', {
              class: 'btn ghost',
              type: 'button',
              text: 'Остановить',
              onclick: async () => {
                try {
                  await api.sandbox.stop({ name: item.name });
                  modal.close();
                  openSandboxes();
                } catch (err) {
                  toast(`Остановка: ${err.message}`, 'err');
                }
              },
            }),
          ]),
        ]),
      );
    }
  }

  const modal = openModal({
    title: 'Docker-песочницы',
    body: [
      el('p', {
        class: 'hint-text',
        text: 'Контейнер изолирует процессы и сеть. Папка проекта монтируется в /workspace. Порты публикуются только явно, по умолчанию на 127.0.0.1.',
      }),
      el('div', { class: 'row' }, [field('Образ', image), field('Порты', ports)]),
      el('div', { class: 'row' }, [field('Сеть', network), field('Память', memory), field('CPU', cpus)]),
      field('Команда запуска', command),
      el('p', { class: 'hint-text', text: status.available ? `Docker ${status.version}` : `Docker: ${status.error || 'недоступен'}` }),
      el('div', { class: 'docs-group-title', text: 'Контейнеры MAI Code' }),
      list,
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Обновить',
        onclick: () => {
          modal.close();
          openSandboxes();
        },
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Запустить',
        onclick: async () => {
          if (!state.projectDir) return toast('Сначала выберите папку проекта', 'err');
          try {
            const res = await api.sandbox.start({
              projectDir: state.projectDir,
              image: image.value.trim(),
              ports: ports.value.trim(),
              network: network.value,
              memory: memory.value.trim() || '2g',
              cpus: cpus.value.trim() || '2',
              command: command.value.trim(),
            });
            modal.close();
            toast(`Контейнер ${res.name} запущен${res.ports.length ? `: ${res.ports.join(', ')}` : ''}`, 'ok');
          } catch (err) {
            toast(`Песочница: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });
}

/* ---------- проект ---------- */

async function pickProject() {
  const dir = await api.project.pick();
  if (!dir) return;
  state.projectDir = dir;
  updateChrome();
  // Решение о доверии — сразу при выборе папки, как в Claude Code (ADR 0028).
  const trust = await refreshTrust();
  if (trust?.state === 'unknown') await decideTrust(trust);
}

/* ---------- голосовой ввод через MAS ---------- */

const voice = {
  recording: false,
  busy: false,
  context: null,
  stream: null,
  source: null,
  processor: null,
  sink: null,
  chunks: [],
  startedAt: 0,
  ticker: null,
};

function setMicState(kind) {
  const button = $('#mic');
  if (!button) return;
  button.classList.toggle('recording', kind === 'recording');
  button.classList.toggle('busy', kind === 'busy');
  button.disabled = kind === 'busy';
  button.setAttribute('aria-pressed', kind === 'recording' ? 'true' : 'false');
  button.title =
    kind === 'recording'
      ? 'Идёт запись: нажмите, чтобы распознать'
      : 'Голосовой ввод (MAS): нажмите, продиктуйте задачу, нажмите ещё раз';
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Собирает WAV из кусков float32. Частота — какую дал AudioContext. */
function encodeWav(chunks, sampleRate) {
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const value = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** Вставляет текст в позицию курсора и не съедает уже набранное. */
function insertIntoInput(text) {
  const input = $('#input');
  const clean = String(text || '').trim();
  if (!clean) return false;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const glue = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^\s/.test(after) ? ' ' : '';
  input.value = `${before}${glue}${clean}${tail}${after}`;
  const caret = (before + glue + clean).length;
  input.setSelectionRange(caret, caret);
  input.focus();
  autosize();
  return true;
}

async function startVoice() {
  if (voice.recording || voice.busy) return;

  const status = await api.mas.status().catch((error) => ({ ok: false, error: error?.message || String(error) }));
  if (!status.ok) {
    toast(status.error || 'MAS недоступен', 'error');
    return;
  }

  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    toast(`Нет доступа к микрофону: ${error?.message || error}`, 'error');
    return;
  }

  try {
    voice.context = new AudioContext();
    voice.source = voice.context.createMediaStreamSource(voice.stream);
    voice.processor = voice.context.createScriptProcessor(4096, 1, 1);
    // Тишина в выход: иначе микрофон слышно в колонках.
    voice.sink = voice.context.createGain();
    voice.sink.gain.value = 0;
    voice.chunks = [];
    voice.processor.onaudioprocess = (event) => {
      voice.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    voice.source.connect(voice.processor);
    voice.processor.connect(voice.sink);
    voice.sink.connect(voice.context.destination);
  } catch (error) {
    stopTracks();
    toast(`Не удалось начать запись: ${error?.message || error}`, 'error');
    return;
  }

  voice.recording = true;
  voice.startedAt = Date.now();
  setMicState('recording');
  voice.ticker = setInterval(() => {
    const seconds = ((Date.now() - voice.startedAt) / 1000).toFixed(0);
    $('#mic').title = `Идёт запись ${seconds} с: нажмите, чтобы распознать`;
  }, 1000);
}

function stopTracks() {
  try {
    voice.processor?.disconnect();
    voice.source?.disconnect();
    voice.sink?.disconnect();
  } catch {
    /* уже отключено */
  }
  try {
    voice.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    /* уже остановлено */
  }
  try {
    voice.context?.close();
  } catch {
    /* уже закрыт */
  }
  if (voice.ticker) clearInterval(voice.ticker);
  voice.ticker = null;
  voice.processor = null;
  voice.source = null;
  voice.sink = null;
  voice.stream = null;
  voice.context = null;
}

async function stopVoice() {
  if (!voice.recording) return;
  voice.recording = false;
  const sampleRate = voice.context?.sampleRate || 48000;
  const chunks = voice.chunks;
  const seconds = (Date.now() - voice.startedAt) / 1000;
  stopTracks();
  voice.chunks = [];

  if (seconds < 0.6) {
    setMicState('');
    toast('Слишком короткая запись: удерживайте кнопку и говорите дольше', 'error');
    return;
  }

  setMicState('busy');
  try {
    const wav = encodeWav(chunks, sampleRate);
    const result = await api.mas.transcribe({ wav });
    if (!result.text) {
      toast('MAS не разобрал речь: попробуйте ближе к микрофону', 'error');
      return;
    }
    insertIntoInput(result.text);
    toast(`Распознано за ${(result.elapsedMs / 1000).toFixed(1)} с`, 'ok');
  } catch (error) {
    toast(error?.message || String(error), 'error');
  } finally {
    setMicState('');
  }
}

function toggleVoice() {
  if (voice.busy) return;
  if (voice.recording) {
    stopVoice();
  } else {
    startVoice();
  }
}

/* ---------- ввод ---------- */

function autosize() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

/* ---------- запуск ---------- */

async function init() {
  state.settings = await api.settings.get();
  state.projectDir = state.settings.projectDir || '';
  state.model = state.settings.activeModel || '';
  state.runtimes = await api.runtimes.list();
  try {
    const modes = await api.permissions.modes();
    state.permissionMode = modes.current;
    state.permissionModes = modes.modes;
  } catch {
    state.permissionMode = 'manual';
    state.permissionModes = MODE_FALLBACK;
  }
  try {
    state.auth = await api.auth.status();
  } catch {
    state.auth = null;
  }
  updateChrome();
  applyRoleGuard();
  renderModels();
  renderRuntimes();
  renderModeSelect();
  await refreshTrust();
  await loadModels();
  await refreshSessions();
  renderAll();

  api.chat.onEvent(handleEvent);

  $('#new-chat').addEventListener('click', newChat);

// Экспорт всего диалога: меню форматов открывается по клику.
$('#export-chat').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const messages = state.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (!messages.length) {
    toast('В диалоге пока нет сообщений');
    return;
  }
  const format = await pickExportFormat(button);
  if (!format) return;
  button.disabled = true;
  const result = await api.export.chat({ messages, format, title: 'Диалог MAI Code' });
  button.disabled = false;
  if (result?.ok) toast(`Сохранено: ${result.file}`);
  else if (result?.error) toast(result.error);
});
  $('#project-btn').addEventListener('click', pickProject);
  $('#new-project-btn').addEventListener('click', newProjectModal);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#mode-select').addEventListener('change', (event) => setPermissionMode(event.target.value));
  $('#send').addEventListener('click', send);
  $('#mic').addEventListener('click', toggleVoice);
  $('#stop').addEventListener('click', stopRun);

  $('#model-select').addEventListener('change', async (event) => {
    state.model = event.target.value;
    state.settings = await api.settings.save({ activeModel: state.model });
    updateChrome();
  });

  $('#runtime-select').addEventListener('change', (event) => {
    state.runtime = event.target.value;
  });

  for (const button of document.querySelectorAll('[data-panel]')) {
    button.addEventListener('click', () => {
      const panel = button.dataset.panel;
      if (panel === 'boards') api.boards.open('delivery', '');
      if (panel === 'storage') api.boards.open('storage', '');
      if (panel === 'agents') openAgents();
      if (panel === 'memory') openMemory();
      if (panel === 'skills') openSkills();
      if (panel === 'providers') openProviders();
      if (panel === 'runtimes') openRuntimes();
      if (panel === 'mcp') openMcp();
      if (panel === 'plugins') openPlugins();
      if (panel === 'docs') openDocs();
      if (panel === 'multica') openMultica();
      if (panel === 'sandbox') openSandboxes();
      if (panel === 'auth') openAuth();
    });
  }

  const input = $('#input');
  input.addEventListener('input', autosize);
  // Подсказки раньше Enter → отправить: стрелки, Tab и Enter выбирают из списка.
  input.addEventListener('keydown', onSuggestKey);
  input.addEventListener('input', updateSuggest);
  input.addEventListener('blur', () => setTimeout(closeSuggest, 150));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  $('#attach').addEventListener('click', () => pickAttachments());
  const composer = $('#composer');
  composer.addEventListener('dragover', (event) => {
    event.preventDefault();
    composer.classList.add('dragover');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragover'));
  composer.addEventListener('drop', async (event) => {
    event.preventDefault();
    composer.classList.remove('dragover');
    // Electron отдаёт настоящие пути файлов: так работает любой размер и архив.
    const paths = Array.from(event.dataTransfer?.files || [])
      .map((file) => api.pathForFile?.(file) || '')
      .filter(Boolean);
    if (paths.length) await addPaths(paths);
    else await addBlobs(event.dataTransfer?.files);
  });
  $('#input').addEventListener('paste', async (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const images = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    await addBlobs(images.map((item) => item.getAsFile()).filter(Boolean));
  });
  renderAttachments();

  $('#messages').addEventListener('click', (event) => {
    const copy = event.target.closest('.copy-code');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code')?.textContent || '';
      const write = api.clipboard?.writeText
        ? Promise.resolve(api.clipboard.writeText(code))
        : navigator.clipboard.writeText(code);
      write.then(() => {
        copy.textContent = 'Скопировано';
        setTimeout(() => (copy.textContent = 'Копировать'), 1500);
      });
      return;
    }
    const link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      api.openExternal(link.getAttribute('href'));
    }
  });

  input.focus();
}

init();
