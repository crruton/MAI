const $ = (selector, root = document) => root.querySelector(selector);
const api = window.mai;

const params = new URLSearchParams(location.search);
const BOARD = params.get('board') || 'delivery';

const TITLES = {
  delivery: 'Доставка',
  architecture: 'Архитектура',
  runners: 'Рантаймы и деплой',
  quality: 'Качество и самокоррекция',
  storage: 'Хранилище и инфраструктура',
};

const VIEW_ORDER = ['c1', 'c2', 'c3', 'c4', 'sequence', 'er', 'deployment', 'openapi'];
const VIEW_NAMES = {
  c1: 'C1 · Контекст',
  c2: 'C2 · Контейнеры',
  c3: 'C3 · Компоненты',
  c4: 'C4 · Код',
  sequence: 'Sequence',
  er: 'ER-диаграмма',
  deployment: 'Deployment + sizing',
  openapi: 'OpenAPI',
};

const KINDS = [
  ['skill', 'Навык'],
  ['agents', 'AGENTS.md'],
  ['openspec', 'OpenSpec'],
  ['adr', 'ADR'],
  ['diagram', 'Диаграмма'],
  ['openapi', 'OpenAPI'],
  ['note', 'Заметка'],
  ['plugin', 'Плагин'],
];

const state = {
  projectDir: '',
  settings: null,
  boards: null,
  approvalOpen: false,
  viewsData: null,
  loadingViews: false,
  archTab: 'diagrams',
  openView: 'c1',
  showSource: false,
  storageTab: 'artifacts',
  artifacts: [],
  artifactStats: null,
  artifactKind: '',
  artifactQuery: '',
  artifact: null,
  artifactHistory: [],
  selectedIssues: new Set(),
  correctionLive: null,
  errors: null,
  git: null,
  runtimeStatus: null,
  openStage: 'build',
  stageLogs: {},
  runningStage: '',
  infraStatus: null,
  infraResult: null,
  repowiseStatus: null,
  repowiseOutput: '',
  remoteResults: null,
  diagramChat: {},
  diagramBusy: false,
};

/* ---------- helpers ---------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = '') {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 4200);
}

function fmtDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function basename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || value || '';
}

function shortId(id) {
  const text = String(id || '');
  return text.length > 34 ? `${text.slice(0, 31)}…` : text;
}

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function statusBadge(status) {
  const map = {
    idle: ['', 'ожидает'],
    running: ['blue', 'выполняется'],
    ok: ['green', 'успех'],
    error: ['red', 'ошибка'],
    stopped: ['amber', 'остановлено'],
    done: ['green', 'готово'],
    open: ['red', 'открыта'],
    ignored: ['', 'игнорируется'],
    accepted: ['green', 'принято'],
    proposed: ['blue', 'предложено'],
    rejected: ['red', 'отклонено'],
    superseded: ['amber', 'заменено'],
  };
  const [kind, label] = map[status] || ['', status || '—'];
  return `<span class="badge ${kind}">${esc(label)}</span>`;
}

function priorityBadge(priority) {
  const map = {
    low: ['', 'низкий'],
    normal: ['blue', 'обычный'],
    high: ['amber', 'высокий'],
    critical: ['red', 'критичный'],
  };
  const [kind, label] = map[priority] || ['', priority || 'обычный'];
  return `<span class="badge ${kind}">${esc(label)}</span>`;
}

function openModal({ title, body = [], footer = [], size = '', onClose }) {
  const root = $('#modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: `modal ${size}` });
  const close = () => {
    backdrop.remove();
    onClose?.();
  };
  box.append(
    el('div', { class: 'modal-head' }, [
      el('h3', { text: title }),
      el('button', { class: 'modal-close', type: 'button', text: '×', onclick: close }),
    ]),
    el('div', { class: 'modal-body' }, body),
  );
  if (footer.length) box.append(el('div', { class: 'modal-foot' }, footer));
  backdrop.append(box);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  root.append(backdrop);
  return { close, body: box.querySelector('.modal-body') };
}

function field(labelText, input) {
  return el('div', { class: 'field' }, [el('label', { text: labelText }), input]);
}

function diffHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  return lines
    .map((line) => {
      let kind = 'same';
      if (line.startsWith('+') && !line.startsWith('+++')) kind = 'add';
      else if (line.startsWith('-') && !line.startsWith('---')) kind = 'del';
      return `<span class="diff-line ${kind}">${esc(line) || ' '}</span>`;
    })
    .join('\n');
}

function linesHtml(lines) {
  return (lines || [])
    .map((line) => {
      const prefix = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ';
      return `<span class="diff-line ${esc(line.type)}">${esc(prefix + line.text)}</span>`;
    })
    .join('\n');
}

async function copyText(text) {
  try {
    if (api.clipboard?.writeText) {
      api.clipboard.writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    toast('Скопировано', 'ok');
  } catch {
    toast('Не удалось скопировать', 'err');
  }
}

/* ---------- загрузка ---------- */

async function boot() {
  bindChrome();
  const settings = await api.settings.get();
  state.settings = settings;
  state.projectDir = settings.projectDir || '';
  updateChrome();
  if (!state.projectDir) {
    renderNoProject();
    return;
  }
  await loadAll();
}

async function loadAll() {
  try {
    const res = await api.boards.load({ projectDir: state.projectDir });
    state.boards = res.boards;
    state.settings = res.settings;
    if (res.projectDir) state.projectDir = res.projectDir;
  } catch (err) {
    toast(`Не удалось загрузить доски: ${err.message}`, 'err');
    return;
  }
  updateChrome();
  render();
  loadAux();
}

function loadAux() {
  if (BOARD === 'architecture') loadViews();
  if (BOARD === 'runners') {
    loadGit();
    loadRuntimeStatus();
  }
  if (BOARD === 'quality') loadErrors();
  if (BOARD === 'storage') loadArtifacts();
}

async function refreshAll() {
  state.git = null;
  state.viewsData = null;
  state.errors = null;
  state.runtimeStatus = null;
  state.infraStatus = null;
  state.repowiseStatus = null;
  await loadAll();
  toast('Обновлено');
}

async function loadViews() {
  if (state.loadingViews) return;
  state.loadingViews = true;
  try {
    state.viewsData = await api.boards.views({ projectDir: state.projectDir });
  } catch (err) {
    toast(`Представления: ${err.message}`, 'err');
  } finally {
    state.loadingViews = false;
    if (BOARD === 'architecture') render();
  }
}

async function loadGit() {
  try {
    state.git = await api.boards.git({ projectDir: state.projectDir });
  } catch (err) {
    state.git = { ok: false, error: err.message };
  }
  if (BOARD === 'runners') render();
}

async function loadRuntimeStatus() {
  try {
    state.runtimeStatus = await api.boards.runtimeStatus();
  } catch {
    state.runtimeStatus = null;
  }
  if (BOARD === 'runners') render();
}

async function loadErrors() {
  try {
    state.errors = await api.boards.errors();
  } catch {
    state.errors = [];
  }
  if (BOARD === 'quality') render();
}

async function loadArtifacts() {
  try {
    const [items, stats] = await Promise.all([
      api.artifacts.list({ projectDir: state.projectDir, kind: state.artifactKind, query: state.artifactQuery }),
      api.artifacts.stats({ projectDir: state.projectDir }),
    ]);
    state.artifacts = items;
    state.artifactStats = stats;
  } catch (err) {
    toast(`Хранилище: ${err.message}`, 'err');
  }
  if (BOARD === 'storage') render();
}

async function loadInfra() {
  try {
    state.infraStatus = await api.infra.status();
  } catch (err) {
    state.infraStatus = { error: err.message };
  }
  if (BOARD === 'storage') render();
}

async function loadRepowise() {
  try {
    state.repowiseStatus = await api.repowise.status({ projectDir: state.projectDir });
  } catch (err) {
    state.repowiseStatus = { installed: false, error: err.message };
  }
  if (BOARD === 'storage') render();
}

/* ---------- chrome ---------- */

function bindChrome() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      const board = tab.dataset.board;
      if (board === BOARD) return;
      api.boards.open(board, '');
    });
  }
  $('#project-chip').addEventListener('click', pickProject);
  $('#refresh-btn').addEventListener('click', refreshAll);
  $('#main-btn').addEventListener('click', () => api.focusMain?.());
  api.boards.onEvent(handleBoardEvent);
  const applyFocus = (focus) => {
    if (!focus) return;
    // Вкладка «Хранилища» из каталога коннекторов (CW3.3): tab:infra, tab:repowise.
    if (focus.startsWith('tab:')) {
      state.storageTab = focus.slice('tab:'.length);
      if (state.storageTab === 'infra' && !state.infraStatus) loadInfra();
      if (state.storageTab === 'repowise' && !state.repowiseStatus) loadRepowise();
      render();
    } else if (focus.startsWith('artifact:')) {
      state.storageTab = 'artifacts';
      selectArtifact(focus.slice('artifact:'.length));
    } else if (focus === 'adr') {
      state.archTab = 'adr';
      render();
    } else if (focus.startsWith('stage:')) {
      state.openStage = focus.slice('stage:'.length);
      render();
    }
  };
  api.boards.onFocus(({ focus } = {}) => applyFocus(focus));
  // Новое окно получает вкладку в адресе (?focus=tab:…); прочие фокусы — как раньше, событием.
  setTimeout(() => {
    const initial = new URLSearchParams(location.search).get('focus') || '';
    if (initial.startsWith('tab:')) applyFocus(initial);
  }, 0);
  $('#view').addEventListener('click', onClick);
  $('#view').addEventListener('input', onInput);
  $('#view').addEventListener('change', onChange);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target?.id === 'diagram-agent-input') {
      event.preventDefault();
      sendDiagramAgent();
      return;
    }
    if (event.key === 'Escape') {
      const backdrop = $('.modal-backdrop');
      if (backdrop) backdrop.remove();
    }
  });
}

function updateChrome() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.board === BOARD);
  }
  $('#board-subtitle').textContent = TITLES[BOARD] || 'доски проекта';
  document.title = `MAI Code — ${TITLES[BOARD] || 'Доски'}`;
  const name = state.projectDir ? basename(state.projectDir) : 'Папка не выбрана';
  $('#project-name').textContent = name;
  $('#project-name').title = state.projectDir || 'Выберите папку проекта';
}

async function pickProject() {
  const dir = await api.project.pick();
  if (!dir) return;
  state.projectDir = dir;
  state.boards = null;
  state.viewsData = null;
  state.artifacts = [];
  state.artifact = null;
  await loadAll();
}

