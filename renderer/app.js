import { renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const api = window.mai;

const state = {
  settings: null,
  models: [],
  sessions: [],
  sessionId: null,
  messages: [],
  toolResults: {},
  live: null,
  running: false,
  projectDir: '',
  model: '',
  renderQueued: false,
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
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function modelLabel(id) {
  return state.models.find((m) => m.id === id)?.name || id || '';
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

  if (!state.messages.length && !state.live) {
    box.append(emptyState());
    return;
  }

  for (const message of state.messages) {
    const node = messageNode(message);
    if (node) box.append(node);
  }
  if (state.live) box.append(liveNode());
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
      el('span', { class: 'session-meta', text: `${session.model || ''} · ${fmtDate(session.updatedAt)}` }),
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
  for (const model of state.models) {
    const label = `${model.name}${model.context ? ` · ${contextLabel(model.context)}` : ''}`;
    select.append(el('option', { value: model.id, text: label }));
  }
  select.value = state.model;
}

function updateChrome() {
  $('#project-name').textContent = shortPath(state.projectDir);
  $('#project-name').title = state.projectDir || '';
  $('#conn').classList.toggle('bad', !state.settings?.apiKeySet);
  $('#conn').querySelector('span').textContent = state.settings?.apiKeySet ? 'MAI подключён' : 'нет ключа';
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
  state.models = result.models;
  if (!state.models.some((m) => m.id === state.model) && state.models[0]) {
    state.model = state.models[0].id;
  }
  renderModels();
}

/* ---------- отправка ---------- */

async function send() {
  if (state.running) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.settings?.apiKeySet) {
    toast('Сначала задайте API-ключ MAI в настройках', 'err');
    openSettings();
    return;
  }
  if (!state.projectDir) {
    toast('Выберите папку проекта', 'err');
    await pickProject();
    return;
  }

  input.value = '';
  autosize();
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

function setRunning(running) {
  $('#send').hidden = running;
  $('#stop').hidden = !running;
  $('#composer-hint').textContent = running ? 'Агент работает…' : '';
}

/* ---------- события агента ---------- */

function handleEvent(event) {
  switch (event.type) {
    case 'delta':
      state.live.content += event.text;
      scheduleRender();
      break;
    case 'reasoning':
      state.live.reasoning += event.text;
      scheduleRender();
      break;
    case 'assistant':
      state.messages.push(event.message);
      state.live = { content: '', reasoning: '', tools: [] };
      scheduleRender();
      break;
    case 'tool_call':
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
  const baseURL = el('input', { value: settings.baseURL });
  const apiKey = el('input', { type: 'password', placeholder: settings.apiKeySet ? 'ключ сохранён (***)' : 'sk-…' });
  const temperature = el('input', { type: 'number', step: '0.1', min: '0', max: '2', value: settings.temperature });
  const maxIterations = el('input', { type: 'number', min: '1', max: '100', value: settings.maxIterations });
  const outside = el('input', { type: 'checkbox' });
  outside.checked = Boolean(settings.allowOutsideProject);

  const modal = openModal({
    title: 'Настройки',
    body: [
      field('Base URL (OpenAI-совместимый шлюз)', baseURL),
      field('API-ключ', apiKey),
      el('div', { class: 'row' }, [
        field('Температура', temperature),
        field('Максимум шагов агента', maxIterations),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: 'Доступ к файлам вне проекта' }),
        el('label', { class: 'hint-text' }, [outside, ' разрешить абсолютные пути вне папки проекта']),
      ]),
      el('p', { class: 'hint-text', text: 'Ключ хранится локально в %APPDATA%\\mai-code\\settings.json' }),
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
          const patch = {
            baseURL: baseURL.value.trim(),
            temperature: Number(temperature.value),
            maxIterations: Number(maxIterations.value),
            allowOutsideProject: outside.checked,
          };
          if (apiKey.value.trim()) patch.apiKey = apiKey.value.trim();
          state.settings = await api.settings.save(patch);
          updateChrome();
          await loadModels(true);
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
  state.model = state.settings.model || 'deepseek-v4.1-flash';
  updateChrome();
  renderModels();
  await loadModels();
  await refreshSessions();
  renderAll();

  api.chat.onEvent(handleEvent);

  $('#new-chat').addEventListener('click', newChat);
  $('#project-btn').addEventListener('click', pickProject);
  $('#settings-btn').addEventListener('click', openSettings);
  $('#send').addEventListener('click', send);
  $('#stop').addEventListener('click', () => api.chat.stop());
  $('#model-select').addEventListener('change', async (event) => {
    state.model = event.target.value;
    state.settings = await api.settings.save({ model: state.model });
  });

  for (const button of document.querySelectorAll('[data-panel]')) {
    button.addEventListener('click', () => {
      const panel = button.dataset.panel;
      if (panel === 'agents') openAgents();
      if (panel === 'skills') openSkills();
      if (panel === 'mcp') openMcp();
      if (panel === 'plugins') openPlugins();
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
      navigator.clipboard.writeText(code).then(() => {
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
