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
  liveRuntime: null,
  running: false,
  projectDir: '',
  model: '',
  runtime: 'agent',
  runtimes: {},
  renderQueued: false,
  auth: null,
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
  if (state.runtime === 'agent') return null;
  return state.runtimes[state.runtime] || null;
}

/* ---------- модальные окна ---------- */

function openModal({ title, body, footer, small = false, onClose }) {
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
  const modal = el('div', { class: `modal${small ? ' small' : ''}` }, [head, bodyEl, footEl]);
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

  if (!state.messages.length && !state.live && !state.liveRuntime) {
    box.append(emptyState());
    return;
  }

  for (const message of state.messages) {
    const node = messageNode(message);
    if (node) box.append(node);
  }
  if (state.live) box.append(liveNode());
  if (state.liveRuntime) box.append(runtimeNode(state.liveRuntime.name, state.liveRuntime.output, null, true));
  if (stick) box.scrollTop = box.scrollHeight;
}

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

function messageNode(message) {
  if (message.role === 'user') {
    return el('div', { class: 'msg msg-user' }, [
      el('div', { class: 'bubble', text: message.content || '' }),
    ]);
  }
  if (message.role === 'runtime') {
    return runtimeNode(message.name || 'Рантайм', message.content || '', message.code, false);
  }
  if (message.role === 'assistant') {
    const body = el('div', { class: 'msg-body' }, [
      el('div', { class: 'msg-name', text: `MAI · ${modelLabel(state.model)}` }),
    ]);
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

function toolCard(id, name, argsText) {
  const result = state.toolResults[id];
  const status = result ? (result.ok ? 'ok' : 'err') : 'run';
  const card = el('div', { class: `tool-card${result && !result.ok ? ' open' : ''}` });
  const head = el('div', { class: 'tool-head' }, [
    el('span', { class: `tool-dot ${status}` }),
    el('span', { class: 'tool-name', text: name }),
    el('span', { class: 'tool-args', text: String(argsText || '').slice(0, 160) }),
  ]);
  head.addEventListener('click', () => card.classList.toggle('open'));
  const body = el('div', { class: 'tool-body' });
  body.append(el('div', { class: 'tool-label', text: 'Аргументы' }));
  body.append(el('pre', { text: String(argsText || '') }));
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
  for (const [id, runtime] of Object.entries(state.runtimes)) {
    const disabled = runtime.enabled === false;
    const option = el('option', {
      value: id,
      text: `${runtime.name || id}${disabled ? ' (выкл.)' : ''}`,
    });
    if (disabled) option.disabled = true;
    select.append(option);
  }
  if (state.runtime !== 'agent' && !state.runtimes[state.runtime]) state.runtime = 'agent';
  select.value = state.runtime;
}

function updateChrome() {
  $('#project-name').textContent = shortPath(state.projectDir);
  $('#project-name').title = state.projectDir || '';
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
  state.toolResults = {};
  state.live = null;
  state.liveRuntime = null;
  for (const message of state.messages) {
    if (message.role === 'tool' && message.tool_call_id) {
      state.toolResults[message.tool_call_id] = {
        ok: !String(message.content || '').startsWith('Ошибка'),
        content: message.content,
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
  state.live = null;
  state.liveRuntime = null;
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

async function send() {
  if (state.running) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;

  const runtime = activeRuntime();
  if (!runtime) {
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

  if (runtime) {
    await sendRuntime(runtime, text);
    return;
  }

  state.messages.push({ role: 'user', content: text });
  state.live = { content: '', reasoning: '', tools: [] };
  state.running = true;
  setRunning(true);
  renderAll();

  const result = await api.chat.start({
    sessionId: state.sessionId,
    text,
    model: state.model,
    projectDir: state.projectDir,
  });
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
}

async function sendRuntime(runtime, text) {
  state.messages.push({ role: 'user', content: text });
  state.liveRuntime = { name: runtime.name || 'Рантайм', output: '' };
  state.running = true;
  setRunning(true);
  renderAll();

  const result = await api.runtimes.run({
    sessionId: state.sessionId,
    runtime: state.runtime,
    text,
    model: state.model,
    projectDir: state.projectDir,
  });

  if (!result.ok) {
    toast(result.error, 'err');
    state.running = false;
    state.liveRuntime = null;
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
    ? state.liveRuntime
      ? 'Рантайм работает…'
      : 'Агент работает…'
    : '';
}

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
      state.toolResults[event.id] = { ok: event.ok, content: event.content };
      scheduleRender();
      break;
    case 'approval':
      askApproval(event);
      break;
    case 'done':
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
    case 'runtime:start':
      if (state.liveRuntime) state.liveRuntime.name = event.name;
      scheduleRender();
      break;
    case 'runtime:chunk':
      if (state.liveRuntime) {
        state.liveRuntime.output += event.text;
        scheduleRender();
      }
      break;
    case 'runtime:exit': {
      const name = event.name || state.liveRuntime?.name || 'Рантайм';
      const output = event.output ?? state.liveRuntime?.output ?? '';
      state.liveRuntime = null;
      state.running = false;
      setRunning(false);
      state.messages.push({ role: 'runtime', name, content: output, code: event.code });
      if (event.sessionId) state.sessionId = event.sessionId;
      if (event.error) toast(event.error, 'err');
      renderAll();
      refreshSessions();
      break;
    }
    default:
      break;
  }
}

function askApproval(event) {
  const body = [
    el('p', { text: 'Агент просит разрешение на действие:' }),
    el('div', { class: 'approve-args', text: event.summary }),
    el('p', { class: 'hint-text', text: `Инструмент: ${event.name}` }),
  ];
  const modal = openModal({
    title: 'Подтверждение',
    body,
    small: true,
    footer: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Отклонить',
        onclick: () => {
          api.chat.approve(event.id, false);
          modal.close();
        },
      }),
      el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Разрешить',
        onclick: () => {
          api.chat.approve(event.id, true);
          modal.close();
        },
      }),
    ],
  });
}

/* ---------- настройки ---------- */

async function openSettings() {
  const settings = state.settings;
  const temperature = el('input', { type: 'number', step: '0.1', min: '0', max: '2', value: settings.temperature });
  const maxIterations = el('input', { type: 'number', min: '1', max: '100', value: settings.maxIterations });
  const outside = el('input', { type: 'checkbox' });
  outside.checked = Boolean(settings.allowOutsideProject);

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
  const projectArea = el('textarea', { rows: '14', placeholder: 'Уроки и решения этого проекта…' });
  projectArea.value = data.project;
  const globalArea = el('textarea', { rows: '8', placeholder: 'Общие уроки для всех проектов…' });
  globalArea.value = data.global;

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
            await api.memory.write(data.projectFile, projectArea.value);
            await api.memory.write(data.globalFile, globalArea.value);
            modal.close();
            toast('Память сохранена', 'ok');
          } catch (err) {
            toast(`Память: ${err.message}`, 'err');
          }
        },
      }),
    ],
  });
}