function renderNoProject() {
  $('#view').innerHTML = `
    <div class="card" style="max-width:640px;margin:8vh auto;text-align:center;padding:34px">
      <h1 style="margin:0 0 8px;font-size:22px">Папка проекта не выбрана</h1>
      <p class="muted" style="margin:0 0 18px">Доски хранят данные в <span class="mono">&lt;проект&gt;/.mai-code/boards.json</span>, поэтому нужен проект.</p>
      <button class="btn primary" data-act="pick-project">Выбрать папку</button>
    </div>`;
}

/* ---------- events ---------- */

function handleBoardEvent(event) {
  if (!event || !event.type) return;
  switch (event.type) {
    case 'delta': {
      if (!state.correctionLive) state.correctionLive = { content: '', reasoning: '', tools: [], results: {}, running: true };
      state.correctionLive.content += event.text || '';
      paintStream();
      break;
    }
    case 'reasoning': {
      if (!state.correctionLive) state.correctionLive = { content: '', reasoning: '', tools: [], results: {}, running: true };
      state.correctionLive.reasoning += event.text || '';
      paintStream();
      break;
    }
    case 'tool_call': {
      if (!state.correctionLive) state.correctionLive = { content: '', reasoning: '', tools: [], results: {}, running: true };
      state.correctionLive.tools.push({ id: event.id, name: event.name, args: event.args });
      paintStream();
      break;
    }
    case 'tool_result': {
      if (state.correctionLive) {
        state.correctionLive.results[event.id] = { ok: event.ok, content: event.content };
        paintStream();
      }
      break;
    }
    case 'approval':
      askApproval(event);
      break;
    case 'approval:expired':
      state.approvalOpen = false;
      toast('Подтверждение истекло — действие отменено', 'err');
      break;
    case 'correction:done':
      state.correctionLive = null;
      state.selectedIssues.clear();
      toast('Самокоррекция завершена', 'ok');
      loadAll();
      break;
    case 'correction:error':
      state.correctionLive = null;
      toast(event.message || 'Самокоррекция прервана', 'err');
      loadAll();
      break;
    case 'stage:chunk': {
      const id = event.stageId;
      state.stageLogs[id] = (state.stageLogs[id] || '') + (event.text || '');
      if (state.openStage === id) {
        const node = $('#stage-console');
        if (node) {
          node.textContent = state.stageLogs[id];
          node.scrollTop = node.scrollHeight;
        }
      }
      break;
    }
    case 'stage:exit': {
      state.runningStage = '';
      if (event.log) state.stageLogs[event.stageId] = event.log;
      toast(event.code === 0 ? 'Стадия завершена успешно' : `Стадия завершилась с кодом ${event.code}`, event.code === 0 ? 'ok' : 'err');
      loadAll();
      break;
    }
    default:
      break;
  }
}

function askApproval(event) {
  // Второе подтверждение поверх первого оставило бы нижнюю модалку без ответа.
  if (state.approvalOpen) {
    api.chat.approve(event.id, false);
    toast('Предыдущее подтверждение ещё открыто — новое действие отклонено', 'err');
    return;
  }
  state.approvalOpen = true;
  let answered = false;
  const answer = (allow) => {
    if (answered) return;
    answered = true;
    state.approvalOpen = false;
    api.chat.approve(event.id, allow);
  };
  const modal = openModal({
    title: 'Подтверждение действия',
    size: 'small',
    // Закрытие крестиком или кликом по фону — отказ, а не вечное ожидание.
    onClose: () => answer(false),
    body: [
      el('p', { class: 'dim', text: 'Самокоррекция просит разрешение:' }),
      el('pre', { class: 'source', text: event.summary || '' }),
      el('p', { class: 'muted', text: `Инструмент: ${event.name}` }),
    ],
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Отклонить',
        onclick: () => {
          answer(false);
          modal.close();
        },
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Разрешить',
        onclick: () => {
          answer(true);
          modal.close();
        },
      }),
    ],
  });
}

/* ---------- router ---------- */

function render() {
  if (!state.boards) {
    if (!state.projectDir) renderNoProject();
    return;
  }
  if (BOARD === 'delivery') renderDelivery();
  else if (BOARD === 'architecture') renderArchitecture();
  else if (BOARD === 'runners') renderRunners();
  else if (BOARD === 'quality') renderQuality();
  else if (BOARD === 'storage') renderStorage();
  else renderNoProject();
}

function onClick(event) {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;
  const id = target.dataset.id;
  const actions = {
    'pick-project': () => pickProject(),
    'open-url': () => api.openExternal(target.dataset.url),
    'open-board': () => api.boards.open(target.dataset.board, target.dataset.focus || ''),
    'open-artifact': () => api.boards.open('storage', `artifact:${target.dataset.id}`),

    'task-new': () => taskModal(null, target.dataset.status || 'backlog'),
    'task-edit': () => taskModal(findTask(id), ''),
    'task-delete': () => deleteTask(id),
    'multica-config': () => multicaModal(),
    'multica-open': () => openMultica(),

    'arch-tab': () => {
      state.archTab = target.dataset.tab;
      render();
    },
    'view-select': () => {
      state.openView = target.dataset.view;
      render();
    },
    'toggle-source': () => {
      state.showSource = !state.showSource;
      render();
    },
    'baseline': () => saveBaseline(),
    'save-view': () => saveView(),
    'export-view': () => exportView(),
    'diagram-agent-send': () => sendDiagramAgent(),
    'diagram-agent-clear': () => {
      delete state.diagramChat[state.openView];
      render();
    },
    'copy-mermaid': () => {
      const view = state.viewsData?.views?.[state.openView];
      copyText(state.openView === 'openapi' ? JSON.stringify(view?.spec || {}, null, 2) : view?.mermaid || '');
    },
    'adr-new': () => adrModal(null),
    'adr-edit': () => adrModal((state.boards.architecture.adrs || []).find((a) => a.id === id)),
    'adr-delete': () => deleteAdr(id),
    'model-save': () => saveModel(),

    'stage-run': () => runStage(id),
    'stage-stop': () => stopStage(),
    'stage-edit': () => stageModal(id),
    'stage-open': () => {
      state.openStage = id;
      render();
    },
    'git-refresh': () => loadGit(),
    'file-diff': () => showGitDiff(target.dataset.file || ''),
    'git-diff': () => showGitDiff(''),

    'scan': () => scan(),
    'issue-toggle': () => toggleIssue(id),
    'issue-ignore': () => ignoreIssue(id),
    'issue-open': () => api.boards.open('storage', `artifact:${id}`),
    'select-all': () => selectAllIssues(),
    'correction-start': () => startCorrection(),
    'correction-stop': () => stopCorrection(),
    'errors-clear': () => clearErrors(),
    'error-detail': () => showError(id),

    'storage-tab': () => {
      state.storageTab = target.dataset.tab;
      if (state.storageTab === 'infra' && !state.infraStatus) loadInfra();
      if (state.storageTab === 'repowise' && !state.repowiseStatus) loadRepowise();
      render();
    },
    'artifact-select': () => selectArtifact(id),
    'artifact-new': () => newArtifactModal(),
    'artifact-save': () => saveArtifact(),
    'artifact-delete': () => deleteArtifact(),
    'artifact-export': () => exportArtifact(),
    'artifact-apply': () => applyArtifact(),
    'artifact-import': () => importArtifacts(),
    'artifact-folder': () => api.artifacts.openFolder({ projectDir: state.projectDir }),
    'version-view': () => viewVersion(Number(target.dataset.version)),
    'version-diff': () => diffVersion(Number(target.dataset.version)),
    'version-restore': () => restoreVersion(Number(target.dataset.version)),
    'artifact-refresh': () => loadArtifacts(),

    'infra-save': () => saveInfra(),
    'infra-probe': () => loadInfra(),
    'infra-sync': () => syncInfra(),
    'infra-push': () => pushSecrets(),
    'infra-pull': () => pullSecrets(),
    'infra-search': () => remoteSearch(),

    'repowise-install': () => repowiseAction('install'),
    'repowise-refresh': () => loadRepowise(),
    'repowise-init': () => repowiseAction('init'),
    'repowise-update': () => repowiseAction('update'),
    'repowise-doctor': () => repowiseAction('doctor'),
    'repowise-mcp': () => repowiseAction('mcp'),
    'repowise-serve': () => repowiseAction('serve'),
    'repowise-ask': () => repowiseQuery('ask'),
    'repowise-search': () => repowiseQuery('search'),
  };
  if (actions[act]) {
    event.preventDefault();
    actions[act]();
  }
}

let inputTimer = null;
function onInput(event) {
  const target = event.target.closest('[data-input]');
  if (!target) return;
  const kind = target.dataset.input;
  if (kind === 'artifact-search') {
    state.artifactQuery = target.value.trim();
    clearTimeout(inputTimer);
    inputTimer = setTimeout(loadArtifacts, 280);
  }
}

function onChange(event) {
  const target = event.target.closest('[data-change]');
  if (!target) return;
  const kind = target.dataset.change;
  if (kind === 'artifact-kind') {
    state.artifactKind = target.value;
    loadArtifacts();
  }
  if (kind === 'export-format') {
    const format = target.value;
    target.value = '';
    if (format) exportDiagram(format);
  }
}

/* ---------- delivery ---------- */

function findTask(id) {
  return (state.boards.delivery.tasks || []).find((task) => task.id === id);
}

function renderDelivery() {
  const delivery = state.boards.delivery || { columns: [], tasks: [] };
  const tasks = delivery.tasks || [];
  const columns = delivery.columns || [];
  const done = tasks.filter((task) => task.status === 'done').length;
  const percent = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const multica = delivery.multica || {};

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Доставка</h1>
        <p>Прогресс по задачам проекта. Задачи связаны с артефактами хранилища.</p>
      </div>
      <div class="head-actions">
        <button class="btn" data-act="task-new">＋ Задача</button>
        <button class="btn ghost" data-act="multica-config">Multica</button>
        ${multica.url ? '<button class="btn primary" data-act="multica-open">Открыть Multica</button>' : ''}
      </div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="value">${tasks.length}</div><div class="label">всего задач</div></div>
      <div class="stat"><div class="value">${tasks.filter((t) => t.status === 'doing').length}</div><div class="label">в работе</div></div>
      <div class="stat"><div class="value">${tasks.filter((t) => t.status === 'review').length}</div><div class="label">на ревью</div></div>
      <div class="stat"><div class="value">${done}</div><div class="label">готово</div></div>
      <div class="stat" style="min-width:220px">
        <div class="value">${percent}%</div>
        <div class="label">прогресс</div>
        <div class="progress" style="margin-top:7px"><i style="width:${percent}%"></i></div>
      </div>
    </div>

    ${multica.url ? `<div class="banner info"><span>Multica: ${esc(multica.url)}</span><button class="btn small ghost" data-act="multica-open">Открыть</button></div>` : ''}

    <div class="kanban">
      ${columns
        .map((column) => {
          const items = tasks.filter((task) => task.status === column.id);
          return `<section class="column" data-column="${esc(column.id)}">
            <div class="column-head"><span class="name">${esc(column.name)}</span><span class="count">${items.length}</span></div>
            ${items.map((task) => taskCard(task)).join('')}
            <button class="column-add" data-act="task-new" data-status="${esc(column.id)}">＋ добавить</button>
          </section>`;
        })
        .join('')}
    </div>`;

  bindKanban();
}

function taskCard(task) {
  const links = (task.links?.artifacts || [])
    .map((id) => `<button class="link-chip" data-act="open-artifact" data-id="${esc(id)}" title="${esc(id)}">${esc(shortId(id))}</button>`)
    .join('');
  return `<article class="task-card" draggable="true" data-task="${esc(task.id)}">
    <div class="task-title">${esc(task.title)}</div>
    ${task.description ? `<div class="task-desc">${esc(task.description)}</div>` : ''}
    <div class="task-meta">
      ${priorityBadge(task.priority)}
      ${task.assignee ? `<span class="badge">${esc(task.assignee)}</span>` : ''}
      ${task.due ? `<span class="badge">${esc(task.due)}</span>` : ''}
      ${task.multicaUrl ? `<button class="link-chip" data-act="open-url" data-url="${esc(task.multicaUrl)}">Multica</button>` : ''}
    </div>
    ${links ? `<div class="task-links">${links}</div>` : ''}
    <div class="task-actions">
      <button class="btn tiny" data-act="task-edit" data-id="${esc(task.id)}">Изменить</button>
      <button class="btn tiny" data-act="task-delete" data-id="${esc(task.id)}">Удалить</button>
    </div>
  </article>`;
}

function bindKanban() {
  for (const card of document.querySelectorAll('.task-card')) {
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', card.dataset.task);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  }
  for (const column of document.querySelectorAll('.column')) {
    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const taskId = event.dataTransfer.getData('text/plain');
      const task = findTask(taskId);
      if (!task || task.status === column.dataset.column) return;
      task.status = column.dataset.column;
      await saveSection('delivery');
      render();
    });
  }
}

async function saveSection(section) {
  try {
    const data = await api.boards.save({ projectDir: state.projectDir, section, data: state.boards[section], rev: state.boards.revs?.[section] ?? 0 });
    if (data?.conflict) {
      // Другое окно уже сохранило эту секцию: показываем свежую версию, правку повторить вручную.
      state.boards = data.boards;
      render();
      toast('Доску изменили в другом окне — показана свежая версия, повторите правку', 'err');
      return false;
    }
    state.boards = data;
    return true;
  } catch (err) {
    toast(`Сохранение: ${err.message}`, 'err');
    return false;
  }
}

function taskModal(existing, defaultStatus) {
  const title = el('input', { class: 'input', value: existing?.title || '' });
  const description = el('textarea', { class: 'input', rows: '3' });
  description.value = existing?.description || '';
  const status = el(
    'select',
    { class: 'input' },
    (state.boards.delivery.columns || []).map((column) =>
      el('option', { value: column.id, text: column.name, selected: (existing?.status || defaultStatus) === column.id ? true : null }),
    ),
  );
  const priority = el(
    'select',
    { class: 'input' },
    ['low', 'normal', 'high', 'critical'].map((value) =>
      el('option', { value, text: value, selected: (existing?.priority || 'normal') === value ? true : null }),
    ),
  );
  const assignee = el('input', { class: 'input', value: existing?.assignee || '' });
  const due = el('input', { class: 'input', type: 'date', value: existing?.due || '' });
  const links = el('input', {
    class: 'input',
    value: (existing?.links?.artifacts || []).join(', '),
    placeholder: 'skill:review, adr:storage',
  });
  const multicaUrl = el('input', { class: 'input', value: existing?.multicaUrl || '', placeholder: 'https://…/issues/…' });

  const modal = openModal({
    title: existing ? 'Изменить задачу' : 'Новая задача',
    body: [
      field('Название', title),
      field('Описание', description),
      el('div', { class: 'form-row' }, [field('Колонка', status), field('Приоритет', priority)]),
      el('div', { class: 'form-row' }, [field('Исполнитель', assignee), field('Срок', due)]),
      field('Связанные артефакты (через запятую)', links),
      field('Ссылка на задачу в Multica', multicaUrl),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          if (!title.value.trim()) {
            toast('Нужно название', 'err');
            return;
          }
          const task = existing || { id: uid(), createdAt: new Date().toISOString() };
          Object.assign(task, {
            title: title.value.trim(),
            description: description.value.trim(),
            status: status.value,
            priority: priority.value,
            assignee: assignee.value.trim(),
            due: due.value,
            links: {
              artifacts: links.value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            },
            multicaUrl: multicaUrl.value.trim(),
            updatedAt: new Date().toISOString(),
          });
          if (!existing) state.boards.delivery.tasks.push(task);
          modal.close();
          await saveSection('delivery');
          render();
        },
      }),
    ],
  });
}

async function deleteTask(id) {
  const task = findTask(id);
  if (!task) return;
  const modal = openModal({
    title: 'Удалить задачу?',
    size: 'small',
    body: [el('p', { class: 'dim', text: task.title })],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn danger',
        type: 'button',
        text: 'Удалить',
        onclick: async () => {
          state.boards.delivery.tasks = state.boards.delivery.tasks.filter((item) => item.id !== id);
          modal.close();
          await saveSection('delivery');
          render();
        },
      }),
    ],
  });
}

function multicaModal() {
  const multica = state.boards.delivery.multica || {};
  const url = el('input', { class: 'input', value: multica.url || '', placeholder: 'http://127.0.0.1:3000' });
  const modal = openModal({
    title: 'Multica',
    body: [
      el('p', {
        class: 'muted',
        text: 'Multica — отдельное self-hosted приложение (Go + Postgres). MAI Code не запускает его и пока не синхронизирует задачи через API: доска работает локально, а Multica открывается по ссылке. Это честное ограничение текущей версии.',
      }),
      field('Базовый URL или ссылка на проект', url),
      el('p', { class: 'muted', text: 'Задачи можно связать с конкретным issue через поле «Ссылка на задачу в Multica».' }),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          state.boards.delivery.multica = { ...multica, url: url.value.trim() };
          modal.close();
          await saveSection('delivery');
          render();
        },
      }),
    ],
  });
}

function openMultica() {
  const url = state.boards.delivery.multica?.url;
  if (!url) {
    toast('Укажите URL Multica', 'err');
    return;
  }
  api.openExternal(url);
}

/* ---------- architecture ---------- */

function renderArchitecture() {
  const tab = state.archTab;
  const adrs = state.boards.architecture.adrs || [];
  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Архитектура</h1>
        <p>C1–C4, sequence, ER, deployment с sizing и OpenAPI. Mermaid рисуется локально, PlantUML экспортируется.</p>
      </div>
      <div class="head-actions">
        <button class="btn" data-act="baseline">Зафиксировать baseline</button>
        <button class="btn ghost" data-act="open-board" data-board="quality">Проверить качество</button>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab ${tab === 'diagrams' ? 'active' : ''}" data-act="arch-tab" data-tab="diagrams">Диаграммы</button>
      <button class="subtab ${tab === 'adr' ? 'active' : ''}" data-act="arch-tab" data-tab="adr">ADR · ${adrs.length}</button>
      <button class="subtab ${tab === 'model' ? 'active' : ''}" data-act="arch-tab" data-tab="model">Модель</button>
    </div>
    ${tab === 'diagrams' ? architectureDiagrams() : ''}
    ${tab === 'adr' ? architectureAdr() : ''}
    ${tab === 'model' ? architectureModel() : ''}`;

  if (tab === 'diagrams') paintDiagram();
}

function architectureDiagrams() {
  const data = state.viewsData;
  if (!data) {
    if (!state.loadingViews) loadViews();
    return '<div class="empty-note">Строю представления…</div>';
  }
  const view = data.views?.[state.openView];
  const driftViews = Object.entries(data.drift || {})
    .filter(([, value]) => value)
    .map(([key]) => VIEW_NAMES[key] || key);
  const banner =
    driftViews.length || data.gitDrift
      ? `<div class="banner"><span>Архитектурный дрейф после baseline${driftViews.length ? `: ${esc(driftViews.join(', '))}` : ''}${data.gitDrift ? ' · git HEAD изменился' : ''}</span><button class="btn small ghost" data-act="baseline">Обновить baseline</button></div>`
      : '';

  return `${banner}
    <div class="split">
      <div>
        <div class="card">
          <div class="card-head"><h2>Представления</h2><span class="hint">${data.baseline ? `baseline ${fmtDate(data.baseline.at)}` : 'baseline не задан'}</span></div>
          <div class="view-list">
            ${VIEW_ORDER.map((key) => {
              const item = data.views[key];
              const drift = data.drift?.[key];
              return `<button class="view-item ${state.openView === key ? 'active' : ''}" data-act="view-select" data-view="${esc(key)}">
                <span>${esc(VIEW_NAMES[key])}</span>
                ${drift ? '<span class="drift-dot" title="дрейф"></span>' : ''}
              </button>`;
            }).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Как это устроено</h2></div>
          <p class="muted" style="margin:0">
            Модель архитектуры хранится в <span class="mono">.mai-code/boards.json</span>.
            Из неё генерируются Mermaid и PlantUML. Baseline фиксирует хеши представлений и git HEAD — расхождение показывает дрейф.
            PlantUML не рендерится без Java-рантайма, поэтому экспортируется файлом.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>${esc(view?.title || VIEW_NAMES[state.openView])}</h2>
          <div class="diagram-toolbar">
            <button class="btn small ghost" data-act="toggle-source">${state.showSource ? 'Показать диаграмму' : 'Исходник'}</button>
            <button class="btn small ghost" data-act="copy-mermaid">Копировать</button>
            <button class="btn small" data-act="save-view">В артефакты</button>
            <select class="input diagram-export" data-change="export-format" title="Скачать схему">
              <option value="">Скачать…</option>
              ${state.openView === 'openapi'
                ? '<option value="json">OpenAPI (.json)</option>'
                : '<option value="svg">SVG</option><option value="png">PNG</option><option value="puml">PlantUML (.puml)</option><option value="json">JSON (модель)</option>'}
            </select>
          </div>
        </div>
        <div class="diagram" id="diagram"></div>
        ${state.showSource ? `<pre class="source" style="margin-top:12px">${esc(`--- Mermaid ---\n${view?.mermaid || ''}\n\n--- PlantUML ---\n${view?.puml || ''}`)}</pre>` : ''}
        ${diagramAgentPanel(view)}
      </div>
    </div>`;
}