/* ---------- доступ и роли ---------- */

function applyRoleGuard() {
  const admin = !state.auth || state.auth.role === 'admin';
  document.body.classList.toggle('role-guest', !admin);
  for (const panel of ['providers', 'runtimes', 'skills', 'agents', 'memory', 'plugins']) {
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
  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = runtime.enabled !== false;

  const modal = openModal({
    title: id ? `Рантайм: ${runtime.name || id}` : 'Новый рантайм',
    body: [
      el('div', { class: 'row' }, [field('ID', idInput), field('Название', nameInput)]),
      field('Команда', commandInput),
      field('Аргументы (по одному в строке)', argsArea),
      el('div', { class: 'row' }, [field('Цель {target} (herdr)', targetInput), field('Формат вывода', parserSelect)]),
      el('label', { class: 'hint-text' }, [enabled, ' показывать в списке рантаймов']),
      el('p', {
        class: 'hint-text',
        text: 'Подстановки: {prompt}, {model}, {projectDir}, {target}. Если {prompt} не указан, запрос добавится последним аргументом.',
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
  const list = el('div', { class: 'list' });
  const entries = Object.entries(state.runtimes);
  if (!entries.length) list.append(el('p', { class: 'hint-text', text: 'Рантаймов нет.' }));
  for (const [id, runtime] of entries) {
    const badge = el('span', {
      class: `badge ${runtime.enabled === false ? '' : 'ok'}`,
      text: runtime.enabled === false ? 'выключен' : 'включён',
    });
    list.append(
      el('div', { class: 'list-item' }, [
        el('div', {}, [
          el('div', { class: 'title' }, [runtime.name || id, ' ', badge]),
          el('div', { class: 'sub', text: [runtime.command, ...(runtime.args || [])].join(' ') || 'команда не задана' }),
        ]),
        el('div', { class: 'actions' }, [
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
        text: 'Внешний агент запускается как процесс в папке проекта. Выберите его в списке рядом с моделью и отправьте запрос.',
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

/* ---------- MCP ---------- */

async function openMcp() {
  const status = await api.mcp.status();
  const servers = state.settings.mcpServers || {};
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
              const res = await api.mcp.connect(name);
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
          await api.mcp.sync();
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

/* ---------- проект ---------- */

async function pickProject() {
  const dir = await api.project.pick();
  if (!dir) return;
  state.projectDir = dir;
  updateChrome();
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
    state.auth = await api.auth.status();
  } catch {
    state.auth = null;
  }
  updateChrome();
  applyRoleGuard();
  renderModels();
  renderRuntimes();
  await loadModels();
  await refreshSessions();
  renderAll();

  api.chat.onEvent(handleEvent);

  $('#new-chat').addEventListener('click', newChat);
  $('#project-btn').addEventListener('click', pickProject);
  $('#new-project-btn').addEventListener('click', newProjectModal);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#send').addEventListener('click', send);
  $('#stop').addEventListener('click', () => {
    if (state.liveRuntime) api.runtimes.stop();
    else api.chat.stop();
  });

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
      if (panel === 'auth') openAuth();
    });
  }

  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

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