function diagramAgentPanel(view) {
  const history = state.diagramChat[state.openView] || [];
  const messages = history.length
    ? history
        .map(
          (item) => `<div class="agent-msg ${item.role === 'user' ? 'user' : 'assistant'}">
            <div class="agent-role">${item.role === 'user' ? 'Вы' : 'Агент схем'}</div>
            <div class="agent-text">${esc(item.content)}</div>
          </div>`,
        )
        .join('')
    : `<div class="empty-note" style="padding:10px 0">Напишите, что поправить: «добавь Redis между API и Postgres», «раздели монолит на два контейнера», «покажи таймаут в sequence».</div>`;
  return `<div class="diagram-agent">
    <div class="card-head">
      <h2>Агент схем</h2>
      <span class="hint">${state.diagramBusy ? 'правлю модель…' : `контекст: ${esc(view?.title || VIEW_NAMES[state.openView])}`}</span>
    </div>
    <div class="agent-log" id="diagram-agent-log">${messages}</div>
    <div class="inline-form">
      <input class="input" id="diagram-agent-input" placeholder="Что поправить на схеме?" ${state.diagramBusy ? 'disabled' : ''} />
      <button class="btn primary" data-act="diagram-agent-send" ${state.diagramBusy ? 'disabled' : ''}>Отправить</button>
      <button class="btn ghost" data-act="diagram-agent-clear" title="Очистить историю">Очистить</button>
    </div>
  </div>`;
}

function paintDiagram() {
  const node = $('#diagram');
  if (!node) return;
  const view = state.viewsData?.views?.[state.openView];
  if (!view) {
    node.innerHTML = '<div class="empty-note">Нет данных представления</div>';
    return;
  }
  if (state.openView === 'openapi') {
    node.innerHTML = openapiTable(view);
    return;
  }
  if (state.showSource) {
    node.innerHTML = `<pre class="source">${esc(view.mermaid)}</pre>`;
    return;
  }
  renderMermaidInto(node, view.mermaid);
}

function openapiTable(view) {
  const endpoints = view.endpoints || [];
  if (!endpoints.length) return '<div class="empty-note">В OpenAPI нет эндпоинтов</div>';
  return `<table class="grid" style="width:100%">
    <thead><tr><th>Метод</th><th>Путь</th><th>Описание</th><th>Теги</th></tr></thead>
    <tbody>${endpoints
      .map(
        (item) => `<tr>
          <td><span class="badge accent">${esc(item.method)}</span></td>
          <td class="mono">${esc(item.path)}</td>
          <td>${esc(item.summary)}</td>
          <td class="muted">${esc((item.tags || []).join(', '))}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function architectureAdr() {
  const adrs = state.boards.architecture.adrs || [];
  return `<div class="card">
    <div class="card-head">
      <h2>Architecture Decision Records</h2>
      <button class="btn small primary" data-act="adr-new">＋ ADR</button>
    </div>
    ${adrs.length
      ? `<div class="list">${adrs
          .slice()
          .reverse()
          .map(
            (adr) => `<div class="list-item">
              <div class="grow">
                <div class="title">${esc(adr.title)}</div>
                <div class="sub">${fmtDate(adr.updatedAt || adr.createdAt)} · ${esc(adr.artifactId || '')}</div>
              </div>
              ${statusBadge(adr.status)}
              <div class="row-actions">
                <button class="btn tiny" data-act="adr-edit" data-id="${esc(adr.id)}">Открыть</button>
                <button class="btn tiny" data-act="adr-delete" data-id="${esc(adr.id)}">Удалить</button>
              </div>
            </div>`,
          )
          .join('')}</div>`
      : '<div class="empty-note">ADR пока нет. Начните с решения о хранилище или границах сервисов.</div>'}
  </div>`;
}

function architectureModel() {
  const model = state.boards.architecture.model || {};
  return `<div class="card">
    <div class="card-head">
      <h2>Модель архитектуры</h2>
      <button class="btn small primary" data-act="model-save">Сохранить модель</button>
    </div>
    <p class="muted" style="margin:0 0 10px">JSON описывает систему, контейнеры, компоненты, связи, sequence, ER, deployment и OpenAPI. Из него генерируются все представления.</p>
    <textarea class="input mono" id="model-json" rows="26" style="min-height:440px">${esc(JSON.stringify(model, null, 2))}</textarea>
  </div>`;
}

async function saveBaseline() {
  try {
    const baseline = await api.boards.baseline({ projectDir: state.projectDir });
    toast(`Baseline зафиксирован: ${fmtDate(baseline.at)}`, 'ok');
    await loadViews();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveView() {
  try {
    const res = await api.boards.saveView({ projectDir: state.projectDir, view: state.openView });
    toast(`Сохранено: ${res.artifact?.id || 'артефакт'}`, 'ok');
    if (BOARD === 'storage') loadArtifacts();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function exportView() {
  try {
    const res = await api.boards.exportView({ projectDir: state.projectDir, view: state.openView });
    if (res.ok) toast(`Экспортировано: ${res.file}`, 'ok');
    else toast(res.error || 'Не удалось экспортировать', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function exportDiagram(format) {
  const view = state.viewsData?.views?.[state.openView];
  if (!view) {
    toast('Схема ещё не построена', 'err');
    return;
  }
  try {
    let data = '';
    if (format === 'svg' || format === 'png') {
      if (state.openView === 'openapi') {
        toast('Для OpenAPI доступен формат JSON', 'err');
        return;
      }
      const svg = document.querySelector('#diagram svg');
      if (!svg) {
        toast('Диаграмма ещё не отрисована', 'err');
        return;
      }
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const text = new XMLSerializer().serializeToString(clone);
      if (format === 'svg') {
        data = text;
      } else {
        const rect = svg.getBoundingClientRect();
        const raster = await api.boards.rasterize({
          svg: text,
          scale: 2,
          width: Math.max(1, Math.ceil(rect.width || 1200)),
          height: Math.max(1, Math.ceil(rect.height || 800)),
        });
        if (!raster.ok) throw new Error(raster.error || 'Не удалось собрать PNG');
        data = raster.dataUrl;
      }
    }
    const res = await api.boards.exportDiagram({
      projectDir: state.projectDir,
      view: state.openView,
      format,
      data,
    });
    if (res.canceled) return;
    if (res.ok) toast(`Сохранено: ${res.file}`, 'ok');
    else toast(res.error || 'Не удалось сохранить', 'err');
  } catch (err) {
    toast(`Экспорт: ${err.message}`, 'err');
  }
}

async function sendDiagramAgent() {
  if (state.diagramBusy) return;
  const input = $('#diagram-agent-input');
  const message = input?.value.trim();
  if (!message) return;
  const view = state.openView;
  const history = state.diagramChat[view] || [];
  history.push({ role: 'user', content: message });
  state.diagramChat[view] = history;
  state.diagramBusy = true;
  render();
  try {
    const res = await api.boards.diagramChat({
      projectDir: state.projectDir,
      view,
      message,
      history: history.slice(0, -1),
      model: state.settings?.activeModel,
    });
    if (!res.ok) throw new Error(res.error || 'Агент не ответил');
    state.diagramChat[view].push({ role: 'assistant', content: res.reply || 'Готово' });
    state.viewsData = res.views;
    state.diagramBusy = false;
    render();
    toast('Схема обновлена', 'ok');
  } catch (err) {
    state.diagramChat[view].push({ role: 'assistant', content: `Ошибка: ${err.message}` });
    state.diagramBusy = false;
    render();
    toast(`Агент схем: ${err.message}`, 'err');
  }
}

async function saveModel() {
  const textarea = $('#model-json');
  if (!textarea) return;
  let model;
  try {
    model = JSON.parse(textarea.value);
  } catch (err) {
    toast(`Некорректный JSON: ${err.message}`, 'err');
    return;
  }
  state.boards.architecture.model = model;
  if (await saveSection('architecture')) {
    toast('Модель сохранена', 'ok');
    state.viewsData = null;
    await loadViews();
  }
}

function adrModal(existing) {
  const title = el('input', { class: 'input', value: existing?.title || '' });
  const status = el(
    'select',
    { class: 'input' },
    ['proposed', 'accepted', 'rejected', 'superseded'].map((value) =>
      el('option', { value, text: value, selected: (existing?.status || 'proposed') === value ? true : null }),
    ),
  );
  const content = el('textarea', { class: 'input', rows: '14' });
  content.value =
    existing?.content ||
    `# ${existing?.title || 'Новое решение'}\n\n## Контекст\n\n## Решение\n\n## Последствия\n\n## Альтернативы\n`;

  const modal = openModal({
    title: existing ? 'ADR' : 'Новый ADR',
    size: 'large',
    body: [
      field('Название', title),
      field('Статус', status),
      field('Содержимое (Markdown)', content),
    ],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          if (!title.value.trim()) {
            toast('Нужно название', 'err');
            return;
          }
          try {
            const artifact = await api.artifacts.save({
              projectDir: state.projectDir,
              artifact: {
                id: existing?.artifactId,
                kind: 'adr',
                name: title.value.trim(),
                title: title.value.trim(),
                content: content.value,
                meta: { status: status.value },
                note: `ADR · ${status.value}`,
              },
            });
            const adrs = state.boards.architecture.adrs || [];
            const entry = {
              id: existing?.id || artifact.artifact.id,
              artifactId: artifact.artifact.id,
              title: title.value.trim(),
              status: status.value,
              content: content.value,
              createdAt: existing?.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            if (existing) {
              const at = adrs.findIndex((item) => item.id === existing.id);
              if (at !== -1) adrs[at] = entry;
            } else {
              adrs.push(entry);
            }
            state.boards.architecture.adrs = adrs;
            modal.close();
            await saveSection('architecture');
            render();
            toast('ADR сохранён', 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }),
    ],
  });
}

async function deleteAdr(id) {
  state.boards.architecture.adrs = (state.boards.architecture.adrs || []).filter((adr) => adr.id !== id);
  await saveSection('architecture');
  render();
}

/* ---------- mermaid ---------- */

let mermaidSeq = 0;
let mermaidLoading = null;

/**
 * Грузит mermaid при первом обращении к диаграмме.
 * Скрипт весит ~5 МБ, поэтому не подключаем его на старте доски.
 */
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  mermaidLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../node_modules/mermaid/dist/mermaid.min.js';
    script.onload = () => {
      initMermaid();
      resolve(window.mermaid || null);
    };
    script.onerror = () => {
      mermaidLoading = null;
      reject(new Error('Не удалось загрузить mermaid'));
    };
    document.head.append(script);
  });
  return mermaidLoading;
}

function initMermaid() {
  if (!window.mermaid) return;
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      themeVariables: {
        background: '#10131b',
        primaryColor: '#1c2030',
        primaryTextColor: '#e8eaf2',
        primaryBorderColor: '#7c5cff',
        lineColor: '#6b7288',
        secondaryColor: '#232838',
        tertiaryColor: '#161922',
      },
    });
  } catch {
    /* старые версии mermaid могут не знать части опций */
  }
}

async function renderMermaidInto(node, text) {
  if (!text) {
    node.innerHTML = '<div class="empty-note">Пустая диаграмма</div>';
    return;
  }
  try {
    await ensureMermaid();
  } catch {
    /* ниже покажем исходник */
  }
  if (!window.mermaid) {
    node.innerHTML = `<div class="fallback"><p class="muted">Mermaid не загрузился, показываю исходник.</p><pre class="source">${esc(text)}</pre></div>`;
    return;
  }
  try {
    const id = `mai-mermaid-${++mermaidSeq}`;
    const { svg } = await window.mermaid.render(id, text);
    if (node.isConnected) node.innerHTML = svg;
  } catch (err) {
    node.innerHTML = `<div class="fallback">
      <div class="diagram-error">Mermaid: ${esc(err?.message || err)}</div>
      <pre class="source">${esc(text)}</pre>
    </div>`;
  }
}

/* ---------- runners ---------- */

function renderRunners() {
  const runners = state.boards.runners || { stages: [] };
  const stages = runners.stages || [];
  const running = stages.find((stage) => stage.status === 'running');
  const selected = stages.find((stage) => stage.id === state.openStage) || stages[0];
  const log = selected ? state.stageLogs[selected.id] ?? selected.log ?? '' : '';
  const git = state.git;
  const runtimes = Object.entries(state.settings?.runtimes || {});

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Рантаймы и деплой</h1>
        <p>Стадии сборки, тестов и деплоя, журнал выполнения и состояние git.</p>
      </div>
      <div class="head-actions">
        <button class="btn ghost" data-act="git-refresh">Обновить git</button>
        <button class="btn" data-act="open-board" data-board="quality">Ошибки агента</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="value">${stages.length}</div><div class="label">стадий</div></div>
      <div class="stat"><div class="value">${stages.filter((s) => s.status === 'ok').length}</div><div class="label">успешных</div></div>
      <div class="stat"><div class="value">${stages.filter((s) => s.status === 'error').length}</div><div class="label">с ошибкой</div></div>
      <div class="stat"><div class="value">${running ? 'идёт' : 'свободно'}</div><div class="label">конвейер</div></div>
      <div class="stat"><div class="value">${runtimes.length}</div><div class="label">внешних рантаймов</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Конвейер</h2>
        <span class="hint">${running ? `выполняется: ${esc(running.name)}` : 'стадии запускаются вручную'}</span>
      </div>
      <div class="stages">
        ${stages
          .map(
            (stage) => `<div class="stage ${esc(stage.status || 'idle')}">
              <div class="stage-head">
                <span class="stage-name">${esc(stage.name)}</span>
                ${stage.status === 'running' ? '<span class="spinner"></span>' : statusBadge(stage.status)}
              </div>
              <div class="stage-command">${esc(stage.command || 'команда не задана')}</div>
              <div class="muted">${stage.lastRunAt ? `${fmtDate(stage.lastRunAt)} · код ${stage.lastExit ?? '—'}` : 'ещё не запускалась'}</div>
              <div class="stage-foot">
                <button class="btn small" data-act="stage-open" data-id="${esc(stage.id)}">Лог</button>
                <div style="display:flex;gap:4px">
                  <button class="btn tiny" data-act="stage-edit" data-id="${esc(stage.id)}">Изменить</button>
                  ${
                    stage.status === 'running'
                      ? '<button class="btn tiny danger" data-act="stage-stop">Стоп</button>'
                      : `<button class="btn tiny primary" data-act="stage-run" data-id="${esc(stage.id)}">Запустить</button>`
                  }
                </div>
              </div>
            </div>`,
          )
          .join('')}
      </div>
    </div>

    <div class="split" style="margin-top:12px">
      <div>
        <div class="card">
          <div class="card-head"><h2>Git</h2><span class="hint">${git?.ok ? esc(git.branch) : ''}</span></div>
          ${
            git?.ok
              ? `<dl class="kv">
                  <dt>Ветка</dt><dd class="mono">${esc(git.branch)}</dd>
                  <dt>HEAD</dt><dd class="mono">${esc(git.head)}</dd>
                  <dt>Изменения</dt><dd>${git.dirty} файл(ов) · +${git.ahead} / −${git.behind}</dd>
                  <dt>Remote</dt><dd class="mono">${esc(git.remote || '—')}</dd>
                </dl>
                <div class="list" style="margin-top:10px;max-height:260px;overflow:auto">
                  ${(git.files || [])
                    .slice(0, 60)
                    .map(
                      (file) => `<div class="list-item">
                        <span class="badge">${esc(file.status)}</span>
                        <div class="grow mono" style="font-size:11.5px">${esc(file.file)}</div>
                        <button class="btn tiny" data-act="file-diff" data-file="${esc(file.file)}">diff</button>
                      </div>`,
                    )
                    .join('') || '<div class="empty-note">Рабочее дерево чистое</div>'}
                </div>`
              : `<div class="empty-note">${esc(git?.error || 'git не найден или папка не репозиторий')}</div>`
          }
        </div>

        <div class="card">
          <div class="card-head"><h2>Внешние рантаймы</h2></div>
          ${
            runtimes.length
              ? `<div class="list">${runtimes
                  .map(
                    ([name, runtime]) => `<div class="list-item">
                      <div class="grow">
                        <div class="title">${esc(name)}</div>
                        <div class="sub mono">${esc(runtime?.command || '')} ${esc((runtime?.args || []).join(' '))}</div>
                      </div>
                      <span class="badge">${state.runtimeStatus?.running ? 'занят' : 'ожидает'}</span>
                    </div>`,
                  )
                  .join('')}</div>`
              : '<div class="empty-note">Рантаймы не настроены. Добавьте их в главном окне → «Рантаймы».</div>'
          }
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Журнал: ${esc(selected?.name || '—')}</h2>
          <div style="display:flex;gap:6px">
            ${selected?.status === 'running' ? '<button class="btn small danger" data-act="stage-stop">Остановить</button>' : ''}
            ${selected ? `<button class="btn small" data-act="stage-run" data-id="${esc(selected.id)}">Запустить</button>` : ''}
          </div>
        </div>
        <pre class="console" id="stage-console">${esc(log || 'Журнал пуст')}</pre>
        <p class="muted" style="margin:10px 0 0">
          Каждая стадия — обычная shell-команда в папке проекта. Для агентного деплоя задайте команду стадии
          (например, вызов вашего пайплайна), а прогресс и ошибки попадут в журнал и на доску качества.
        </p>
      </div>
    </div>`;
}

function stageModal(id) {
  const stage = (state.boards.runners.stages || []).find((item) => item.id === id);
  if (!stage) return;
  const name = el('input', { class: 'input', value: stage.name || '' });
  const command = el('input', { class: 'input', value: stage.command || '', placeholder: 'npm.cmd run build' });
  const modal = openModal({
    title: 'Стадия конвейера',
    body: [field('Название', name), field('Команда', command), el('p', { class: 'muted', text: 'Команда выполняется через shell в папке проекта.' })],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Сохранить',
        onclick: async () => {
          stage.name = name.value.trim() || stage.name;
          stage.command = command.value.trim();
          modal.close();
          await saveSection('runners');
          render();
        },
      }),
    ],
  });
}

async function runStage(id) {
  if (state.runningStage) {
    toast('Другая стадия уже выполняется', 'err');
    return;
  }
  try {
    const res = await api.boards.stageRun({ projectDir: state.projectDir, stageId: id });
    if (!res.ok) {
      toast(res.error || 'Не удалось запустить', 'err');
      return;
    }
    state.runningStage = id;
    state.openStage = id;
    state.stageLogs[id] = '';
    toast(`Запущено: ${res.command}`, 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function stopStage() {
  await api.boards.stageStop();
  toast('Останавливаю стадию…');
}

async function showGitDiff(file) {
  try {
    const res = await api.boards.diff({ projectDir: state.projectDir, file });
    openModal({
      title: file ? `Diff · ${file}` : 'Git diff',
      size: 'large',
      body: [
        el('pre', { class: 'source', html: diffHtml(res.diff || res.stat || 'Изменений нет') }),
      ],
      footer: [el('button', { class: 'btn', type: 'button', text: 'Закрыть', onclick: () => document.querySelector('.modal-backdrop')?.remove() })],
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------- quality ---------- */

function renderQuality() {
  const quality = state.boards.quality || { issues: [], corrections: [] };
  const issues = quality.issues || [];
  const open = issues.filter((issue) => issue.status !== 'ignored');
  const errors = state.errors || [];
  const selectedCount = [...state.selectedIssues].filter((id) => issues.some((issue) => issue.id === id)).length;

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Качество и самокоррекция</h1>
        <p>Ошибки агента, дубли и конфликты артефактов, запуск цикла исправлений и diff'ы.</p>
      </div>
      <div class="head-actions">
        <button class="btn primary" data-act="scan">Сканировать</button>
        <button class="btn ghost" data-act="git-diff">Git diff</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="value">${open.length}</div><div class="label">открытых проблем</div></div>
      <div class="stat"><div class="value">${issues.filter((i) => i.severity === 'error' && i.status !== 'ignored').length}</div><div class="label">ошибок</div></div>
      <div class="stat"><div class="value">${issues.filter((i) => i.severity === 'warn' && i.status !== 'ignored').length}</div><div class="label">предупреждений</div></div>
      <div class="stat"><div class="value">${(quality.corrections || []).length}</div><div class="label">циклов исправления</div></div>
      <div class="stat"><div class="value">${errors.length}</div><div class="label">записей в журнале</div></div>
    </div>

    ${quality.lastScanAt ? `<p class="muted" style="margin:-4px 0 12px">Последний скан: ${fmtDate(quality.lastScanAt)}</p>` : ''}

    <div class="split wide">
      <div class="card">
        <div class="card-head">
          <h2>Проблемы</h2>
          <button class="btn tiny" data-act="select-all">Выбрать все</button>
        </div>
        ${
          issues.length
            ? `<div class="scroll-list">${issues
                .map(
                  (issue) => `<div class="list-item ${state.selectedIssues.has(issue.id) ? 'selected' : ''}">
                    <span class="severity-bar ${esc(issue.severity)}"></span>
                    <input type="checkbox" ${state.selectedIssues.has(issue.id) ? 'checked' : ''} data-act="issue-toggle" data-id="${esc(issue.id)}" />
                    <div class="grow">
                      <div class="title">${esc(issue.title)}</div>
                      <div class="sub">${esc(issue.type)} · ${issue.status === 'ignored' ? 'игнорируется' : 'открыта'}</div>
                      ${issue.detail ? `<div class="issue-detail">${esc(issue.detail)}</div>` : ''}
                    </div>
                    <div class="row-actions">
                      ${issue.artifactId ? `<button class="btn tiny" data-act="issue-open" data-id="${esc(issue.artifactId)}">Артефакт</button>` : ''}
                      <button class="btn tiny" data-act="issue-ignore" data-id="${esc(issue.id)}">${issue.status === 'ignored' ? 'Вернуть' : 'Игнор'}</button>
                    </div>
                  </div>`,
                )
                .join('')}</div>`
            : '<div class="empty-note">Проблем нет или скан ещё не запускался.</div>'
        }
      </div>

      <div>
        <div class="card">
          <div class="card-head">
            <h2>Самокоррекция</h2>
            <span class="hint">${state.settings?.activeModel ? esc(state.settings.activeModel) : 'активная модель'}</span>
          </div>
          <p class="muted" style="margin:0 0 10px">Агент получит выбранные проблемы, прочитает файлы, внесёт правки и запустит повторный скан. Каждое действие с файлами и shell требует подтверждения.</p>
          <div class="inline-form" style="margin-bottom:10px">
            <button class="btn primary" data-act="correction-start" ${selectedCount ? '' : 'disabled'}>Запустить (${selectedCount})</button>
            ${state.correctionLive ? '<button class="btn danger" data-act="correction-stop">Остановить</button>' : ''}
            <span class="muted">${state.correctionLive ? 'цикл выполняется…' : 'цикл не запущен'}</span>
          </div>
          <div class="stream" id="correction-stream">${correctionStreamHtml()}</div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>Журнал ошибок агента</h2>
            <button class="btn tiny" data-act="errors-clear">Очистить</button>
          </div>
          ${
            errors.length
              ? `<div class="scroll-list" style="max-height:280px">${errors
                  .slice()
                  .reverse()
                  .slice(0, 40)
                  .map(
                    (entry, index) => `<div class="list-item">
                      <div class="grow">
                        <div class="title">${esc(entry.source || 'agent')} · ${fmtDate(entry.at)}</div>
                        <div class="sub">${esc(entry.message || '')}</div>
                      </div>
                      <button class="btn tiny" data-act="error-detail" data-id="${esc(String(entry.at || index))}">Детали</button>
                    </div>`,
                  )
                  .join('')}</div>`
              : '<div class="empty-note">Журнал пуст.</div>'
          }
        </div>

        <div class="card">
          <div class="card-head"><h2>История исправлений</h2></div>
          ${
            (quality.corrections || []).length
              ? `<div class="list">${(quality.corrections || [])
                  .slice(0, 10)
                  .map(
                    (item) => `<div class="list-item">
                      <div class="grow">
                        <div class="title">${fmtDate(item.startedAt)} · ${item.issueIds?.length || 0} проблем</div>
                        <div class="sub">${esc(item.summary || item.status)}</div>
                      </div>
                      ${statusBadge(item.status)}
                    </div>`,
                  )
                  .join('')}</div>`
              : '<div class="empty-note">Исправлений ещё не было.</div>'
          }
        </div>
      </div>
    </div>`;
}

function correctionStreamHtml() {
  const live = state.correctionLive;
  if (!live) return '<div class="empty-note">Здесь появится ход самокоррекции.</div>';
  const parts = [];
  const tail = (text) => (String(text || '').length > 20_000 ? `…${String(text).slice(-20_000)}` : String(text || ''));
  if (live.reasoning) parts.push(`<div class="stream-item reasoning">${esc(tail(live.reasoning))}</div>`);
  for (const tool of live.tools || []) {
    const result = live.results?.[tool.id];
    parts.push(`<div class="stream-item tool">
      <div class="name">${esc(tool.name)}</div>
      <pre>${esc(JSON.stringify(tool.args || {}, null, 2))}</pre>
      ${result ? `<pre>${esc(String(result.content || '').slice(0, 1200))}</pre>` : ''}
    </div>`);
  }
  if (live.content) parts.push(`<div class="stream-item">${esc(tail(live.content))}</div>`);
  return parts.join('') || '<div class="empty-note">Ожидаю ответ модели…</div>';
}

let streamPaintTimer = null;
function paintStream() {
  // Поток приходит токенами: перерисовывать весь блок на каждый токен дорого.
  if (streamPaintTimer) return;
  streamPaintTimer = setTimeout(() => {
    streamPaintTimer = null;
    const node = $('#correction-stream');
    if (!node) return;
    node.innerHTML = correctionStreamHtml();
    node.scrollTop = node.scrollHeight;
  }, 120);
}

async function scan() {
  toast('Сканирую артефакты…');
  try {
    const res = await api.boards.scan({ projectDir: state.projectDir });
    state.boards.quality.issues = res.issues;
    state.boards.quality.lastScanAt = res.scannedAt;
    toast(`Проблем: ${res.summary.open} из ${res.summary.total}`, res.summary.error ? 'err' : 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function toggleIssue(id) {
  if (state.selectedIssues.has(id)) state.selectedIssues.delete(id);
  else state.selectedIssues.add(id);
  render();
}

function selectAllIssues() {
  const issues = (state.boards.quality.issues || []).filter((issue) => issue.status !== 'ignored');
  const allSelected = issues.every((issue) => state.selectedIssues.has(issue.id));
  state.selectedIssues.clear();
  if (!allSelected) for (const issue of issues) state.selectedIssues.add(issue.id);
  render();
}

async function ignoreIssue(id) {
  const issue = (state.boards.quality.issues || []).find((item) => item.id === id);
  if (!issue) return;
  issue.status = issue.status === 'ignored' ? 'open' : 'ignored';
  await saveSection('quality');
  render();
}

async function startCorrection() {
  const issueIds = [...state.selectedIssues];
  if (!issueIds.length) {
    toast('Выберите проблемы', 'err');
    return;
  }
  try {
    const res = await api.boards.correction({
      projectDir: state.projectDir,
      issueIds,
      model: state.settings?.activeModel || '',
    });
    if (!res.ok) {
      toast(res.error || 'Не удалось запустить', 'err');
      return;
    }
    state.correctionLive = { content: '', reasoning: '', tools: [], results: {}, running: true };
    render();
    toast(`Запущено исправление ${res.issues} проблем`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function stopCorrection() {
  await api.boards.correctionStop();
  // Подтверждение могло висеть открытым: main закрывает его отказом.
  document.querySelector('.modal-backdrop')?.remove();
  toast('Останавливаю…');
}

async function clearErrors() {
  await api.boards.clearErrors();
  state.errors = [];
  render();
  toast('Журнал очищен', 'ok');
}

function showError(at) {
  const entry = (state.errors || []).find((item) => String(item.at) === at);
  if (!entry) return;
  openModal({
    title: 'Ошибка агента',
    body: [el('pre', { class: 'source', text: JSON.stringify(entry, null, 2) })],
    footer: [el('button', { class: 'btn', type: 'button', text: 'Закрыть', onclick: () => document.querySelector('.modal-backdrop')?.remove() })],
  });
}

/* ---------- storage ---------- */

function renderStorage() {
  const tab = state.storageTab;
  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Хранилище</h1>
        <p>Версии навыков, AGENTS.md, OpenSpec, ADR и диаграмм. Postgres, Vault и SeaweedFS — опциональный слой.</p>
      </div>
      <div class="head-actions">
        <button class="btn" data-act="artifact-new">＋ Артефакт</button>
        <button class="btn ghost" data-act="artifact-import">Импорт из проекта</button>
        <button class="btn ghost" data-act="artifact-folder">Папка</button>
      </div>
    </div>
    <div class="subtabs">
      <button class="subtab ${tab === 'artifacts' ? 'active' : ''}" data-act="storage-tab" data-tab="artifacts">Артефакты</button>
      <button class="subtab ${tab === 'infra' ? 'active' : ''}" data-act="storage-tab" data-tab="infra">Инфраструктура</button>
      <button class="subtab ${tab === 'repowise' ? 'active' : ''}" data-act="storage-tab" data-tab="repowise">Repowise</button>
    </div>
    ${tab === 'artifacts' ? storageArtifacts() : ''}
    ${tab === 'infra' ? storageInfra() : ''}
    ${tab === 'repowise' ? storageRepowise() : ''}`;
}

function storageArtifacts() {
  const stats = state.artifactStats;
  const artifacts = state.artifacts || [];
  const artifact = state.artifact;
  const history = state.artifactHistory || [];
  return `
    <div class="stats-row">
      <div class="stat"><div class="value">${stats?.total ?? 0}</div><div class="label">артефактов</div></div>
      <div class="stat"><div class="value">${stats?.versions ?? 0}</div><div class="label">версий</div></div>
      <div class="stat"><div class="value">${Math.round((stats?.bytes || 0) / 1024)}</div><div class="label">КБ в текущих версиях</div></div>
      <div class="stat"><div class="value">${stats?.byKind?.skill || 0}</div><div class="label">навыков</div></div>
      <div class="stat"><div class="value">${stats?.byKind?.adr || 0}</div><div class="label">ADR</div></div>
    </div>

    <div class="split">
      <div class="card">
        <div class="card-head">
          <h2>Артефакты</h2>
          <button class="btn tiny" data-act="artifact-refresh">Обновить</button>
        </div>
        <div class="inline-form" style="margin-bottom:8px">
          <input class="input" placeholder="Поиск по содержимому…" value="${esc(state.artifactQuery)}" data-input="artifact-search" />
        </div>
        <div class="inline-form" style="margin-bottom:10px">
          <select class="input" data-change="artifact-kind">
            <option value="">Все типы</option>
            ${KINDS.map(([value, label]) => `<option value="${value}" ${state.artifactKind === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
        <div class="scroll-list">
          ${artifacts.length
            ? artifacts
                .map(
                  (item) => `<button class="list-item ${artifact?.id === item.id ? 'selected' : ''}" data-act="artifact-select" data-id="${esc(item.id)}" style="text-align:left;width:100%">
                    <div class="grow">
                      <div class="title">${esc(item.name)}</div>
                      <div class="sub">${esc(item.kind)} · v${esc(item.current)} · ${esc(item.versions)} версий · ${esc(fmtDate(item.updatedAt))}</div>
                    </div>
                  </button>`,
                )
                .join('')
            : '<div class="empty-note">Пусто. Нажмите «Импорт из проекта».</div>'}
        </div>
      </div>

      <div>
        ${
          artifact
            ? `<div class="card">
                <div class="card-head">
                  <h2>${esc(artifact.name)}</h2>
                  <span class="badge accent">${esc(artifact.kind)}</span>
                </div>
                <div class="form">
                  <div class="form-row">
                    <div class="field"><label>Имя</label><input class="input" id="artifact-name" value="${esc(artifact.name)}" /></div>
                    <div class="field"><label>Заголовок</label><input class="input" id="artifact-title" value="${esc(artifact.title)}" /></div>
                  </div>
                  <div class="field"><label>Содержимое</label><textarea class="input" id="artifact-content" rows="18" style="min-height:340px">${esc(artifact.content)}</textarea></div>
                  <div class="field"><label>Комментарий к версии</label><input class="input" id="artifact-note" placeholder="что изменилось" /></div>
                  <div class="form-actions" style="justify-content:space-between">
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      <button class="btn ghost small" data-act="artifact-export">Экспорт</button>
                      ${artifact.meta?.file ? '<button class="btn ghost small" data-act="artifact-apply">Записать в файл</button>' : ''}
                      <button class="btn danger small" data-act="artifact-delete">Удалить</button>
                    </div>
                    <button class="btn primary" data-act="artifact-save">Сохранить версию</button>
                  </div>
                </div>
              </div>

              <div class="card">
                <div class="card-head"><h2>История версий</h2><span class="hint">${history.length}</span></div>
                ${
                  history.length
                    ? `<div class="list">${history
                        .slice()
                        .reverse()
                        .map(
                          (version) => `<div class="list-item">
                            <div class="grow">
                              <div class="title">v${version.version} ${version.current ? '<span class="badge green">текущая</span>' : ''}</div>
                              <div class="sub">${fmtDate(version.at)} · ${Math.round((version.size || 0) / 1024)} КБ ${version.note ? `· ${esc(version.note)}` : ''}</div>
                            </div>
                            <div class="row-actions">
                              <button class="btn tiny" data-act="version-view" data-version="${version.version}">Показать</button>
                              ${version.current ? '' : `<button class="btn tiny" data-act="version-diff" data-version="${version.version}">Diff</button><button class="btn tiny" data-act="version-restore" data-version="${version.version}">Вернуть</button>`}
                            </div>
                          </div>`,
                        )
                        .join('')}</div>`
                    : '<div class="empty-note">История пуста.</div>'
                }
              </div>`
            : '<div class="card"><div class="empty-note">Выберите артефакт слева или создайте новый.</div></div>'
        }
      </div>
    </div>`;
}

async function selectArtifact(id) {
  try {
    state.artifact = await api.artifacts.get({ projectDir: state.projectDir, id });
    state.artifactHistory = await api.artifacts.history({ projectDir: state.projectDir, id });
    state.storageTab = 'artifacts';
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveArtifact() {
  if (!state.artifact) return;
  const name = $('#artifact-name')?.value.trim();
  const title = $('#artifact-title')?.value.trim();
  const content = $('#artifact-content')?.value ?? '';
  const note = $('#artifact-note')?.value.trim() || '';
  try {
    await api.artifacts.save({
      projectDir: state.projectDir,
      artifact: {
        id: state.artifact.id,
        kind: state.artifact.kind,
        name: name || state.artifact.name,
        title: title || name || state.artifact.title,
        content,
        meta: state.artifact.meta || {},
        note,
      },
    });
    toast('Версия сохранена', 'ok');
    await selectArtifact(state.artifact.id);
    await loadArtifacts();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function newArtifactModal() {
  const kind = el('select', { class: 'input' }, KINDS.map(([value, label]) => el('option', { value, text: label })));
  const name = el('input', { class: 'input', placeholder: 'Например: review-checklist' });
  const title = el('input', { class: 'input' });
  const content = el('textarea', { class: 'input', rows: '12' });
  const modal = openModal({
    title: 'Новый артефакт',
    size: 'large',
    body: [el('div', { class: 'form-row' }, [field('Тип', kind), field('Имя', name)]), field('Заголовок', title), field('Содержимое', content)],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Создать',
        onclick: async () => {
          if (!name.value.trim()) {
            toast('Нужно имя', 'err');
            return;
          }
          try {
            const res = await api.artifacts.save({
              projectDir: state.projectDir,
              artifact: {
                kind: kind.value,
                name: name.value.trim(),
                title: title.value.trim() || name.value.trim(),
                content: content.value,
                note: 'создан вручную',
              },
            });
            modal.close();
            await loadArtifacts();
            await selectArtifact(res.artifact.id);
            toast('Артефакт создан', 'ok');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }),
    ],
  });
}

async function deleteArtifact() {
  if (!state.artifact) return;
  const modal = openModal({
    title: 'Удалить артефакт?',
    size: 'small',
    body: [el('p', { class: 'dim', text: `${state.artifact.name} (${state.artifact.versions} версий)` }), el('p', { class: 'muted', text: 'Blob-версии останутся в папке blobs, но запись и зеркало будут удалены.' })],
    footer: [
      el('button', { class: 'btn', type: 'button', text: 'Отмена', onclick: () => modal.close() }),
      el('button', {
        class: 'btn danger',
        type: 'button',
        text: 'Удалить',
        onclick: async () => {
          try {
            await api.artifacts.remove({ projectDir: state.projectDir, id: state.artifact.id });
            modal.close();
            state.artifact = null;
            state.artifactHistory = [];
            await loadArtifacts();
            render();
            toast('Артефакт удалён', 'ok');
          } catch (err) {
            toast(`Не удалось удалить: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });
}

async function exportArtifact() {
  if (!state.artifact) return;
  try {
    const res = await api.artifacts.export({ projectDir: state.projectDir, id: state.artifact.id });
    if (res.ok) toast(`Сохранено: ${res.file}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function applyArtifact() {
  if (!state.artifact) return;
  try {
    const res = await api.artifacts.applyToFile({ projectDir: state.projectDir, id: state.artifact.id });
    if (res.ok) toast(`Записано: ${res.file}`, 'ok');
    else toast(res.error || 'Не удалось', 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function importArtifacts() {
  try {
    const res = await api.artifacts.import({ projectDir: state.projectDir });
    const counts = Object.entries(res.imported || {})
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    toast(counts ? `Импортировано — ${counts}` : 'Новых артефактов нет', 'ok');
    await loadArtifacts();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function viewVersion(version) {
  if (!state.artifact) return;
  try {
    const content = await api.artifacts.version({ projectDir: state.projectDir, id: state.artifact.id, version });
    openModal({
      title: `${state.artifact.name} · v${version}`,
      size: 'large',
      body: [el('pre', { class: 'source', text: content || '(пусто)' })],
      footer: [
        el('button', { class: 'btn', type: 'button', text: 'Закрыть', onclick: () => document.querySelector('.modal-backdrop')?.remove() }),
        el('button', {
          class: 'btn primary',
          type: 'button',
          text: 'Сделать текущей',
          onclick: async () => {
            await api.artifacts.restore({ projectDir: state.projectDir, id: state.artifact.id, version });
            document.querySelector('.modal-backdrop')?.remove();
            await selectArtifact(state.artifact.id);
            toast('Версия восстановлена', 'ok');
          },
        }),
      ],
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function diffVersion(version) {
  if (!state.artifact) return;
  try {
    const lines = await api.artifacts.diff({ projectDir: state.projectDir, id: state.artifact.id, from: version });
    openModal({
      title: `Diff · v${version} → v${state.artifact.current}`,
      size: 'large',
      body: [el('pre', { class: 'source', html: linesHtml(lines) })],
      footer: [el('button', { class: 'btn', type: 'button', text: 'Закрыть', onclick: () => document.querySelector('.modal-backdrop')?.remove() })],
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function restoreVersion(version) {
  if (!state.artifact) return;
  try {
    await api.artifacts.restore({ projectDir: state.projectDir, id: state.artifact.id, version });
    await selectArtifact(state.artifact.id);
    await loadArtifacts();
    toast(`Версия ${version} восстановлена`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------- infra ---------- */

function storageInfra() {
  const cfg = state.settings?.infra || {};
  const status = state.infraStatus;
  const result = state.infraResult;
  const card = (name, item) => {
    const ok = item?.ok;
    return `<div class="status-card">
      <div class="name">${esc(name)} ${ok ? '<span class="badge green">доступно</span>' : '<span class="badge red">недоступно</span>'}</div>
      <div class="detail">${esc(item?.error || (item?.version ? `${item.version}${item.pgvector ? ` · pgvector ${item.pgvector}` : ''}` : item?.status ? `HTTP ${item.status}` : 'не проверялось'))}</div>
    </div>`;
  };

  return `
    <div class="split">
      <div class="card">
        <div class="card-head"><h2>Подключения</h2><button class="btn small" data-act="infra-probe">Проверить</button></div>
        <div class="form">
          <div class="field"><label>Postgres URL</label><input class="input" id="infra-postgres" value="${esc(cfg.postgresUrl || '')}" /></div>
          <div class="field"><label>Vault адрес</label><input class="input" id="infra-vault" value="${esc(cfg.vaultAddr || '')}" /></div>
          <div class="field"><label>Vault token</label><input class="input" id="infra-vault-token" type="password" placeholder="${cfg.vaultTokenSet || cfg.vaultToken ? 'сохранён (оставьте ***)' : 'токен'}" /></div>
          <div class="field"><label>SeaweedFS filer URL</label><input class="input" id="infra-seaweed" value="${esc(cfg.seaweedUrl || '')}" /></div>
          <div class="form-row">
            <div class="field"><label>Модель эмбеддингов</label><input class="input" id="infra-embed-model" value="${esc(cfg.embeddingModel || 'bge-m3')}" /></div>
            <div class="field"><label>Размерность</label><input class="input" id="infra-dimension" type="number" value="${esc(cfg.dimension || 1024)}" /></div>
          </div>
          <div class="form-actions">
            <button class="btn primary" data-act="infra-save">Сохранить</button>
          </div>
        </div>
        <p class="muted" style="margin:12px 0 0">
          Приложение работает и без этих сервисов: источник истины — локальные файлы в
          <span class="mono">.mai-code/artifacts</span>. Postgres/pgvector даёт полнотекстовый и векторный поиск,
          Vault — хранение ключей, SeaweedFS — резервную копию блобов.
        </p>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h2>Состояние</h2><span class="hint">${status ? 'проверено' : 'нажмите «Проверить»'}</span></div>
          <div class="status-grid">
            ${card('Postgres + pgvector', status?.postgres)}
            ${card('Vault', status?.vault)}
            ${card('SeaweedFS', status?.seaweed)}
          </div>
          ${status?.error ? `<p class="muted" style="margin:10px 0 0">${esc(status.error)}</p>` : ''}
        </div>

        <div class="card">
          <div class="card-head"><h2>Синхронизация</h2></div>
          <div class="head-actions">
            <button class="btn primary" data-act="infra-sync">Залить артефакты</button>
            <button class="btn ghost" data-act="infra-push">Ключи → Vault</button>
            <button class="btn ghost" data-act="infra-pull">Ключи ← Vault</button>
          </div>
          ${result ? `<pre class="output" style="margin-top:10px">${esc(JSON.stringify(result, null, 2))}</pre>` : '<p class="muted" style="margin:10px 0 0">Синхронизация выполняется вручную.</p>'}
        </div>

        <div class="card">
          <div class="card-head"><h2>Поиск в Postgres</h2></div>
          <div class="inline-form">
            <input class="input" id="infra-query" placeholder="Например: как хранятся версии навыков" />
            <button class="btn" data-act="infra-search">Искать</button>
          </div>
          ${
            state.remoteResults
              ? `<div class="list" style="margin-top:10px">${(state.remoteResults.results || [])
                  .map(
                    (item) => `<div class="list-item">
                      <div class="grow">
                        <div class="title">${esc(item.name || item.id)}</div>
                        <div class="sub">${esc(item.kind || '')} · v${esc(item.version ?? '—')} · score ${Number(item.score || 0).toFixed(3)}</div>
                        <div class="issue-detail">${esc(String(item.snippet || '').slice(0, 400))}</div>
                      </div>
                    </div>`,
                  )
                  .join('') || '<div class="empty-note">Ничего не найдено</div>'}</div>`
              : ''
          }
        </div>
      </div>
    </div>`;
}

async function saveInfra() {
  const patch = {
    postgresUrl: $('#infra-postgres')?.value.trim() || '',
    vaultAddr: $('#infra-vault')?.value.trim() || '',
    seaweedUrl: $('#infra-seaweed')?.value.trim() || '',
    embeddingModel: $('#infra-embed-model')?.value.trim() || 'bge-m3',
    dimension: Number($('#infra-dimension')?.value || 1024),
  };
  const token = $('#infra-vault-token')?.value.trim();
  if (token && token !== '***') patch.vaultToken = token;
  try {
    state.settings = await api.settings.save({ infra: patch });
    toast('Настройки инфраструктуры сохранены', 'ok');
    state.infraStatus = null;
    await loadInfra();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function syncInfra() {
  toast('Синхронизирую…');
  try {
    const payload = await api.infra.sync({ projectDir: state.projectDir });
    state.infraResult = payload;
    const result = payload.result || payload;
    const parts = [];
    if (result.postgres) parts.push(`Postgres: ${result.postgres.ok ? `${result.postgres.versions} версий` : result.postgres.error}`);
    if (result.seaweed) parts.push(`SeaweedFS: ${result.seaweed.ok ? `${result.seaweed.uploaded} файлов` : result.seaweed.error}`);
    if (result.vault) parts.push(`Vault: ${result.vault.ok ? 'ключи сохранены' : result.vault.error}`);
    toast(parts.join(' · ') || payload.error || 'Нечего синхронизировать', payload.ok ? 'ok' : 'err');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function pushSecrets() {
  try {
    const res = await api.infra.pushSecrets();
    toast(res.ok ? 'Ключи отправлены в Vault' : res.error || 'Не удалось отправить ключи', res.ok ? 'ok' : 'err');
  } catch (err) {
    toast(`Vault: ${err.message}`, 'err');
  }
}

async function pullSecrets() {
  try {
    const res = await api.infra.pullSecrets();
    toast(
      res.ok ? `Загружены провайдеры: ${res.result?.providers?.join(', ') || ''}` : res.error || 'Не удалось загрузить ключи',
      res.ok ? 'ok' : 'err',
    );
    if (res.ok) {
      state.settings = await api.settings.get();
      render();
    }
  } catch (err) {
    toast(`Vault: ${err.message}`, 'err');
  }
}

async function remoteSearch() {
  const query = $('#infra-query')?.value.trim();
  if (!query) return;
  try {
    const res = await api.infra.search({ projectDir: state.projectDir, query });
    if (!res.ok) {
      toast(res.error || 'Поиск недоступен', 'err');
      return;
    }
    state.remoteResults = res.result;
    render();
  } catch (err) {
    toast(`Поиск: ${err.message}`, 'err');
  }
}

/* ---------- repowise ---------- */

function storageRepowise() {
  const status = state.repowiseStatus;
  return `
    <div class="split">
      <div class="card">
        <div class="card-head"><h2>Repowise</h2><button class="btn small" data-act="repowise-refresh">Проверить</button></div>
        <div class="status-grid">
          <div class="status-card">
            <div class="name">CLI ${status?.installed ? '<span class="badge green">установлен</span>' : '<span class="badge red">не найден</span>'}</div>
            <div class="detail">${esc(status?.version || status?.error || 'нажмите «Проверить»')}</div>
          </div>
          <div class="status-card">
            <div class="name">Индекс ${status?.indexed ? '<span class="badge green">есть</span>' : '<span class="badge amber">нет</span>'}</div>
            <div class="detail mono">${esc(status?.indexPath || '')}</div>
          </div>
        </div>
        <div class="head-actions" style="margin-top:12px">
          <button class="btn primary" data-act="repowise-install">Установить</button>
          <button class="btn" data-act="repowise-init">Индексировать</button>
          <button class="btn ghost" data-act="repowise-update">Обновить индекс</button>
          <button class="btn ghost" data-act="repowise-doctor">Doctor</button>
        </div>
        <div class="head-actions" style="margin-top:8px">
          <button class="btn" data-act="repowise-mcp">Подключить MCP</button>
          <button class="btn ghost" data-act="repowise-serve">Открыть дашборд</button>
        </div>
        <p class="muted" style="margin:12px 0 0">
          Repowise индексирует код, git-историю и тесты локально. Агент спрашивает индекс вместо чтения файлов — это
          сокращает расход токенов. MCP-сервер запускается командой <span class="mono">repowise serve --no-ui</span> в папке проекта.
        </p>
      </div>

      <div>
        <div class="card">
          <div class="card-head"><h2>Запрос к индексу</h2></div>
          <div class="inline-form">
            <input class="input" id="repowise-query" placeholder="Что сломается, если изменить agent.js?" />
            <button class="btn" data-act="repowise-ask">Спросить</button>
            <button class="btn ghost" data-act="repowise-search">Поиск</button>
          </div>
          <pre class="output" style="margin-top:10px">${esc(state.repowiseOutput || 'Ответ появится здесь.')}</pre>
        </div>

        <div class="card">
          <div class="card-head"><h2>Что даёт</h2></div>
          <dl class="kv">
            <dt>Меньше токенов</dt><dd>агент получает карточки файлов и зависимостей вместо grep по всему репозиторию</dd>
            <dt>Единая база</dt><dd>индекс общий для всех агентов и людей в проекте</dd>
            <dt>Риск изменений</dt><dd><span class="mono">repowise risk</span> показывает, что затронуто и какие тесты запустить</dd>
            <dt>Дистилляция</dt><dd>вывод тестов и установки сжимается перед отправкой модели</dd>
          </dl>
          <p class="muted" style="margin:10px 0 0">
            Ограничение: Repowise — Python-приложение; для работы нужен Python и установка через <span class="mono">uv</span> или
            <span class="mono">pipx</span>. Без него MAI Code продолжает работать обычными инструментами.
          </p>
        </div>
      </div>
    </div>`;
}

async function repowiseAction(action) {
  try {
    if (action === 'install') {
      toast('Устанавливаю repowise, это может занять несколько минут…');
      const res = await api.repowise.install();
      toast(res.ok ? 'Repowise установлен' : `Не удалось: ${String(res.output || res.error || '').slice(0, 300)}`, res.ok ? 'ok' : 'err');
      state.repowiseOutput = res.output || '';
      await loadRepowise();
      return;
    }
    if (action === 'mcp') {
      const res = await api.repowise.connectMcp({ projectDir: state.projectDir });
      toast(res.ok ? 'MCP repowise подключён' : `MCP: ${res.error || 'не удалось подключить'}`, res.ok ? 'ok' : 'err');
      state.repowiseOutput = JSON.stringify(res, null, 2);
      render();
      return;
    }
    if (action === 'serve') {
      const res = await api.repowise.serve({ projectDir: state.projectDir });
      state.repowiseOutput = res.output || res.url || '';
      toast(res.ok ? `Дашборд: ${res.url}` : 'Не удалось запустить дашборд', res.ok ? 'ok' : 'err');
      render();
      return;
    }
    toast('Выполняю…');
    const res = await api.repowise[action]({ projectDir: state.projectDir });
    state.repowiseOutput = res.output || res.error || JSON.stringify(res, null, 2);
    toast(res.ok ? 'Готово' : `Ошибка: ${String(res.error || res.output || '').slice(0, 200)}`, res.ok ? 'ok' : 'err');
    await loadRepowise();
  } catch (err) {
    state.repowiseOutput = `Ошибка: ${err.message}`;
    toast(`Repowise: ${err.message}`, 'err');
    render();
  }
}

async function repowiseQuery(kind) {
  const query = $('#repowise-query')?.value.trim();
  if (!query) {
    toast('Введите запрос', 'err');
    return;
  }
  state.repowiseOutput =
    kind === 'search'
      ? 'Запрашиваю индекс… Поиск по большому проекту может занять до двух минут.'
      : 'Запрашиваю индекс…';
  render();
  // CLI внутри main имеет таймаут 120 с; страховка в UI не даёт вечному лоадеру,
  // если IPC почему-то не завершится.
  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    state.repowiseOutput = 'Индекс не ответил за две минуты. Проверьте repowise doctor или повторите позже.';
    render();
  }, 130_000);
  try {
    const res = await api.repowise[kind]({ projectDir: state.projectDir, question: query, query });
    if (!timedOut) state.repowiseOutput = res.output || res.error || '(пусто)';
  } catch (err) {
    if (!timedOut) {
      state.repowiseOutput = `Ошибка: ${err.message}`;
      toast(`Repowise: ${err.message}`, 'err');
    }
  } finally {
    clearTimeout(guard);
  }
  render();
}

/* ---------- start ---------- */

boot();
