/**
 * UI-тест: загружает настоящий renderer/index.html в окно Electron и проверяет,
 * что селектор режимов отрисован и заполнен.
 *
 * IPC-каналы подменены заглушками: тест проверяет фронтенд, а не бэкенд.
 * Запуск: npx electron scripts/test-ui.mjs
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleBarOptions } from '../electron/lib/window.js';
import { loadBoards } from '../electron/lib/boards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-ui-'));
app.setPath('userData', sandbox);
app.disableHardwareAcceleration();

// Заглушки: фронтенд не должен падать из-за отсутствия бэкенда.
const MODES = [
  { id: 'manual', label: 'Вручную', description: 'Спрашивать всегда' },
  { id: 'acceptEdits', label: 'Принимать правки', description: 'Правки без вопросов' },
  { id: 'plan', label: 'План', description: 'Только чтение и план' },
  { id: 'dontAsk', label: 'Только разрешённое', description: 'Только по правилам' },
  { id: 'bypass', label: 'Без вопросов', description: 'Всё без подтверждения', warning: true, adminOnly: true, disabled: true },
];
// Доверие к папке (раздел [15]): выбранная папка не доверена, в ней плагин и MCP.
const trustCalls = [];
let trustStateValue = 'trusted';
const PICKED = path.join(os.tmpdir(), 'mai-ui-untrusted');
ipcMain.handle('trust:get', (_e, dir) => ({
  projectDir: dir,
  state: dir === PICKED ? trustStateValue : 'trusted',
  folder: dir,
  inherited: false,
  found: { plugins: 1, mcpServers: ['fs'], agents: true, memory: false, skills: 0, executable: true },
}));
ipcMain.handle('trust:set', (_e, payload) => {
  trustCalls.push(payload);
  trustStateValue = payload.state;
  return { ok: true, projectDir: payload.projectDir, state: payload.state };
});
ipcMain.handle('trust:list', () => []);
ipcMain.handle('project:pick', () => {
  trustStateValue = 'unknown';
  return PICKED;
});
// Ответы на запросы разрешения из окна (раздел [14]).
const approvals = [];
// Слэш-команды и @файл (раздел [19]).
const expandCalls = [];
ipcMain.handle('commands:list', () => [
  { name: 'help', description: 'Список команд', source: 'builtin' },
  { name: 'clear', description: 'Новый чат', source: 'builtin' },
  { name: 'mode', description: 'Режим', argumentHint: '<режим>', source: 'builtin' },
  { name: 'init', description: 'AGENTS.md', source: 'builtin' },
  { name: 'review', description: 'Ревью изменений', argumentHint: '<путь>', source: 'project' },
  { name: 'handoff', description: 'навык передачи', argumentHint: '<задача>', source: 'skill' },
  { name: 'mcp__db__review', description: 'Ревью кода', argumentHint: '<file> [focus]', source: 'mcp' },
]);
// Ресурсы MCP (раздел [42]).
ipcMain.handle('mcp:resources', () => [{ server: 'db', uri: 'db://schema', name: 'Схема', description: '', mimeType: 'text/plain' }]);
ipcMain.handle('commands:expand', (_e, payload) => {
  expandCalls.push(payload);
  return { ok: true, prompt: `Ревью ${payload.args}` };
});
ipcMain.handle('files:search', (_e, payload) => (String(payload.query).startsWith('sr') ? ['src/', 'src/app.js', 'scripts/sr.mjs'] : []));
// Контекст и компакция (раздел [20]).
const compactCalls = [];
ipcMain.handle('context:stats', () => ({
  window: 128000,
  used: 96000,
  exact: true,
  parts: [
    { key: 'system', label: 'Системный промпт, AGENTS.md, память', tokens: 8000 },
    { key: 'tool', label: 'Результаты инструментов', tokens: 70000 },
  ],
}));
ipcMain.handle('chat:compact', (_e, payload) => {
  compactCalls.push(payload);
  return { ok: true, marker: { role: 'compaction', content: 'сводка', messages: 12 }, messages: [{ role: 'compaction', content: '**сводка** работы', messages: 12 }] };
});
// Чекпоинты и откат (раздел [21]).
const rewindCalls = [];
ipcMain.handle('checkpoints:turns', () => [{ turn: 0, files: 2 }]);
ipcMain.handle('checkpoints:plan', () => ({
  ok: true,
  text: 'Покажи отчёт',
  later: 2,
  files: [
    { file: 'src/a.js', action: 'restore', changed: true },
    { file: 'src/new.js', action: 'delete', changed: true },
  ],
}));
ipcMain.handle('checkpoints:rewind', (_e, payload) => {
  rewindCalls.push(payload);
  return { ok: true, mode: payload.mode, text: 'Покажи отчёт', messages: [], restored: ['a', 'b'], failed: [] };
});
const memoryAppends = [];
ipcMain.handle('memory:append', (_e, payload) => {
  memoryAppends.push(payload);
  return { ok: true, changed: true, scope: payload.scope };
});
ipcMain.handle('hooks:list', () => ({
  rows: [{ event: 'PreToolUse', matcher: 'write_file', command: 'node check.js', timeout: 30, source: 'project' }],
  trusted: true,
  projectFile: '/p/.mai-code/hooks.json',
}));
ipcMain.handle('agents:defs', () => [
  { name: 'explore', description: 'Исследователь', tools: ['read_file'], source: 'builtin' },
  { name: 'reviewer', description: 'Ревьюер', tools: null, source: 'project' },
]);
// Пакеты (раздел [25]).
const packageCalls = [];
ipcMain.handle('packages:list', () => ({
  packages: [{ name: 'review-kit', version: '1.2.0', description: 'Ревью кода', source: 'global', enabled: true, executable: true, parts: { commands: 2, agents: 1, skills: 0, plugins: 1, hooks: true, mcp: 0 } }],
  trusted: true,
  globalDir: '/data/packages',
}));
ipcMain.handle('packages:install', (_e, payload) => {
  packageCalls.push({ type: 'install', ...payload });
  return { ok: true, package: { name: 'git-kit', parts: { commands: 1 } } };
});
ipcMain.handle('packages:toggle', (_e, payload) => {
  packageCalls.push({ type: 'toggle', ...payload });
  return { ok: true };
});
const answers = [];
ipcMain.handle('chat:answer', (_e, payload) => {
  answers.push(payload);
  return true;
});
ipcMain.handle('chat:approval', (_e, payload) => {
  approvals.push(payload);
  return true;
});

ipcMain.handle('settings:get', () => ({
  projectDir: root,
  activeModel: 'test-model',
  permissionMode: 'manual',
  // Провайдер «с ключом»: send() доходит до chat:start (мок ниже отвечает отказом).
  providers: { 'test-model': { name: 'Test', apiKeySet: true, models: [] } },
  models: [],
}));
ipcMain.handle('runtimes:list', () => ({}));
// MCP с OAuth (раздел [28]).
const mcpCalls = [];
let mcpLogged = false;
ipcMain.handle('mcp:status', () => [
  { name: 'remote', status: mcpLogged ? 'ready' : 'needs_auth', error: '', tools: mcpLogged ? ['whoami'] : [], loggedIn: mcpLogged },
  { name: 'local', status: 'ready', error: '', tools: ['ls'], loggedIn: false },
]);
ipcMain.handle('mcp:configs', () => ({ remote: { url: 'https://mcp.example.com/mcp' }, local: { command: 'node' } }));
ipcMain.handle('mcp:scopes', () => ({ remote: 'global', local: 'local' }));
ipcMain.handle('mcp:saveLocal', (_e, payload) => {
  mcpCalls.push({ type: 'saveLocal', ...payload });
  return { ok: true };
});
ipcMain.handle('mcp:login', (_e, name) => {
  mcpCalls.push({ type: 'login', name });
  mcpLogged = true;
  return { ok: true, tools: ['whoami'] };
});
ipcMain.handle('mcp:logout', (_e, name) => {
  mcpCalls.push({ type: 'logout', name });
  mcpLogged = false;
  return { ok: true };
});
// Каталоги пакетов (раздел [29]).
const marketCalls = [];
let marketState = [
  {
    name: 'team',
    url: 'https://git.example.com/catalog.git',
    description: 'Пакеты команды',
    error: '',
    packages: [
      { name: 'review-kit', version: '1.3.0', description: 'Ревью', installedVersion: '1.2.0', updateAvailable: true },
      { name: 'docs-kit', version: '0.1.0', description: 'Документация', installedVersion: null, updateAvailable: false },
      { name: 'git-kit', version: '0.4.0', description: '', installedVersion: '0.4.0', updateAvailable: false },
    ],
  },
];
ipcMain.handle('marketplace:list', () => ({ marketplaces: marketState }));
ipcMain.handle('marketplace:install', (_e, payload) => {
  marketCalls.push({ type: 'install', ...payload });
  const entry = marketState[0].packages.find((p) => p.name === payload.name);
  entry.installedVersion = entry.version;
  entry.updateAvailable = false;
  return { ok: true, package: { name: entry.name, version: entry.version, parts: { commands: 1 } }, marketplaces: marketState };
});
ipcMain.handle('marketplace:add', (_e, payload) => {
  marketCalls.push({ type: 'add', ...payload });
  return { ok: true, marketplaces: marketState };
});
// Корзина (раздел [30]).
const trashCalls = [];
let trashItems = [
  { id: '1700000000000-aaaaaaaa', name: 'old.js', original: '/p/src/old.js', deletedAt: '2026-11-21T10:00:00.000Z', bytes: 2048, files: 1, dir: false },
  { id: '1700000000001-bbbbbbbb', name: 'build', original: '/p/build', deletedAt: '2026-11-21T11:00:00.000Z', bytes: 9000, files: 12, dir: true },
];
ipcMain.handle('trash:list', () => ({ items: trashItems, dir: '/data/trash' }));
ipcMain.handle('trash:restore', (_e, payload) => {
  trashCalls.push({ type: 'restore', ...payload });
  trashItems = trashItems.filter((i) => i.id !== payload.id);
  return { ok: true };
});
// Рабочие папки чата (раздел [31]).
const dirCalls = [];
let extraDirs = [{ name: 'Документы', dir: '/home/u/Документы', primary: false }];
ipcMain.handle('session:dirs', (_e, sessionId) => {
  dirCalls.push({ type: 'dirs', sessionId });
  return { ok: true, roots: [{ name: 'proj', dir: '/p/proj', primary: true }, ...extraDirs], missing: ['/gone/old'] };
});
ipcMain.handle('session:addDir', (_e, sessionId) => {
  dirCalls.push({ type: 'add', sessionId });
  extraDirs = [...extraDirs, { name: 'Финансы', dir: '/home/u/Финансы', primary: false }];
  return { ok: true };
});
ipcMain.handle('session:removeDir', (_e, payload) => {
  dirCalls.push({ type: 'remove', ...payload });
  extraDirs = extraDirs.filter((d) => d.dir !== payload.dir);
  return { ok: true };
});
// «Код / Задача» (раздел [32]).
const kindCalls = [];
let kindNow = 'code';
ipcMain.handle('session:kind', (_e, sessionId) => ({ kind: kindNow, sessionId }));
ipcMain.handle('session:setKind', (_e, payload) => {
  kindCalls.push(payload);
  kindNow = payload.kind;
  return { ok: true, kind: payload.kind, scope: payload.sessionId ? 'session' : 'default' };
});
// Результаты задачи (раздел [33]).
const resultCalls = [];
ipcMain.handle('results:list', (_e, sessionId) =>
  sessionId === 's-dirs'
    ? [
        { file: '/p/отчёт.md', name: 'отчёт.md', status: 'created', size: 2048, turn: 2, openable: true, text: true },
        { file: '/p/run.bat', name: 'run.bat', status: 'created', size: 10, turn: 2, openable: false, text: false },
        { file: '/p/old.txt', name: 'old.txt', status: 'deleted', size: 0, turn: 1, openable: false, text: true },
      ]
    : [],
);
ipcMain.handle('results:preview', (_e, payload) => {
  resultCalls.push({ type: 'preview', ...payload });
  return { ok: true, preview: '# Отчёт за квартал' };
});
ipcMain.handle('results:open', (_e, payload) => {
  resultCalls.push({ type: 'open', ...payload });
  return { ok: true };
});
ipcMain.handle('results:show', (_e, payload) => {
  resultCalls.push({ type: 'show', ...payload });
  return { ok: true };
});
// Плановые задачи (раздел [35]).
const schedCalls = [];
let schedTasks = [{ id: 't1', title: 'Сводка', prompt: 'Собери сводку', projectDir: '/p', kind: 'task', enabled: true, description: 'по будням в 09:00', nextRun: '2026-11-23T06:00:00.000Z', lastRun: '2026-11-21T06:00:00.000Z', lastStatus: 'ok' }];
ipcMain.handle('schedule:list', () => ({ tasks: schedTasks }));
ipcMain.handle('schedule:save', (_e, payload) => {
  schedCalls.push({ type: 'save', ...payload });
  if (payload.id) schedTasks = schedTasks.map((t) => (t.id === payload.id ? { ...t, ...payload } : t));
  else schedTasks = [...schedTasks, { ...payload, id: 't2', enabled: true, description: 'каждый день в 07:30' }];
  return { ok: true, tasks: schedTasks };
});
ipcMain.handle('schedule:runNow', (_e, id) => {
  schedCalls.push({ type: 'run', id });
  return { ok: true, status: 'ok', sessionId: 's-sched' };
});
ipcMain.handle('schedule:runs', (_e, id) => [{ at: '2026-11-21T06:00:00.000Z', taskId: id, status: 'ok', reason: 'schedule', summary: 'Сводка готова', sessionId: 's-sched' }]);
// Каталог коннекторов (раздел [37]).
const connCalls = [];
let connInstalled = new Set(['notion']);
ipcMain.handle('connectors:list', () => [
  { id: 'linear', name: 'Linear', category: 'Задачи', description: 'Задачи', url: 'https://mcp.linear.app/mcp', auth: 'oauth', docs: 'https://linear.app/docs/mcp', source: 'builtin', installed: connInstalled.has('linear'), status: connInstalled.has('linear') ? 'ready' : '' },
  { id: 'github', name: 'GitHub', category: 'Код', description: 'Репозитории', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', tokenHint: 'github_pat_…', tokenUrl: 'https://github.com/settings/tokens', source: 'builtin', installed: connInstalled.has('github'), status: '' },
  { id: 'notion', name: 'Notion', category: 'Вики', description: 'Страницы', url: 'https://mcp.notion.com/mcp', auth: 'oauth', source: 'builtin', installed: connInstalled.has('notion'), status: 'needs_auth' },
  { id: '1c', name: '1С', category: 'Учёт', description: 'Наш 1С', url: 'https://1c.corp/mcp', auth: 'token', source: 'managed', installed: false, status: '' },
]);
// Онбординг и наборы ролей (раздел [41]).
const roleCalls = [];
ipcMain.handle('roles:list', () => ({
  roles: [
    { id: 'developer', title: 'Разработчик', icon: '💻', summary: 'Код и тесты', connectors: ['github', 'linear'], examples: ['Напиши тесты'], package: 'role-developer', installed: false },
    { id: 'finance', title: 'Финансы', icon: '💰', summary: 'Бюджеты', connectors: [], examples: ['Сверь выписку банка с реестром', 'Построй бюджет'], package: 'role-finance', installed: true },
  ],
  onboarding: null,
}));
ipcMain.handle('roles:install', (_e, id) => {
  roleCalls.push(id);
  return { ok: true, role: { id }, package: { name: `role-${id}`, parts: { skills: 1, commands: 1 } } };
});
const localCalls = [];
const boardOpens = [];
ipcMain.handle('boards:open', (_e, payload) => {
  boardOpens.push(payload);
  return 1;
});
let rwOn = false;
ipcMain.handle('connectors:local', () => [
  { id: 'repowise', name: 'Repowise', description: 'Индекс кода', status: rwOn ? 'ready' : 'off', detail: '', action: { kind: 'toggle', enabled: rwOn, label: rwOn ? 'Выключить' : 'Включить' }, category: 'Локальные', local: true },
  { id: 'multica', name: 'Multica', description: 'Задачи', status: 'missing', detail: 'CLI не найден', action: { kind: 'open', target: 'panel:multica', label: 'Установить' }, category: 'Локальные', local: true },
  { id: 'postgres', name: 'Postgres', description: 'Артефакты', status: 'ready', detail: 'PostgreSQL 16', action: { kind: 'open', target: 'storage:infra', label: 'Настроить' }, category: 'Локальные', local: true },
]);
ipcMain.handle('connectors:localToggle', (_e, payload) => {
  localCalls.push(`${payload.id}:${payload.enabled}`);
  rwOn = payload.enabled;
  return { ok: true };
});
ipcMain.handle('connectors:add', (_e, payload) => {
  connCalls.push({ type: 'add', ...payload });
  connInstalled.add(payload.id);
  return { ok: true, tools: ['a', 'b'] };
});
ipcMain.handle('connectors:remove', (_e, id) => {
  connCalls.push({ type: 'remove', id });
  connInstalled.delete(id);
  return { ok: true };
});
// Глубина рассуждений (раздел [38]).
ipcMain.handle('models:caps', (_e, key) => ({ id: key, tools: true, vision: false, reasoning: true, effort: ['low', 'medium', 'high'], temperature: false, transport: 'auto', context: null }));
// Проекты (раздел [40]).
const projCalls = [];
let projects = [{ id: 'pr1', name: 'Отчётность', primaryDir: '/p/reports', extraDirs: ['/p/exports'], instructions: 'для финдиректора', connectors: ['gmail'], kind: 'task' }];
let activeProject = null;
let picks = ['/p/new-main', '/p/new-extra'];
ipcMain.handle('projects:list', () => ({ projects, active: activeProject }));
ipcMain.handle('projects:pickDir', () => picks.shift() || null);
ipcMain.handle('projects:save', (_e, payload) => {
  projCalls.push({ type: 'save', ...payload });
  const project = { ...payload, id: payload.id || 'pr2', extraDirs: payload.extraDirs || [], connectors: payload.connectors || [] };
  projects = [...projects.filter((p) => p.id !== project.id), project];
  return { ok: true, project };
});
ipcMain.handle('projects:activate', (_e, id) => {
  projCalls.push({ type: 'activate', id });
  activeProject = id;
  return { ok: true, project: projects.find((p) => p.id === id) || null };
});
const savedSettings = [];
ipcMain.handle('settings:save', (_e, patch) => {
  savedSettings.push(patch);
  return { projectDir: root, activeModel: 'test-model', permissionMode: 'manual', providers: { 'test-model': { name: 'Test', apiKeySet: true, models: [] } }, models: [], ...patch };
});
// Корпоративный режим (раздел [55], F21): флаг включает «только вход».
let corporate = false;
let corporateLoggedIn = false;
const loginCalls = [];
ipcMain.handle('auth:status', () => (corporate ? { required: true, loggedIn: corporateLoggedIn, role: corporateLoggedIn ? 'admin' : 'none', mode: 'keycloak', issuer: 'https://sso.example/realms/mai' } : { authenticated: false, role: 'admin', mode: 'local' }));
ipcMain.handle('auth:login', () => {
  loginCalls.push(Date.now());
  if (loginCalls.length === 1) return { ok: false, error: 'Keycloak не подтвердил вход за отведённое время' };
  corporateLoggedIn = true;
  return { ok: true, loggedIn: true, role: 'admin', user: { name: 'Иван' } };
});
ipcMain.handle('models:list', () => []);
// Сессия с ответом агента: нужна для проверки меню «Скачать» у сообщения.
const TEST_SESSION = {
  id: 'test-session',
  title: 'Тестовый диалог',
  model: 'test-model',
  messages: [
    { role: 'user', content: 'Покажи отчёт', display: 'Покажи отчёт' },
    { role: 'assistant', content: '# Отчёт\n\nТекст ответа с **разметкой**.' },
  ],
};
const sessionListCalls = [];
ipcMain.handle('sessions:list', (_e, options) => {
  sessionListCalls.push(options || {});
  return [{ ...TEST_SESSION, projectDir: root, updatedAt: '2026-11-20T10:00:00Z', count: 1, ...(options?.query ? { match: 'фрагмент с отчётом' } : {}) }];
});
// chat:start записывает запрос и отвечает отказом: прогон не начинается.
const chatStarts = [];
ipcMain.handle('chat:start', (_e, payload) => {
  chatStarts.push(payload);
  return { ok: false, error: 'тест: без прогона' };
});
// Прерванная работа (раздел [36]).
const INTERRUPTED = {
  id: 's-int',
  title: 'Сводка за неделю',
  model: 'test-model',
  run: { status: 'interrupted', startedAt: '2026-11-21T08:00:00.000Z', endedAt: '2026-11-21T08:05:00.000Z' },
  messages: [
    { role: 'user', content: 'Сделай сводку', display: 'Сделай сводку' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'td1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Прочитать', status: 'completed' }, { content: 'Свести', status: 'in_progress' }, { content: 'Сохранить', status: 'pending' }] }) } }] },
    { role: 'tool', tool_call_id: 'td1', content: 'ok' },
  ],
};
ipcMain.handle('sessions:get', (_e, id) => (id === TEST_SESSION.id ? TEST_SESSION : id === INTERRUPTED.id ? INTERRUPTED : null));

// Git: /pr, /security-review, /worktree (раздел [46]).
const wtCalls = [];
ipcMain.handle('worktree:list', () => ({ ok: true, repo: '/repo', items: [{ dir: '/repo', branch: 'main', main: true }, { dir: '/data/wt/fix', branch: 'mai/wt-fix', main: false }] }));
ipcMain.handle('worktree:create', (_e, payload) => {
  wtCalls.push({ type: 'create', ...payload });
  return { ok: true, dir: '/data/wt/new-task', branch: 'mai/wt-new-task', repo: '/repo' };
});
ipcMain.handle('worktree:open', (_e, dir) => {
  wtCalls.push({ type: 'open', dir });
  return { ok: true, dir };
});
ipcMain.handle('worktree:remove', (_e, payload) => {
  wtCalls.push({ type: 'remove', ...payload });
  return { ok: true, branch: 'mai/wt-fix' };
});
// Статусная строка и `!команда` (раздел [45]).
ipcMain.handle('git:branch', () => 'dev');
const directCalls = [];
ipcMain.handle('shell:direct', (_e, payload) => {
  directCalls.push(payload);
  return { ok: true, output: '$ npm test\n\nok\n\n[код 0, 5 мс]' };
});
// Чаты: имя, копия, файл (раздел [43]).
const sessCalls = [];
ipcMain.handle('sessions:rename', (_e, payload) => {
  sessCalls.push({ type: 'rename', ...payload });
  return { ok: true, title: payload.title };
});
ipcMain.handle('sessions:fork', (_e, payload) => {
  sessCalls.push({ type: 'fork', ...payload });
  return { ok: true, id: TEST_SESSION.id, title: `${TEST_SESSION.title} (копия)` };
});
ipcMain.handle('sessions:exportFile', (_e, id) => {
  sessCalls.push({ type: 'export', id });
  return { ok: true, path: '/tmp/x.mai-chat.json' };
});
ipcMain.handle('sessions:importFile', () => {
  sessCalls.push({ type: 'import' });
  return { ok: false, canceled: true };
});
// Экспорт: записываем вызовы, файл не пишем.
const exportCalls = [];
ipcMain.handle('export:message', (_e, payload) => {
  exportCalls.push({ channel: 'message', format: payload?.format, markdown: payload?.markdown });
  return { ok: true, file: 'C:/tmp/test.' + (payload?.format || 'md'), format: payload?.format };
});
ipcMain.handle('export:chat', (_e, payload) => {
  exportCalls.push({ channel: 'chat', format: payload?.format, messages: payload?.messages });
  return { ok: true, file: 'C:/tmp/chat.' + (payload?.format || 'md'), format: payload?.format };
});
// Уровни правил (раздел [26]).
const permCalls = [];
const permRules = {
  managed: { allow: [], ask: [], deny: ['run_shell(curl *)'] },
  global: { allow: ['run_shell(npm test)'], ask: [], deny: [] },
  project: { allow: ['run_shell(npm run lint)'], ask: [], deny: [] },
  local: { allow: ['run_shell(make)'], ask: [], deny: [] },
  session: { allow: [], ask: [], deny: [] },
};
ipcMain.handle('permissions:modes', () => ({
  current: 'manual',
  fallback: 'manual',
  sessionId: null,
  role: 'admin',
  trusted: true,
  modes: MODES,
  rules: permRules,
  managed: { present: true, file: '/etc/mai-code/managed-settings.json', disableBypassMode: true },
  files: { project: '/p/.mai-code/settings.json', local: '/p/.mai-code/settings.local.json' },
}));
ipcMain.handle('permissions:rules', (_e, payload) => {
  permCalls.push({ type: 'rules', ...payload });
  if (payload?.scope === 'local') permRules.local.allow = permRules.local.allow.filter((r) => !(payload.remove || []).includes(r));
  return { ok: true };
});
ipcMain.handle('permissions:explain', (_e, payload) => {
  permCalls.push({ type: 'explain', ...payload });
  return { action: 'deny', rule: 'run_shell(curl *)', levels: ['managed'], reason: 'Запрещено правилом run_shell(curl *)' };
});
ipcMain.handle('permissions:set', (_e, payload) => ({ ok: true, mode: payload?.mode, scope: 'default' }));
ipcMain.handle('attachments:list', () => []);
ipcMain.handle('chat:onEvent', () => {});

// Память: заглушка с историей версий. Вызовы пишем, чтобы проверить действия панели.
const memoryCalls = [];
const memoryVersions = {
  project: [
    { version: 1, at: '2026-11-14T10:00:00.000Z', size: 12, note: 'первая запись', current: false },
    { version: 2, at: '2026-11-15T10:00:00.000Z', size: 20, note: 'сохранение из панели', current: true },
  ],
  global: [],
};
ipcMain.handle('memory:read', () => ({
  project: 'память проекта',
  global: 'глобальная память',
  projectFile: path.join(root, '.mai-code', 'memory.md'),
  globalFile: path.join(sandbox, 'memory.md'),
  versions: memoryVersions,
}));
ipcMain.handle('memory:save', (_e, payload) => {
  memoryCalls.push({ channel: 'save', ...payload });
  return { scope: payload.scope, changed: true, version: 3, versions: memoryVersions[payload.scope] || [] };
});
ipcMain.handle('memory:version', (_e, payload) => {
  memoryCalls.push({ channel: 'version', ...payload });
  return `текст версии ${payload.version}`;
});
ipcMain.handle('memory:restore', (_e, payload) => {
  memoryCalls.push({ channel: 'restore', ...payload });
  return { scope: payload.scope, changed: true, version: 3, versions: [] };
});
// Окно досок грузится в разделе [9]: без заглушки Electron пишет в лог
// «No handler registered for 'boards:load'», и это выглядит как дефект.
// Раздел [16]: доска с задачей из «чужого» boards.json — приоритет с разметкой.
let craftedBoards = null;
const clipboardCalls = [];
ipcMain.handle('app:clipboard', (_e, text) => {
  clipboardCalls.push(text);
  return true;
});
// Агент схем: предложение и «Применить» (раздел [48], F10).
const diagramApplies = [];
ipcMain.handle('boards:views', () => ({ views: Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'sequence', 'er', 'deployment', 'openapi'].map((k) => [k, { title: k.toUpperCase(), mermaid: 'graph TD; A-->B', puml: '' }])), drift: {} }));
ipcMain.handle('boards:diagramChat', () => ({ ok: true, reply: 'Добавил Redis между API и Postgres', changed: true, proposal: { containers: [{ id: 'redis' }] }, baseHash: 'h1', diff: { added: 1, removed: 0, truncated: false, lines: [{ type: '@', text: '@@ строка 3 @@' }, { type: '+', text: '  { "id": "redis" }' }] } }));
ipcMain.handle('boards:diagramApply', (_e, payload) => {
  diagramApplies.push(payload);
  return { ok: true, views: { views: {}, drift: {} } };
});
// Автосинхронизация хранилища (раздел [49], F12).
const syncNowCalls = [];
ipcMain.handle('artifacts:list', () => []);
ipcMain.handle('artifacts:stats', () => ({ total: 0, byKind: {} }));
ipcMain.handle('infra:status', () => ({ postgres: { ok: true, version: 'PostgreSQL 16' }, vault: { ok: false, error: 'Адрес не задан' }, seaweed: { ok: false, error: 'Адрес не задан' }, config: {} }));
ipcMain.handle('infra:syncStatus', () => ({ enabled: true, state: 'retry', changes: 2, attempts: 1, nextAt: new Date(Date.now() + 30000).toISOString(), lastOkAt: '', lastError: 'Postgres: connection refused', lastReport: null }));
ipcMain.handle('infra:syncNow', (_e, payload) => {
  syncNowCalls.push(payload);
  return { enabled: true, state: 'ok', changes: 0, attempts: 0, nextAt: '', lastOkAt: new Date().toISOString(), lastError: '', lastReport: {} };
});
// Repowise: состояние MCP и перезапуск (раздел [50], F13).
let rwRestarts = 1;
ipcMain.handle('repowise:status', () => ({ installed: true, version: 'repowise 1.2', indexed: true, indexPath: '/p/.repowise', mcp: { name: 'repowise', status: 'ready', restarts: rwRestarts, lastRestartAt: '2026-11-23T10:00:00.000Z', lastTimeout: '2026-11-23T10:00:00.000Z · таймаут ask', error: '' } }));
ipcMain.handle('repowise:restartMcp', () => {
  rwRestarts += 1;
  return { ok: true };
});
// Multica → tasks.md (раздел [51], F14).
const multicaPulls = [];
ipcMain.handle('multica:status', () => ({ available: true, version: 'multica 0.4', config: {} }));
ipcMain.handle('multica:issues', () => ({ ok: true, issues: [] }));
// Workspace и проект Multica для папки (E2.3, ADR 0112).
const multicaTargets = [];
const multicaProjectCalls = [];
ipcMain.handle('multica:target', () => ({ workspaceId: 'ws-team', projectId: '', source: { workspaceId: 'project', projectId: '' } }));
ipcMain.handle('multica:workspaces', () => ({ ok: true, workspaces: [{ id: 'ws-team', name: 'Команда', slug: 'team' }, { id: 'ws-own', name: 'Личный', slug: 'own' }] }));
ipcMain.handle('multica:projects', (_e, workspaceId) => {
  multicaProjectCalls.push(workspaceId);
  return { ok: true, projects: workspaceId === 'ws-team' ? [{ id: 'pr-mai', name: 'MAI Code', status: 'in_progress' }] : [] };
});
ipcMain.handle('multica:setTarget', (_e, payload) => {
  multicaTargets.push(payload);
  return { ok: true, file: 'settings.json', multica: { workspaceId: payload.workspaceId, projectId: payload.projectId } };
});
ipcMain.handle('multica:pullStatuses', (_e, projectDir) => {
  multicaPulls.push(projectDir);
  return { ok: true, marked: ['auth: Вход (MAI-1)'], already: [], missing: [], cancelled: ['auth:roles (MAI-3)'], message: 'Multica → OpenSpec: отмечено 1, уже отмечено 0, отменено в Multica 1' };
});
// Калибратор (раздел [52], F15).
let calibrateRuns = 0;
ipcMain.handle('artifacts:get', () => ({ id: 'calibration:architecture', current: 1, meta: { report: { summary: 'Прошлый отчёт', findings: [{ type: 'gap', severity: 'high', title: 'Нет SSO', detail: '', refs: ['PRD'], suggestion: '' }] }, at: '2026-11-22T10:00:00Z' } }));
ipcMain.handle('boards:calibrate', () => {
  calibrateRuns += 1;
  if (calibrateRuns === 1) return { ok: false, error: 'Калибратор не ответил за 180 с', log: ['Контекст собран: 1200 симв.'] };
  return { ok: true, at: '2026-11-23T10:00:00Z', report: { summary: 'Две находки', findings: [{ type: 'gap', severity: 'high', title: 'Нет SSO', detail: 'PRD требует SSO', refs: ['PRD', 'C2'], suggestion: 'Keycloak' }, { type: 'risk', severity: 'low', title: 'Один экземпляр БД', detail: '', refs: [], suggestion: '' }] }, diff: { added: [{ type: 'risk', title: 'Один экземпляр БД' }], resolved: [{ type: 'question', title: 'Кто админ' }], kept: [{ type: 'gap', title: 'Нет SSO' }] }, sameBaseline: false, artifact: { id: 'calibration:architecture', current: 2 }, log: ['Контекст собран', 'Находок: 2'] };
});
// Голос: ошибка на кнопке и повтор (раздел [54], F18).
let voiceUp = false;
const voiceSends = [];
ipcMain.handle('voice:status', () => (voiceUp ? { ok: true, engine: 'mas' } : { ok: false, engine: 'mas', error: 'MAS не запущен. Откройте приложение MAS' }));
ipcMain.handle('voice:transcribe', (_e, payload) => {
  voiceSends.push(payload.wav.byteLength);
  if (voiceSends.length === 1) throw new Error('MAS: HTTP 500');
  return { text: 'надиктованный текст', engine: 'mas', elapsedMs: 900 };
});
// Signoff (раздел [56], N1).
const signoffCalls = [];
ipcMain.handle('signoff:run', (_e, payload) => {
  signoffCalls.push(payload);
  return payload.fail
    ? { ok: true, state: 'failure', context: 'signoff/lint', sha: 'abcdef1234', repo: 'acme/demo', log: ['HEAD abcdef1 (origin/dev)', 'Статус signoff/lint = failure'] }
    : { ok: false, sha: 'abcdef1234', testsFailed: true, output: 'FAIL test-x.mjs', error: 'Тесты не прошли (код 1) — signoff не поставлен', log: ['HEAD abcdef1 (origin/dev)', 'Тесты: npm test'] };
});
// Границы данных (раздел [57], N2).
ipcMain.handle('privacy:report', () => ({ strictLocal: false, counts: { fail: 1, warn: 1, info: 1 }, findings: [{ level: 'fail', area: 'Модели', title: 'Модель чата — облако: OpenAI', detail: 'Запросы уходят на api.openai.com', fix: 'Выберите локальную модель' }, { level: 'warn', area: 'Веб', title: 'Веб-инструменты включены', detail: '…' }, { level: 'info', area: 'MCP', title: 'Локальные MCP-серверы: 1', detail: 'repowise' }], checklist: [{ label: 'модели — локальные', ok: false, detail: 'чата: openai/gpt-5' }, { label: 'телеметрия выключена или локальная', ok: true }] }));
// Локальные модели (раздел [58], N4).
const localAdds = [];
ipcMain.handle('providers:list', () => ({ mai: { name: 'MAI', baseURL: 'https://api-ai.mai.ru/v1', apiKeySet: true, models: [] } }));
ipcMain.handle('localModels:detect', () => [
  { id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', port: 11434, hint: 'ollama serve', models: ['qwen3:8b', 'llama3.2'], empty: false, added: false },
  { id: 'lmstudio', name: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1', port: 1234, hint: 'Start Server', models: [], empty: true, added: false },
]);
ipcMain.handle('localModels:add', (_e, payload) => {
  localAdds.push(payload);
  return { ok: true, id: 'ollama', models: 2 };
});
// Обновления (раздел [59], N6).
const updateApplies = [];
const updateReport = { at: '2026-11-23T10:00:00Z', npmChecked: true, counts: { high: 1, medium: 1, low: 0, info: 0 }, errors: [], items: [
  { source: 'npm', kind: 'security', name: 'tar', risk: 'high', note: 'Arbitrary file overwrite — есть исправление (npm audit fix)' },
  { source: 'npm', kind: 'update', name: 'openai', current: '6.49.0', latest: '6.50.0', bump: 'minor', risk: 'medium', note: '' },
] };
ipcMain.handle('updates:last', () => null);
ipcMain.handle('updates:scan', () => ({ ok: true, report: updateReport }));
ipcMain.handle('updates:apply', (_e, payload) => {
  updateApplies.push(payload);
  return { ok: true, branch: 'mai/update-deps-202611231000', dir: '/wt/deps', installOk: true, testsRun: true, testsOk: true, command: 'npm test', output: 'Итог: 10 OK' };
});
// Чистильщик (раздел [60], N7).
const cleanupCalls = [];
ipcMain.handle('cleanup:plan', () => ({ stable: true, version: '0.3.0', since: '2026-11-15T10:00:00Z', bytes: 3 * 1024 * 1024, items: [
  { id: 'навык:/d/skills/.previous/impeccable-4.8.1', kind: 'навык', path: '/d/skills/.previous/impeccable-4.8.1', bytes: 2 * 1024 * 1024, ageDays: 20, reason: 'старая копия навыка', removable: true },
  { id: 'временное:/tmp/mai-previews', kind: 'временное', path: '/tmp/mai-previews', bytes: 1024 * 1024, ageDays: 3, reason: 'временная папка MAI', removable: true },
  { id: 'worktree:/d/worktrees/r/wt', kind: 'рабочая копия', path: '/d/worktrees/r/wt', bytes: 10, ageDays: 30, reason: 'удалите через /worktree', removable: false },
] }));
ipcMain.handle('cleanup:apply', (_e, payload) => {
  cleanupCalls.push(payload.ids);
  return { ok: true, removed: payload.ids, skipped: [], bytes: 2 * 1024 * 1024, freed: '2,0 МБ' };
});
ipcMain.handle('boards:load', () => ({
  boards: craftedBoards || loadBoards(root),
  projectDir: root,
  settings: { projectDir: root, activeModel: 'test-model' },
}));

app.whenReady().then(async () => {
  // Как в приложении: тема по умолчанию — тёмная (ADR 0074), а не системная.
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    show: false,
    width: Number(process.env.MAI_UI_WIDTH) || 1200,
    height: 800,
    ...titleBarOptions(),
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Как в приложении (A2.5): preload работает в песочнице.
      sandbox: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload: ${err?.message}`));

  try {
    await win.loadFile(path.join(root, 'renderer', 'index.html'));
    // Даём app.js время выполнить init().
    await new Promise((r) => setTimeout(r, 2500));
    // Снимок окна для ручной проверки вида: MAI_UI_SHOT=папка (не входит в проверки).
    if (process.env.MAI_UI_SHOT) {
      win.setSize(1280, 800);
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'main.png'), (await win.webContents.capturePage()).toPNG());
      // Снимок для README: те же элементы, подписи тестовых заглушек — на примеры.
      win.setSize(1424, 880);
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#runner-chip .runner-name').textContent = 'MAI · DeepSeek V4.1 Flash';
        document.querySelector('#conn span').textContent = 'MAI подключён';
        document.querySelector('#project-name').textContent = 'Desktop\\\\mai-code';
        const st = document.querySelector('#statusline'); if (st) st.textContent = 'DeepSeek V4.1 Flash · Вручную · ⎇ dev';
        const box = document.querySelector('#sessions');
        const rows = [['Разобрать структуру проекта', '22:31'], ['Обновить зависимости на ветке', '21:05'], ['Тесты для модуля оплаты', 'вчера'], ['Отчёт: куда уходят данные', '22.11']];
        document.querySelector('#toasts')?.replaceChildren();
        box.innerHTML = rows.map(([t, d], i) => '<button class="session' + (i ? '' : ' active') + '" type="button"><span class="session-title">' + t + '</span><span class="session-meta">DeepSeek V4.1 Flash · ' + d + '</span></button>').join('');
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'readme.png'), (await win.webContents.capturePage()).toPNG());
      // Панель «Провайдеры» для README — открыта, как пользователь: чип «Кто выполняет» → «Провайдеры…».
      await win.webContents.executeJavaScript(`document.querySelector('#runner-chip').click(); document.querySelector('#runner-pop [data-panel="providers"]')?.click()`);
      await new Promise((r) => setTimeout(r, 600));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'providers.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
      win.setSize(1280, 800);
      await win.webContents.executeJavaScript(`document.querySelector('#turn-chip')?.click()`);
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'turn-pop.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('#turn-chip')?.click()`);
      for (const [id, file] of [['#runner-chip', 'runner.png'], ['#project-menu-btn', 'project-menu.png'], ['#connections-menu-btn', 'connections-menu.png'], ['#project-btn', 'sidebar-menu.png']]) {
        await win.webContents.executeJavaScript(`document.querySelector('${id}')?.click()`);
        await new Promise((r) => setTimeout(r, 300));
        fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, file), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.body.click()`);
      }
      await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.focus(); i.value = '/'; i.setSelectionRange(1, 1); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'slash.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await win.webContents.executeJavaScript(`document.querySelector('#settings-btn').click()`);
      await new Promise((r) => setTimeout(r, 600));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'settings.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('.settings-tab[data-tab="Обслуживание"]')?.click()`);
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(process.env.MAI_UI_SHOT, 'settings-care.png'), (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
    }

    console.log('\n[1] Селектор режимов в DOM');
    // С N9 режим — в окне чипа хода: открываем его, как пользователь.
    await win.webContents.executeJavaScript(`document.querySelector('#turn-chip')?.click()`);
    await new Promise((r) => setTimeout(r, 200));
    const info = await win.webContents.executeJavaScript(`(() => {
      const sel = document.querySelector('#mode-select');
      if (!sel) return { found: false };
      const rect = sel.getBoundingClientRect();
      const style = getComputedStyle(sel);
      return {
        found: true,
        options: [...sel.options].map((o) => ({ value: o.value, text: o.text })),
        value: sel.value,
        visible: rect.width > 0 && rect.height > 0,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
      };
    })()`);

    check('элемент #mode-select существует', info.found === true);
    check('селектор виден (есть размеры)', info.visible === true, JSON.stringify(info));
    check('display не none', info.display !== 'none', info.display);
    check('visibility не hidden', info.visibility !== 'hidden', info.visibility);
    check('opacity не 0', info.opacity !== '0', info.opacity);
    check('селектор в пределах окна', info.inViewport === true, JSON.stringify(info));
    check('опций 5', info.options?.length === 5, JSON.stringify(info.options));
    await win.webContents.executeJavaScript(`document.body.click()`);
    check(
      'подписи режимов на месте',
      info.options?.map((o) => o.text).join(',') === 'Вручную,Принимать правки,План,Только разрешённое,⚠ Без вопросов',
      JSON.stringify(info.options),
    );
    const bypassDisabled = await win.webContents.executeJavaScript(
      `document.querySelector('#mode-select option[value="bypass"]')?.disabled === true`,
    );
    check('«Без вопросов» недоступен, если main пометил disabled', bypassDisabled === true);
    check('выбран manual', info.value === 'manual', info.value);

    console.log('\n[1b] Контраст раскрытого списка');
    const contrast = await win.webContents.executeJavaScript(`(() => {
      const lum = (rgb) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(rgb || '');
        if (!m) return null;
        const [r, g, b, a = 1] = m[1].split(',').map((v) => parseFloat(v));
        if (a === 0) return null;
        const f = (c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const sel = document.querySelector('#mode-select');
      const opt = sel.options[0];
      const os = getComputedStyle(opt);
      const ss = getComputedStyle(sel);
      const bg = lum(os.backgroundColor);
      const fg = lum(os.color);
      return {
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        optionBg: os.backgroundColor,
        optionColor: os.color,
        selectBg: ss.backgroundColor,
        contrast: bg === null || fg === null ? null : Math.round(((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)) * 100) / 100,
      };
    })()`);
    check('color-scheme dark', /dark/.test(contrast.colorScheme || ''), contrast.colorScheme);
    check('фон опции не прозрачный', contrast.optionBg !== 'rgba(0, 0, 0, 0)', contrast.optionBg);
    check(
      'контраст текста опции ≥ 4.5',
      typeof contrast.contrast === 'number' && contrast.contrast >= 4.5,
      JSON.stringify(contrast),
    );
    check('фон селектора совпадает с фоном опции', contrast.selectBg === contrast.optionBg, JSON.stringify(contrast));

    console.log('\n[2] API моста доступен');
    const bridge = await win.webContents.executeJavaScript(`(() => ({
      hasMai: typeof window.mai === 'object',
      hasPermissions: typeof window.mai?.permissions === 'object',
      hasModes: typeof window.mai?.permissions?.modes === 'function',
      hasSet: typeof window.mai?.permissions?.set === 'function',
      hasOcr: typeof window.mai?.ocr === 'object',
      hasOcrStatus: typeof window.mai?.ocr?.status === 'function',
      hasOcrRecognize: typeof window.mai?.ocr?.recognize === 'function',
    }))()`);
    check('window.mai есть', bridge.hasMai === true);
    check('window.mai.permissions есть', bridge.hasPermissions === true);
    check('permissions.modes — функция', bridge.hasModes === true);
    check('permissions.set — функция', bridge.hasSet === true);
    check('window.mai.ocr есть', bridge.hasOcr === true);
    check('ocr.status — функция', bridge.hasOcrStatus === true);
    check('ocr.recognize — функция', bridge.hasOcrRecognize === true);

    console.log('\n[3] Переключение режима через UI');
    const switched = await win.webContents.executeJavaScript(`(async () => {
      const sel = document.querySelector('#mode-select');
      sel.value = 'plan';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return { value: sel.value, hasPlanClass: sel.classList.contains('mode-plan') };
    })()`);
    check('значение переключилось на plan', switched.value === 'plan', switched.value);
    check('класс mode-plan применён', switched.hasPlanClass === true);

    console.log('\n[4] Ошибки в консоли');
    const real = errors.filter((e) => !/Autofill|DevTools|Electron Security/i.test(e));
    check('нет ошибок JS', real.length === 0, real.join(' | '));

    console.log('\n[5] Голосовой ввод и настройки MAS');
    const mic = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('#mic');
      if (!b) return { found: false };
      const r = b.getBoundingClientRect();
      return {
        found: true,
        visible: r.width > 0 && r.height > 0,
        disabled: b.disabled,
        label: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
      };
    })()`);
    check('кнопка #mic существует', mic.found === true);
    check('кнопка #mic видна', mic.visible === true, JSON.stringify(mic));
    check('кнопка #mic активна', mic.disabled === false);
    check(
      'подсказка упоминает MAS',
      /MAS/.test(mic.title || '') && mic.label === 'Голосовой ввод',
      JSON.stringify(mic),
    );

    const masSettings = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#settings-btn').click();
      await new Promise((r) => setTimeout(r, 500));
      const body = document.querySelector('.modal-body');
      if (!body) return { open: false };
      // С N9 настройки — вкладками: голос на своей.
      document.querySelector('.settings-tab[data-tab="Голос и OCR"]')?.click();
      const text = body.innerText;
      const raw = body.textContent;
      const inputs = [...body.querySelectorAll('input')].map((i) => i.value);
      const buttons = [...body.querySelectorAll('button')].map((b) => b.innerText.trim());
      return {
        open: true,
        hasGroup: raw.includes('Голос — распознавание речи') && raw.includes('Движок'),
        hasHint: text.includes('кнопка микрофона'),
        hasToken: /api-token/.test(text),
        hasUrl: inputs.includes('http://127.0.0.1:8765'),
        hasModel: inputs.includes('gigaam-v3-e2e-ctc'),
        hasCheckButton: buttons.includes('Проверить связь'),
      };
    })()`);
    check('окно настроек открылось', masSettings.open === true);
    check('раздел MAS есть', masSettings.hasGroup === true, JSON.stringify(masSettings));
    check('подсказка про микрофон есть', masSettings.hasHint === true);
    check('адрес MAS по умолчанию', masSettings.hasUrl === true);
    check('модель по умолчанию', masSettings.hasModel === true);
    check('кнопка проверки связи есть', masSettings.hasCheckButton === true);
    check('подсказка про api-token есть', masSettings.hasToken === true);

    console.log('\n[6] Полоса заголовка и drag-регионы (ADR 0022)');
    const titlebar = await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.topbar');
      const row = document.querySelector('.topbar-row-main');
      const btn = document.querySelector('.topbar button');
      const sel = document.querySelector('.topbar select');
      const cs = getComputedStyle(bar);
      const rs = getComputedStyle(row);
      return {
        barRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
        btnRegion: getComputedStyle(btn).getPropertyValue('-webkit-app-region'),
        selRegion: getComputedStyle(sel).getPropertyValue('-webkit-app-region'),
        rowPaddingRight: parseFloat(rs.paddingRight) || 0,
        barHeight: Math.round(bar.getBoundingClientRect().height),
      };
    })()`);
    check('верхняя панель тянет окно', titlebar.barRegion === 'drag', JSON.stringify(titlebar));
    check('кнопки панели не тянут окно', titlebar.btnRegion === 'no-drag', JSON.stringify(titlebar));
    check('списки панели не тянут окно', titlebar.selRegion === 'no-drag', JSON.stringify(titlebar));
    check('есть отступ под кнопки окна', titlebar.rowPaddingRight >= 16, JSON.stringify(titlebar));
    check('панель не ниже полосы заголовка', titlebar.barHeight >= 36, JSON.stringify(titlebar));

    console.log('\n[7] Переменные полосы заголовка');
    const envVars = await win.webContents.executeJavaScript(`(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:env(titlebar-area-width, 0px);height:env(titlebar-area-height, 0px)';
      document.body.appendChild(probe);
      const rect = probe.getBoundingClientRect();
      probe.remove();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    })()`);
    check('env(titlebar-area-width) определён', envVars.width > 0, JSON.stringify(envVars));
    check('env(titlebar-area-height) = 36', envVars.height === 36, JSON.stringify(envVars));

    console.log('\n[8] Кнопки окна не накрывают кнопки панели');
    const overlap = await win.webContents.executeJavaScript(`(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:env(titlebar-area-width, 0px);height:env(titlebar-area-height, 0px)';
      document.body.appendChild(probe);
      const area = probe.getBoundingClientRect();
      probe.remove();
      // Область кнопок окна: справа от titlebar-area-width, высотой titlebar-area-height.
      const buttons = { left: area.width, top: 0, right: window.innerWidth, bottom: area.height };
      const hits = [];
      for (const node of document.querySelectorAll('.topbar button, .topbar select')) {
        const r = node.getBoundingClientRect();
        const intersects = r.left < buttons.right && r.right > buttons.left
          && r.top < buttons.bottom && r.bottom > buttons.top;
        if (intersects) hits.push((node.id || node.textContent || '').trim().slice(0, 20));
      }
      return {
        areaWidth: Math.round(area.width),
        areaHeight: Math.round(area.height),
        hits,
      };
    })()`);
    check('область кнопок окна определена', overlap.areaWidth > 0 && overlap.areaHeight > 0, JSON.stringify(overlap));
    check('ни один элемент панели не под кнопками окна', overlap.hits.length === 0, JSON.stringify(overlap));

    console.log('\n[9] Окно досок: drag-регионы');
    await win.loadFile(path.join(root, 'renderer', 'board.html'), { query: { board: 'delivery' } });
    await new Promise((r) => setTimeout(r, 1200));
    const boardBar = await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.board-topbar');
      if (!bar) return { found: false };
      const tab = bar.querySelector('.tab');
      const cs = getComputedStyle(bar);
      return {
        found: true,
        barRegion: cs.getPropertyValue('-webkit-app-region'),
        tabRegion: tab ? getComputedStyle(tab).getPropertyValue('-webkit-app-region') : null,
        paddingRight: parseFloat(cs.paddingRight) || 0,
      };
    })()`);
    check('панель досок найдена', boardBar.found === true);
    check('панель досок тянет окно', boardBar.barRegion === 'drag', JSON.stringify(boardBar));
    check('вкладки досок не тянут окно', boardBar.tabRegion === 'no-drag', JSON.stringify(boardBar));
    check('у панели досок есть отступ под кнопки окна', boardBar.paddingRight >= 16, JSON.stringify(boardBar));

    console.log('\n[10] Панель «Память»: версии и откат');
    await win.loadFile(path.join(root, 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 2000));
    const memoryPanel = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('[data-panel="memory"]');
      if (!btn) return { found: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 600));
      const body = document.querySelector('.modal-body');
      if (!body) return { found: true, open: false };
      const buttons = [...body.querySelectorAll('button')].map((b) => b.innerText.trim());
      const areas = [...body.querySelectorAll('textarea')].map((t) => t.value);
      const items = [...body.querySelectorAll('.list-item')].map((i) => i.innerText.replace(/\\s+/g, ' ').trim());
      return {
        found: true,
        open: true,
        buttons,
        areas,
        items,
        title: document.querySelector('.modal-head h2')?.innerText || '',
        // Индикатор предела (CC4.5): длинный текст — предупреждение.
        meter: (() => {
          const area = body.querySelectorAll('textarea')[0];
          const before = body.querySelector('.memory-meter-project')?.textContent || '';
          area.value = 'x'.repeat(12050);
          area.dispatchEvent(new Event('input'));
          const node = body.querySelector('.memory-meter-project');
          const after = { text: node?.textContent || '', over: node?.classList.contains('over') };
          area.value = 'память проекта';
          area.dispatchEvent(new Event('input'));
          return { before, after };
        })(),
      };
    })()`);
    check('индикатор памяти: размер из предела, сверх — предупреждение', /^14 из 12000 символов в промпте$/.test(memoryPanel.meter?.before) && memoryPanel.meter?.after?.over && /только первые 12000/.test(memoryPanel.meter?.after?.text), JSON.stringify(memoryPanel.meter));
    check('кнопка панели «Память» найдена', memoryPanel.found === true);
    check('окно памяти открылось', memoryPanel.open === true, JSON.stringify(memoryPanel));
    check('заголовок окна памяти', memoryPanel.title === 'Память (memory.md)', memoryPanel.title);
    check('два поля памяти', memoryPanel.areas?.length === 2, JSON.stringify(memoryPanel.areas));
    check('поле проекта заполнено', memoryPanel.areas?.[0] === 'память проекта', memoryPanel.areas?.[0]);
    check('поле глобальной заполнено', memoryPanel.areas?.[1] === 'глобальная память', memoryPanel.areas?.[1]);
    check(
      'кнопки версий есть',
      memoryPanel.buttons?.includes('Версии проекта') && memoryPanel.buttons?.includes('Версии глобальной'),
      JSON.stringify(memoryPanel.buttons),
    );
    check('история проекта показана по умолчанию', memoryPanel.items?.length === 2, JSON.stringify(memoryPanel.items));
    check(
      'в истории есть номер версии и пометка',
      /v2/.test(memoryPanel.items?.[0] || '') && /текущая/.test(memoryPanel.items?.[0] || ''),
      JSON.stringify(memoryPanel.items),
    );
    check(
      'у версии есть действия',
      /Показать/.test(memoryPanel.items?.[0] || '') && /Откатить/.test(memoryPanel.items?.[0] || ''),
      JSON.stringify(memoryPanel.items),
    );

    console.log('\n[11] Панель «Память»: действия версий');
    const memoryActions = await win.webContents.executeJavaScript(`(async () => {
      const body = document.querySelector('.modal-body');
      const items = [...body.querySelectorAll('.list-item')];
      const first = items[0];
      const showBtn = [...first.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Показать');
      showBtn.click();
      await new Promise((r) => setTimeout(r, 400));
      const areaAfterShow = body.querySelectorAll('textarea')[0].value;
      const globalBtn = [...body.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Версии глобальной');
      globalBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const emptyHint = body.innerText.includes('Версий пока нет');
      const projectBtn = [...body.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Версии проекта');
      projectBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const backItems = body.querySelectorAll('.list-item').length;
      return { areaAfterShow, emptyHint, backItems };
    })()`);
    check('«Показать» загрузило текст версии в поле', memoryActions.areaAfterShow === 'текст версии 2', memoryActions.areaAfterShow);
    check('пустая история глобальной объяснена', memoryActions.emptyHint === true, JSON.stringify(memoryActions));
    check('переключение обратно на проект работает', memoryActions.backItems === 2, String(memoryActions.backItems));

    const memorySave = await win.webContents.executeJavaScript(`(async () => {
      const foot = document.querySelector('.modal-foot');
      const save = [...foot.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Сохранить');
      save.click();
      await new Promise((r) => setTimeout(r, 500));
      return { stillOpen: Boolean(document.querySelector('.modal-body')) };
    })()`);
    check('сохранение не закрывает окно (история обновляется)', memorySave.stillOpen === true);
    check('сохранение вызвало memory:save для проекта', memoryCalls.some((c) => c.channel === 'save' && c.scope === 'project'), JSON.stringify(memoryCalls));
    check('сохранение вызвало memory:save для глобальной', memoryCalls.some((c) => c.channel === 'save' && c.scope === 'global'), JSON.stringify(memoryCalls));
    check('«Показать» вызвало memory:version', memoryCalls.some((c) => c.channel === 'version' && c.version === 2), JSON.stringify(memoryCalls));
    check('сохранение передало projectDir', memoryCalls.filter((c) => c.channel === 'save').every((c) => Boolean(c.projectDir)), JSON.stringify(memoryCalls));

    console.log('\n[12] Индикатор суммарного размера вложений');
    const attachTotal = await win.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('#attachments');
      if (!box) return { found: false };
      // Пустое состояние: блок скрыт, индикатора нет.
      return {
        found: true,
        hiddenWhenEmpty: box.hidden === true,
        totalWhenEmpty: box.querySelectorAll('.attachment-total').length,
      };
    })()`);
    check('блок вложений найден', attachTotal.found === true);
    check('пустой блок вложений скрыт', attachTotal.hiddenWhenEmpty === true, JSON.stringify(attachTotal));
    check('без вложений индикатора нет', attachTotal.totalWhenEmpty === 0, JSON.stringify(attachTotal));

    console.log('\n[13] Меню «Скачать» у ответа и у чата');
    // Загружаем сессию с ответом агента: так меню рисуется настоящим кодом.
    const exportUi = await win.webContents.executeJavaScript(`(async () => {
      const chatBtn = document.querySelector("#export-chat");
      const sessions = document.querySelectorAll("#sessions .session");
      if (sessions.length) sessions[0].click();
      await new Promise((r) => setTimeout(r, 600));
      const host = document.querySelector("#messages");
      const menu = host.querySelector(".msg-export");
      const buttons = menu ? [...menu.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
      return {
        chatBtn: Boolean(chatBtn),
        chatBtnText: chatBtn ? chatBtn.textContent.trim() : "",
        sessions: sessions.length,
        menuFound: Boolean(menu),
        buttons,
        headFound: Boolean(host.querySelector(".msg-head")),
        assistantCount: host.querySelectorAll(".msg-assistant").length,
      };
    })()`);
    check('кнопка «Скачать чат» есть', exportUi.chatBtn === true);
    check('подпись кнопки чата', exportUi.chatBtnText.includes('Скачать'), exportUi.chatBtnText);
    check('сессия с ответом загрузилась', exportUi.assistantCount > 0, JSON.stringify(exportUi));
    check('меню у ответа отрисовано', exportUi.menuFound === true, JSON.stringify(exportUi));
    check('четыре формата в меню', exportUi.buttons.length === 4, JSON.stringify(exportUi.buttons));
    check('форматы MD, TXT, DOCX, XLSX', ['MD', 'TXT', 'DOCX', 'XLSX'].every((f) => exportUi.buttons.includes(f)), JSON.stringify(exportUi.buttons));
    check('имя модели и меню в одной строке', exportUi.headFound === true);

    // Клик по формату должен вызвать IPC с нужным форматом и текстом ответа.
    const exportClick = await win.webContents.executeJavaScript(`(async () => {
      const menu = document.querySelector("#messages .msg-export");
      if (!menu) return { clicked: false };
      const docx = [...menu.querySelectorAll("button")].find((b) => b.textContent.trim() === "DOCX");
      if (!docx) return { clicked: false };
      docx.click();
      await new Promise((r) => setTimeout(r, 400));
      return { clicked: true, label: docx.textContent.trim() };
    })()`);
    check('клик по DOCX выполнен', exportClick.clicked === true, JSON.stringify(exportClick));
    check('IPC export:message вызван', exportCalls.some((c) => c.channel === 'message'), JSON.stringify(exportCalls));
    check('формат передан верно', exportCalls.some((c) => c.channel === 'message' && c.format === 'docx'), JSON.stringify(exportCalls));
    check('текст ответа передан', exportCalls.some((c) => c.channel === 'message' && String(c.markdown || '').includes('Отчёт')), JSON.stringify(exportCalls));

    // Кнопка «Скачать чат» открывает меню выбора формата.
    const chatMenu = await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector("#export-chat");
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const picker = document.querySelector(".export-picker");
      const items = picker ? [...picker.querySelectorAll("button")].map((b) => b.textContent.trim()) : [];
      return { found: Boolean(picker), items };
    })()`);
    check('меню форматов чата открылось', chatMenu.found === true, JSON.stringify(chatMenu));
    check('меню чата: четыре формата и файл чата MAI', chatMenu.items.length === 5 && chatMenu.items[4].startsWith('Файл чата MAI'), JSON.stringify(chatMenu.items));

    const chatPick = await win.webContents.executeJavaScript(`(async () => {
      const picker = document.querySelector(".export-picker");
      const md = picker ? [...picker.querySelectorAll("button")].find((b) => b.textContent.trim() === "Markdown") : null;
      if (!md) return { picked: false };
      md.click();
      await new Promise((r) => setTimeout(r, 400));
      return { picked: true, pickerGone: !document.querySelector(".export-picker") };
    })()`);
    check('формат чата выбран', chatPick.picked === true, JSON.stringify(chatPick));
    check('меню закрылось после выбора', chatPick.pickerGone === true, JSON.stringify(chatPick));
    check('IPC export:chat вызван', exportCalls.some((c) => c.channel === 'chat'), JSON.stringify(exportCalls));
    check('чат передан списком сообщений', exportCalls.some((c) => c.channel === 'chat' && Array.isArray(c.messages) && c.messages.length >= 2), JSON.stringify(exportCalls));

    console.log('\n[14] Запрос разрешения: рекомендованный ответ и правила (ADR 0027)');
    win.webContents.send('chat:event', {
      type: 'approval',
      id: 'appr-1',
      tool: 'run_shell',
      name: 'run_shell',
      cls: 'exec',
      summary: 'git push origin dev',
      risk: 'high',
      why: 'необратимая операция git',
      recommended: 'deny',
      suggestions: ['run_shell(git push*)'],
    });
    await new Promise((r) => setTimeout(r, 400));
    const modal1 = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.approval-card');
      if (!m) return { found: false };
      const rec = m.querySelector('.approve-option.recommended');
      return {
        found: true,
        recommended: rec?.textContent || '',
        focused: document.activeElement === rec,
        risk: m.querySelector('.risk-badge')?.className || '',
        options: [...m.querySelectorAll('.approve-option')].map((b) => b.textContent),
      };
    })()`);
    check('модалка запроса открыта', modal1.found === true, JSON.stringify(modal1));
    check('высокий риск: рекомендовано «Нет»', /Нет/.test(modal1.recommended) && /Рекомендуется/.test(modal1.recommended), JSON.stringify(modal1));
    check('рекомендованная кнопка в фокусе', modal1.focused === true, JSON.stringify(modal1));
    check('бейдж высокого риска', /risk-high/.test(modal1.risk), modal1.risk);
    check('три варианта ответа', modal1.options.length === 3, JSON.stringify(modal1.options));
    check('вариант 2 показывает правило', modal1.options.some((t) => t.includes('run_shell(git push*)')), JSON.stringify(modal1.options));
    const scopes = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.approval-card .approve-scope option')].map((o) => o.value)`);
    check('запомнить: чат, проект (только у меня), все чаты', scopes.join(',') === 'session,local,global', JSON.stringify(scopes));

    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    const a1 = approvals.find((a) => a.id === 'appr-1');
    check('клавиша 2: разрешено с правилом на чат', a1?.allow === true && a1?.remember === 'session' && a1?.rules?.[0] === 'run_shell(git push*)', JSON.stringify(a1));

    win.webContents.send('chat:event', {
      type: 'approval',
      id: 'appr-2',
      tool: 'write_file',
      cls: 'write',
      summary: 'Записать файл ../a.js',
      risk: 'medium',
      why: 'файл вне папки проекта',
      decisionSource: 'classifier',
      recommended: 'allow',
      suggestions: [],
    });
    await new Promise((r) => setTimeout(r, 400));
    const modal2 = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.approval-card');
      const rec = m?.querySelector('.approve-option.recommended');
      const area = m?.querySelector('.approve-feedback');
      if (area) area.value = 'сначала прочитай файл';
      return { recommended: rec?.textContent || '', options: m ? m.querySelectorAll('.approve-option').length : 0 };
    })()`);
    check('средний риск: рекомендовано «Да»', /^1Да/.test(modal2.recommended), JSON.stringify(modal2));
    check('без подсказки правила — два варианта', modal2.options === 2, JSON.stringify(modal2));
    const why2 = await win.webContents.executeJavaScript(`document.querySelector('.approval-card .approve-why')?.textContent || ''`);
    check('решение «Авто» видно в карточке', why2 === 'Авто спрашивает: файл вне папки проекта.', why2);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    const a2 = approvals.find((a) => a.id === 'appr-2');
    check('клавиша 3: отказ с пояснением', a2?.allow === false && a2?.feedback === 'сначала прочитай файл', JSON.stringify(a2));
    check('карточка запроса закрыта', await win.webContents.executeJavaScript(`!document.querySelector('.approval-card')`));

    console.log('\n[14b] Запрос в ленте с diff и заголовки карточек инструментов (CC7.1–CC7.3)');
    win.webContents.send('chat:event', {
      type: 'approval',
      id: 'appr-3',
      tool: 'edit_file',
      cls: 'write',
      summary: 'Изменить файл src/a.js',
      risk: 'medium',
      recommended: 'allow',
      suggestions: ['write_file(src/**)', 'edit_file(src/**)'],
      diff: { added: 1, removed: 1, lines: [{ type: '@', text: '@@ строка 1 @@' }, { type: '-', text: 'old()' }, { type: '+', text: 'new()' }] },
    });
    await new Promise((r) => setTimeout(r, 400));
    const feedCard = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.approval-card');
      return {
        found: Boolean(c),
        inFeed: Boolean(c?.closest('#messages')),
        modal: Boolean(c?.closest('.modal')),
        del: c?.querySelector('.diff-del .diff-text')?.textContent || '',
        add: c?.querySelector('.diff-add .diff-text')?.textContent || '',
        stats: c?.querySelector('.diff-stats')?.textContent || '',
      };
    })()`);
    check('запрос — карточкой в ленте, без модалки', feedCard.found && feedCard.inFeed && !feedCard.modal, JSON.stringify(feedCard));
    check('diff показан: было и стало', feedCard.del === 'old()' && feedCard.add === 'new()', JSON.stringify(feedCard));
    check('счётчики +1 −1', /\+1/.test(feedCard.stats) && /−1/.test(feedCard.stats), feedCard.stats);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    check('клавиша 1 разрешила', approvals.find((x) => x.id === 'appr-3')?.allow === true);

    // Живые карточки рисуются через requestAnimationFrame, а в скрытом окне он не идёт:
    // результат приходит событием, отрисовку делает done.
    win.webContents.send('chat:event', { type: 'tool_result', id: 'tc-1', name: 'edit_file', ok: true, content: 'Изменено', diff: { added: 3, removed: 1, lines: [{ type: '+', text: 'x' }] } });
    win.webContents.send('chat:event', {
      type: 'done',
      messages: [
        { role: 'user', content: 'правь' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc-1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/deep/main.js', old_string: 'a', new_string: 'b' }) } },
            { id: 'tc-2', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'npm test' }) } },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));
    const titles = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tool-head')].map((h) => h.querySelector('.tool-name').textContent + ' ' + h.querySelector('.tool-args').textContent)`);
    check('Edit с файлом и счётчиками', titles.some((t) => t === 'Edit deep/main.js +3 −1'), JSON.stringify(titles));
    check('Bash с командой', titles.some((t) => t === 'Bash npm test'), JSON.stringify(titles));

    console.log('\n[15] Доверие к папке при выборе проекта (ADR 0028)');
    // С N9 смена папки — пункт меню кнопки проекта.
    await win.webContents.executeJavaScript(`document.querySelector('#project-btn').click(); document.querySelector('#project-pick').click()`);
    await new Promise((r) => setTimeout(r, 600));
    const trustModal = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.trust-modal');
      if (!m) return { found: false };
      const rec = m.querySelector('.recommended');
      return {
        found: true,
        recommended: rec?.dataset.trust || '',
        focused: document.activeElement === rec,
        items: [...m.querySelectorAll('.trust-list li')].map((li) => li.textContent),
        badge: document.querySelector('#project-trust')?.textContent || '',
      };
    })()`);
    check('окно доверия открыто после выбора папки', trustModal.found === true, JSON.stringify(trustModal));
    check('при плагинах и MCP рекомендовано «Ограниченно»', trustModal.recommended === 'restricted', JSON.stringify(trustModal));
    check('рекомендованный ответ в фокусе', trustModal.focused === true);
    check('найденное перечислено', trustModal.items.some((t) => t.includes('плагины')) && trustModal.items.some((t) => t.includes('fs')), JSON.stringify(trustModal.items));
    check('значок «не доверена» у папки', trustModal.badge === 'не доверена', trustModal.badge);
    await win.webContents.executeJavaScript(`document.querySelector('.trust-modal [data-trust="restricted"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('решение сохранено через trust:set', trustCalls.some((c) => c.state === 'restricted'), JSON.stringify(trustCalls));
    check(
      'значок «ограниченно» у папки',
      (await win.webContents.executeJavaScript(`document.querySelector('#project-trust')?.textContent`)) === 'ограниченно',
    );

    console.log('\n[16] Песочница, CSP и экранирование данных проекта (A2.5)');
    const csp = await win.webContents.executeJavaScript(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''`,
    );
    check('CSP задан в главном окне', /script-src 'self'/.test(csp) && /object-src 'none'/.test(csp), csp);
    const copied = await win.webContents.executeJavaScript(`window.mai.clipboard.writeText('скопировано').then(() => true)`);
    check('буфер обмена через main работает в песочнице', copied === true && clipboardCalls.includes('скопировано'), JSON.stringify(clipboardCalls));
    const crafted = loadBoards(root);
    crafted.delivery.tasks = [
      { id: 't1', title: 'задача', column: 'backlog', status: 'backlog', priority: '<img src=x id=pwned onerror="window.__pwned=1">' },
    ];
    craftedBoards = crafted;
    await win.loadFile(path.join(root, 'renderer', 'board.html'), { query: { board: 'delivery' } });
    await new Promise((r) => setTimeout(r, 1200));
    const xss = await win.webContents.executeJavaScript(`(() => ({
      injected: Boolean(document.getElementById('pwned')),
      ran: window.__pwned === 1,
      text: document.body.innerText.includes('<img src=x'),
      csp: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
    }))()`);
    check('разметка из boards.json не стала элементом', xss.injected === false, JSON.stringify(xss));
    check('скрипт из boards.json не выполнен', xss.ran === false);
    check('приоритет показан как текст', xss.text === true, JSON.stringify(xss));
    check('CSP задан в окне досок', xss.csp === true);
    craftedBoards = null;
    const cspErrors = errors.filter((e) => /Content Security Policy|Refused to/i.test(e));
    check('нет нарушений CSP за весь прогон', cspErrors.length === 0, cspErrors.join(' | '));

    console.log('\n[17] Вопрос агента и карточка плана в ленте (CC1.7, CC1.8)');
    await win.loadFile(path.join(root, 'renderer', 'index.html'));
    // Ждём конца init(): подписка на события идёт после загрузки моделей и сессий.
    for (let i = 0; i < 50; i += 1) {
      const ready = await win.webContents.executeJavaScript(`document.querySelectorAll('#mode-select option').length > 0 && document.querySelectorAll('.session').length > 0`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    win.webContents.send('chat:event', {
      type: 'question',
      id: 'q-1',
      kind: 'questions',
      questions: [
        {
          question: 'Какую базу взять?',
          header: 'База',
          options: [
            { label: 'Postgres', description: 'уже есть в infra', recommended: true },
            { label: 'SQLite', recommended: false },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));
    const card = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.question-card');
      if (!c) return { found: false };
      const first = c.querySelector('.question-option');
      return {
        found: true,
        inFeed: Boolean(c.closest('#messages')),
        modal: Boolean(document.querySelector('.modal-backdrop')),
        firstText: first?.textContent || '',
        firstRecommended: first?.classList.contains('recommended'),
        firstPicked: first?.classList.contains('picked'),
      };
    })()`);
    check('вопрос показан карточкой в ленте, не модалкой', card.found && card.inFeed && !card.modal, JSON.stringify(card));
    check('рекомендованный вариант первым, с бейджем', card.firstRecommended && /Рекомендуется/.test(card.firstText), JSON.stringify(card));
    check('рекомендованный выбран заранее', card.firstPicked === true);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    const q1 = answers.find((a) => a.id === 'q-1');
    check('Enter отвечает рекомендованным', q1?.answer?.answers?.[0] === 'Postgres', JSON.stringify(q1));
    check('карточка закрылась', await win.webContents.executeJavaScript(`!document.querySelector('.question-card')`));

    win.webContents.send('chat:event', {
      type: 'question',
      id: 'q-2',
      kind: 'questions',
      questions: [{ question: 'Где хранить?', options: [{ label: 'диск', recommended: true }, { label: 'S3' }] }],
    });
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`document.querySelector('.question-card .btn.primary').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('клавиша 2 выбирает второй вариант', answers.find((a) => a.id === 'q-2')?.answer?.answers?.[0] === 'S3', JSON.stringify(answers));

    win.webContents.send('chat:event', {
      type: 'question',
      id: 'p-1',
      kind: 'plan',
      plan: '# План\n\n1. Добавить кэш',
      alternatives: [
        { title: 'Кэш в памяти', risk: 'low' },
        { title: 'Redis', risk: 'medium', pros: 'общий для процессов' },
      ],
      recommended: 1,
    });
    await new Promise((r) => setTimeout(r, 400));
    const planCard = await win.webContents.executeJavaScript(`(() => {
      const c = document.querySelector('.plan-card');
      if (!c) return { found: false };
      const alts = [...c.querySelectorAll('.plan-alt')];
      return {
        found: true,
        planRendered: Boolean(c.querySelector('.plan-text h1')),
        recommendedTitle: alts.find((a) => a.classList.contains('recommended'))?.querySelector('b')?.textContent || '',
        pickedTitle: alts.find((a) => a.classList.contains('picked'))?.querySelector('b')?.textContent || '',
        buttons: [...c.querySelectorAll('.question-foot .btn')].map((b) => b.textContent),
      };
    })()`);
    check('карточка плана в ленте, план отрисован', planCard.found && planCard.planRendered, JSON.stringify(planCard));
    check('рекомендованная альтернатива подсвечена и выбрана', planCard.recommendedTitle === 'Redis' && planCard.pickedTitle === 'Redis', JSON.stringify(planCard));
    check('кнопки выполнения и доработки', planCard.buttons.some((t) => /принимать правки/.test(t)) && planCard.buttons.some((t) => /Доработать/.test(t)), JSON.stringify(planCard.buttons));
    await win.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('.plan-card .approve-feedback');
      area.value = 'добавь тесты';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('.plan-card .question-foot .btn')].find((b) => /Доработать/.test(b.textContent)).click();
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const p1 = answers.find((a) => a.id === 'p-1');
    check('«Доработать» уходит с замечаниями', p1?.answer?.action === 'revise' && p1?.answer?.feedback === 'добавь тесты', JSON.stringify(p1));

    console.log('\n[18] Задачи агента, очередь, живой вывод, клавиши (CC1.5, CC7.4–CC7.6)');
    win.webContents.send('chat:event', {
      type: 'todos',
      todos: [
        { content: 'Прочитать код', status: 'completed' },
        { content: 'Добавить тест', activeForm: 'Добавляю тест', status: 'in_progress' },
        { content: 'Обновить docs', status: 'pending' },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const todos = await win.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('#todos');
      return {
        visible: box && !box.hidden,
        head: box?.querySelector('.todos-head')?.textContent || '',
        items: [...(box?.querySelectorAll('.todo') || [])].map((li) => li.className + ':' + li.textContent),
      };
    })()`);
    check('панель задач видна', todos.visible === true, JSON.stringify(todos));
    check('счётчик выполненных', /1 из 3/.test(todos.head), todos.head);
    check('задача в работе — в форме «делаю»', todos.items.some((t) => t.includes('todo-in_progress') && t.includes('Добавляю тест')), JSON.stringify(todos.items));
    check('выполненная отмечена', todos.items.some((t) => t.includes('todo-completed')));

    win.webContents.send('chat:event', { type: 'queued:returned', items: [{ id: 'x', text: 'не успел уйти' }] });
    await new Promise((r) => setTimeout(r, 300));
    check('невзятое из очереди вернулось в поле ввода', (await win.webContents.executeJavaScript(`document.querySelector('#input').value`)) === 'не успел уйти');
    await win.webContents.executeJavaScript(`document.querySelector('#input').value = ''`);

    const modeBefore = await win.webContents.executeJavaScript(`document.querySelector('#mode-select').value`);
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const modeAfter = await win.webContents.executeJavaScript(`document.querySelector('#mode-select').value`);
    check('Shift+Tab переключает режим', modeBefore !== modeAfter, `${modeBefore} → ${modeAfter}`);
    check('Shift+Tab не выбирает недоступный режим', modeAfter !== 'bypass', modeAfter);


    win.webContents.send('chat:event', { type: 'tool_progress', id: 'tc-live', text: 'сборка 42%\n' });
    win.webContents.send('chat:event', {
      type: 'done',
      messages: [
        { role: 'user', content: 'собери' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc-live', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'npm run build' }) } }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const live = await win.webContents.executeJavaScript(`(() => {
      const pre = document.querySelector('.tool-live');
      return { text: pre?.textContent || '', open: Boolean(pre?.closest('.tool-card.open')) };
    })()`);
    check('живой вывод в раскрытой карточке', /сборка 42%/.test(live.text) && live.open, JSON.stringify(live));
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#input');
      input.value = '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    })()`);
    check('↑ в пустом поле возвращает последнее сообщение', (await win.webContents.executeJavaScript(`document.querySelector('#input').value`)) === 'собери');


    console.log('\n[19] Слэш-команды и @файл (CC7.7–CC7.9)');
    const type = (text) =>
      win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('#input');
        input.focus();
        input.value = ${JSON.stringify(text)};
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    const key = (k) =>
      win.webContents.executeJavaScript(`document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
    const menu = () =>
      win.webContents.executeJavaScript(`(() => {
        const box = document.querySelector('#suggest');
        return { open: box && !box.hidden, items: [...(box?.querySelectorAll('.suggest-item') || [])].map((b) => b.textContent), active: box?.querySelector('.active')?.textContent || '' };
      })()`);
    await type('/re');
    await new Promise((r) => setTimeout(r, 300));
    let m = await menu();
    check('/ открывает меню команд', m.open && m.items.some((t) => t.startsWith('/review')), JSON.stringify(m));
    check('команда проекта помечена', m.items.some((t) => t.includes('/review') && t.includes('проект')), JSON.stringify(m.items));
    await type('/');
    await new Promise((r) => setTimeout(r, 200));
    await key('ArrowDown');
    m = await menu();
    check('стрелка вниз двигает выбор', m.active.startsWith('/clear'), m.active);
    await type('/rev');
    await new Promise((r) => setTimeout(r, 200));
    await key('Tab');
    await new Promise((r) => setTimeout(r, 100));
    check('Tab подставляет команду с пробелом для аргумента', (await win.webContents.executeJavaScript(`document.querySelector('#input').value`)) === '/review ');
    await type('/review src/app.js');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 400));
    check('своя команда разворачивается через commands:expand', expandCalls.some((c) => c.name === 'review' && c.args === 'src/app.js'), JSON.stringify(expandCalls));

    await type('/help');
    await key('Enter'); // выбрать из меню
    await new Promise((r) => setTimeout(r, 200));
    if (!(await win.webContents.executeJavaScript(`Boolean(document.querySelector('.help-table'))`))) {
      await key('Enter');
      await new Promise((r) => setTimeout(r, 300));
    }
    const help = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.help-row code')].map((c) => c.textContent)`);
    check('/help показывает команды', help.includes('/review <путь>') && help.includes('/init'), JSON.stringify(help));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    await type('посмотри @sr');
    await new Promise((r) => setTimeout(r, 450));
    m = await menu();
    check('@ ищет файлы проекта', m.open && m.items.includes('src/app.js'), JSON.stringify(m));
    await key('ArrowDown');
    await key('Enter');
    await new Promise((r) => setTimeout(r, 150));
    check('Enter подставляет путь, а не отправляет', (await win.webContents.executeJavaScript(`document.querySelector('#input').value`)) === 'посмотри @src/app.js ');
    await type('');

    console.log('\n[20] Контекст, компакция, стоимость (CC5.1–CC5.5)');
    win.webContents.send('chat:event', { type: 'context', used: 112000, window: 128000, exact: true });
    await new Promise((r) => setTimeout(r, 200));
    const meterInfo = await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('#context-meter'); return { hidden: m.hidden, text: m.textContent, cls: m.className, title: m.title }; })()`);
    check('индикатор контекста виден', !meterInfo.hidden && meterInfo.text === 'контекст 88%', JSON.stringify(meterInfo));
    check('у порога — красный', /ctx-high/.test(meterInfo.cls));
    check('в подсказке токены из окна', /112K из 128K/.test(meterInfo.title), meterInfo.title);
    win.webContents.send('chat:event', {
      type: 'done',
      messages: [
        { role: 'compaction', content: '**Сделано:** база', messages: 8, auto: true },
        { role: 'user', content: 'дальше' },
        { role: 'assistant', content: 'ок', model: 'test-model', usage: { input: 1200, output: 300, cached: 800, total: 1500 } },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const compactCard = await win.webContents.executeJavaScript(`document.querySelector('.compaction-card summary')?.textContent || ''`);
    check('карточка компакции в ленте', /автоматически сжат: 8 сообщений/.test(compactCard), compactCard);
    const usage = await win.webContents.executeJavaScript(`document.querySelector('.msg-usage')?.textContent || ''`);
    check('токены шага в шапке ответа', /↑1K ↓300/.test(usage), usage);
    const typeCmd = async (text) => {
      await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
      await win.webContents.executeJavaScript(`document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
      await new Promise((r) => setTimeout(r, 400));
    };
    await typeCmd('/context');
    const ctx = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.context-row')].map((r) => r.textContent)`);
    check('/context показывает части', ctx.some((t) => t.includes('Результаты инструментов')), JSON.stringify(ctx));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
    await typeCmd('/cost');
    const cost = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.context-row')].map((r) => r.textContent).join(' | ')`);
    check('/cost показывает токены и кэш', /1 шагов · ↑1K \(кэш 800\) ↓300/.test(cost), cost);
    check('без цены — честно «цена не задана»', /цена не задана/.test(cost), cost);
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[21] Откат к сообщению (CC6.1)');
    await win.webContents.executeJavaScript(`document.querySelector('.session')?.click()`);
    await new Promise((r) => setTimeout(r, 600));
    const btn = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('.msg-user .rewind-btn'); return { found: Boolean(b), edited: b?.classList.contains('edited') }; })()`);
    check('у своего сообщения есть кнопка отката', btn.found, JSON.stringify(btn));
    check('сообщение с правками отмечено', btn.edited === true);
    await win.webContents.executeJavaScript(`document.querySelector('.msg-user .rewind-btn').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const rw = await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.rewind-modal');
      return {
        found: Boolean(m),
        files: [...(m?.querySelectorAll('.rewind-file') || [])].map((f) => f.textContent),
        recommended: m?.querySelector('.recommended')?.dataset.mode || '',
        note: m?.textContent.includes('run_shell') || false,
      };
    })()`);
    check('окно отката с файлами', rw.found && rw.files.length === 2 && rw.files.some((t) => t.includes('удалить')), JSON.stringify(rw));
    check('рекомендовано «Код и диалог»', rw.recommended === 'both', rw.recommended);
    check('честно про run_shell', rw.note === true);
    await win.webContents.executeJavaScript(`document.querySelector('.rewind-modal .recommended').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('откат вызван с режимом both и номером сообщения', rewindCalls.some((c) => c.mode === 'both' && c.turn === 0 && c.sessionId === 'test-session'), JSON.stringify(rewindCalls));
    check('текст сообщения вернулся в поле ввода', (await win.webContents.executeJavaScript(`document.querySelector('#input').value`)) === 'Покажи отчёт');

    console.log('\n[22] Чаты по проекту, поиск, /resume, редактирование, # в память (CC6.3–CC6.7, CC4.3)');
    const lastList = () => sessionListCalls.at(-1) || {};
    check('список чатов — по текущему проекту', lastList().projectDir === root, JSON.stringify(lastList()));
    await win.webContents.executeJavaScript(`document.querySelector('#sessions-scope').click()`);
    await new Promise((r) => setTimeout(r, 200));
    check('«все проекты» снимает фильтр', lastList().projectDir === '', JSON.stringify(lastList()));
    await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('#sessions-search'); s.value = 'отчёт'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await new Promise((r) => setTimeout(r, 450));
    check('поиск уходит в main', lastList().query === 'отчёт', JSON.stringify(lastList()));
    check('фрагмент совпадения в списке', (await win.webContents.executeJavaScript(`document.querySelector('.session-match')?.textContent || ''`)).includes('фрагмент'));

    await win.webContents.executeJavaScript(`document.querySelector('.session').click()`);
    await new Promise((r) => setTimeout(r, 600));
    await win.webContents.executeJavaScript(`document.querySelector('.msg-user .edit-btn').click()`);
    await new Promise((r) => setTimeout(r, 200));
    const editing = await win.webContents.executeJavaScript(`({ value: document.querySelector('#input').value, banner: !document.querySelector('#edit-banner').hidden, marked: Boolean(document.querySelector('.msg-user.editing')) })`);
    check('✎ кладёт текст в поле и показывает плашку', editing.value === 'Покажи отчёт' && editing.banner && editing.marked, JSON.stringify(editing));
    const rewindsBefore = rewindCalls.length;
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = 'Покажи отчёт за неделю'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    check('отправка правки сначала откатывает диалог', rewindCalls.slice(rewindsBefore).some((c) => c.mode === 'conversation' && c.turn === 0), JSON.stringify(rewindCalls.slice(rewindsBefore)));
    check('затем уходит новый текст', chatStarts.some((c) => c.displayText === 'Покажи отчёт за неделю'), JSON.stringify(chatStarts.map((c) => c.displayText)));

    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '# тесты запускать через npm.cmd'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 300));
    const rec = await win.webContents.executeJavaScript(`document.querySelector('.remember-modal .recommended')?.dataset.scope || ''`);
    check('# открывает «Запомнить?», рекомендована память проекта', rec === 'project', rec);
    await win.webContents.executeJavaScript(`document.querySelector('.remember-modal .recommended').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('строка ушла в память, а не агенту', memoryAppends.some((m) => m.text === 'тесты запускать через npm.cmd' && m.scope === 'project') && !chatStarts.some((c) => /npm\.cmd/.test(c.text)), JSON.stringify(memoryAppends));

    console.log('\n[23] Хуки: /hooks и карточка Stop (ADR 0035)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/hooks'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const hookRows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.hook-row')].map((r) => r.textContent)`);
    check('/hooks показывает хуки с источником', hookRows.some((t) => t.includes('PreToolUse · write_file') && t.includes('node check.js') && t.includes('проект')), JSON.stringify(hookRows));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
    win.webContents.send('chat:event', { type: 'done', messages: [{ role: 'user', content: 'сделай' }, { role: 'hook', event: 'Stop', content: '[Хук Stop, раунд 1] Работа не принята: тесты не запускались' }] });
    await new Promise((r) => setTimeout(r, 300));
    const hookCard = await win.webContents.executeJavaScript(`document.querySelector('.hook-card')?.textContent || ''`);
    check('замечание хука — отдельной карточкой, не репликой пользователя', /Хук Stop/.test(hookCard) && /тесты не запускались/.test(hookCard), hookCard);

    console.log('\n[24] Субагенты: /agents и карточка вызова (ADR 0036)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/agents'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const agentRows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.help-row')].map((r) => r.textContent)`);
    check('/agents показывает типы, источник и инструменты', agentRows.some((t) => t.includes('explore') && t.includes('read_file')) && agentRows.some((t) => t.includes('reviewer') && t.includes('проект') && t.includes('все инструменты')), JSON.stringify(agentRows));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
    win.webContents.send('chat:event', { type: 'tool_result', id: 'ag-1', name: 'agent', ok: true, content: '[Субагент explore «найти конфиг»: шагов 2]\n\nнашёл' });
    win.webContents.send('chat:event', {
      type: 'done',
      messages: [
        { role: 'user', content: 'разберись' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'ag-1', type: 'function', function: { name: 'agent', arguments: JSON.stringify({ type: 'explore', description: 'найти конфиг', prompt: 'найди' }) } }] },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    const agentTitle = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tool-head')].map((h) => h.querySelector('.tool-name').textContent + ' ' + h.querySelector('.tool-args').textContent)`);
    check('карточка вызова: «Agent explore найти конфиг»', agentTitle.includes('Agent explore найти конфиг'), JSON.stringify(agentTitle));

    console.log('\n[25] Пакеты: /packages, включение, установка (ADR 0037)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/packages'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const pkgRow = await win.webContents.executeJavaScript(`document.querySelector('.package-row')?.textContent || ''`);
    check('пакет с версией, источником и содержимым', /review-kit 1\.2\.0/.test(pkgRow) && /глобальный/.test(pkgRow) && /исполняемый код/.test(pkgRow) && /команд: 2/.test(pkgRow), pkgRow);
    await win.webContents.executeJavaScript(`document.querySelector('.package-row input[type=checkbox]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('флажок выключает пакет', packageCalls.some((c) => c.type === 'toggle' && c.name === 'review-kit' && c.enabled === false), JSON.stringify(packageCalls));
    await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.modal'); const i = m.querySelector('input.package-source'); i.value = 'https://example.com/git-kit.git'; m.querySelector('.package-install').click(); })()`);
    await new Promise((r) => setTimeout(r, 300));
    check('установка из git-URL уходит в main', packageCalls.some((c) => c.type === 'install' && c.from === 'https://example.com/git-kit.git'), JSON.stringify(packageCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[26] Разрешения: /permissions, уровни, проверка вызова (ADR 0038)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/permissions'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const permRows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.perm-row')].map((r) => r.dataset.level + ':' + r.dataset.kind + ':' + r.querySelector('code').textContent)`);
    check('правила всех уровней в панели', ['managed:deny:run_shell(curl *)', 'global:allow:run_shell(npm test)', 'project:allow:run_shell(npm run lint)', 'local:allow:run_shell(make)'].every((r) => permRows.includes(r)), JSON.stringify(permRows));
    const permText = await win.webContents.executeJavaScript(`document.querySelector('.modal')?.textContent || ''`);
    check('файл организации и запрет «Без вопросов» показаны', /managed-settings\.json/.test(permText) && /Без вопросов» запрещён/.test(permText), permText.slice(0, 300));
    const removable = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.perm-row')].filter((r) => r.querySelector('button')).map((r) => r.dataset.level)`);
    check('правила организации и проекта (git) не убираются из панели', !removable.includes('managed') && !removable.includes('project') && removable.includes('local'), JSON.stringify(removable));
    await win.webContents.executeJavaScript(`document.querySelector('.perm-row[data-level=local] button').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('«Убрать» уходит в main с уровнем local', permCalls.some((c) => c.type === 'rules' && c.scope === 'local' && c.remove?.[0] === 'run_shell(make)'), JSON.stringify(permCalls));
    const localLeft = await win.webContents.executeJavaScript(`document.querySelectorAll('.perm-row[data-level=local]').length`);
    check('список обновился после удаления', localLeft === 0, String(localLeft));
    await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('.perm-subject'); s.value = 'curl https://x'; [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Проверить').click(); })()`);
    await new Promise((r) => setTimeout(r, 300));
    const verdict = await win.webContents.executeJavaScript(`(() => { const v = document.querySelector('.perm-verdict'); return v.dataset.action + '|' + v.textContent; })()`);
    check('проверка показывает решение, правило и уровень', /^deny\|запрещено — правило run_shell\(curl \*\) \(организация\)/.test(verdict), verdict);
    check('проверка уходит с инструментом и командой', permCalls.some((c) => c.type === 'explain' && c.tool === 'run_shell' && c.subject === 'curl https://x'), JSON.stringify(permCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[27] Настройки: песочница команд агента (ADR 0040)');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`document.querySelector('#settings-btn').click()`);
    await new Promise((r) => setTimeout(r, 600));
    const box = await win.webContents.executeJavaScript(`(() => {
      const d = document.querySelector('.shell-sandbox-mode');
      if (!d) return { found: false };
      const before = { docker: d.value !== 'off', network: document.querySelector('.shell-sandbox-network').value, options: [...d.options].map((o) => o.value).join() };
      d.value = 'docker';
      document.querySelector('.shell-sandbox-image').value = 'python:3.12-slim';
      document.querySelector('.shell-sandbox-network').value = 'bridge';
      document.querySelector('.shell-sandbox-host').value = 'git *\\n\\n  gh *  ';
      // Браузер агента (ADR 0069): включён по умолчанию, сайты — списком через запятую.
      before.browser = document.querySelector('.browser-enabled')?.checked;
      document.querySelector('.browser-allow').value = 'wikipedia.org,  docs.python.org ';
      document.querySelector('.browser-block').value = 'mybank.ru';
      [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Сохранить').click();
      return { found: true, before };
    })()`);
    check('раздел «Команды агента» в настройках', box.found === true, JSON.stringify(box));
    check('по умолчанию выключено, сеть выключена; есть «только в Задаче»', box.before?.docker === false && box.before?.network === 'none' && box.before?.options === 'off,docker,tasks', JSON.stringify(box));
    await new Promise((r) => setTimeout(r, 400));
    const sb = savedSettings.at(-1)?.shellSandbox;
    const bs = savedSettings.at(-1);
    check('браузер агента: включён, сайты без вопросов и под запретом сохраняются', box.before?.browser === true && bs?.browserEnabled === true && bs?.browserSites?.allow?.join('|') === 'wikipedia.org|docs.python.org' && bs?.browserSites?.block?.join('|') === 'mybank.ru', JSON.stringify({ b: box.before?.browser, s: bs?.browserSites }));
    check('сохраняется mode/image/network/hostCommands', sb?.mode === 'docker' && sb?.image === 'python:3.12-slim' && sb?.network === 'bridge' && sb?.hostCommands?.join('|') === 'git *|gh *', JSON.stringify(sb));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[28] MCP: вход OAuth (ADR 0041)');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`document.querySelector('[data-panel=mcp]').click()`);
    await new Promise((r) => setTimeout(r, 500));
    const mcpView = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.modal .list-item')].map((i) => ({ title: i.querySelector('.title').textContent, login: i.querySelector('.mcp-login')?.textContent || '', primary: Boolean(i.querySelector('.mcp-login.primary')) }))`);
    const remoteRow = mcpView.find((r) => r.title.startsWith('remote'));
    const localRow = mcpView.find((r) => r.title.startsWith('local'));
    check('HTTP-сервер: «нужен вход» и выделенная кнопка «Войти»', /нужен вход/.test(remoteRow?.title || '') && remoteRow?.login === 'Войти' && remoteRow?.primary, JSON.stringify(mcpView));
    check('stdio-серверу кнопки входа нет', localRow && localRow.login === '', JSON.stringify(mcpView));
    await win.webContents.executeJavaScript(`document.querySelector('.mcp-login').click()`);
    await new Promise((r) => setTimeout(r, 600));
    check('«Войти» уходит в main', mcpCalls.some((c) => c.type === 'login' && c.name === 'remote'), JSON.stringify(mcpCalls));
    const afterLogin = await win.webContents.executeJavaScript(`document.querySelector('.mcp-login')?.textContent || ''`);
    check('после входа — «Выйти»', afterLogin === 'Выйти', afterLogin);
    await win.webContents.executeJavaScript(`document.querySelector('.mcp-login').click()`);
    await new Promise((r) => setTimeout(r, 500));
    check('«Выйти» уходит в main', mcpCalls.some((c) => c.type === 'logout' && c.name === 'remote'), JSON.stringify(mcpCalls));
    const scopeText = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.mcp-scope')].map((e) => e.textContent).join('|')`);
    check('область сервера видна', /глобальный/.test(scopeText) && /только у меня/.test(scopeText), scopeText);
    await win.webContents.executeJavaScript(`(() => {
      const m = document.querySelector('.modal');
      const inputs = m.querySelectorAll('input');
      const byPh = (ph) => [...inputs].find((i) => i.placeholder === ph);
      byPh('filesystem').value = 'mine';
      byPh('npx').value = 'node';
      byPh('-y @modelcontextprotocol/server-filesystem C:\\\\project').value = 'srv.js --flag';
      m.querySelector('.mcp-add-scope').value = 'local';
      [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Добавить').click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const saved = mcpCalls.find((c) => c.type === 'saveLocal');
    check('«только у меня» уходит в mcp:saveLocal', saved?.name === 'mine' && saved?.config?.command === 'node' && saved?.config?.args?.join(' ') === 'srv.js --flag', JSON.stringify(saved));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[29] Каталоги пакетов: обновление и установка (ADR 0042)');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/packages'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    const rows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.market-row')].map((r) => ({ name: r.dataset.package, text: r.textContent, button: r.querySelector('.market-install')?.textContent || '', primary: Boolean(r.querySelector('.market-install.primary')) }))`);
    const row = (n) => rows.find((r) => r.name === n) || {};
    check('каталог и его пакеты показаны', rows.length === 3 && /Пакеты команды/.test(await win.webContents.executeJavaScript(`document.querySelector('.market-head')?.textContent || ''`)), JSON.stringify(rows));
    check('есть обновление — «Обновить» с установленной версией', row('review-kit').button === 'Обновить' && row('review-kit').primary && /установлена 1\.2\.0/.test(row('review-kit').text), JSON.stringify(row('review-kit')));
    check('не установлен — «Установить»', row('docs-kit').button === 'Установить' && !row('docs-kit').primary, JSON.stringify(row('docs-kit')));
    check('актуальный — без кнопки', row('git-kit').button === '' && /установлен/.test(row('git-kit').text), JSON.stringify(row('git-kit')));
    await win.webContents.executeJavaScript(`document.querySelector('.market-row[data-package=review-kit] .market-install').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('«Обновить» — установка с заменой', marketCalls.some((c) => c.type === 'install' && c.marketplace === 'team' && c.name === 'review-kit' && c.replace === true), JSON.stringify(marketCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.market-row[data-package=docs-kit] .market-install').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('«Установить» — без замены', marketCalls.some((c) => c.type === 'install' && c.name === 'docs-kit' && c.replace === false), JSON.stringify(marketCalls));
    const updated = await win.webContents.executeJavaScript(`document.querySelectorAll('.market-install').length`);
    check('после установки кнопок не осталось', updated === 0, String(updated));
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('.market-url'); i.value = 'https://git.example.com/other.git'; [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Добавить').click(); })()`);
    await new Promise((r) => setTimeout(r, 300));
    check('каталог добавляется по адресу', marketCalls.some((c) => c.type === 'add' && c.url === 'https://git.example.com/other.git'), JSON.stringify(marketCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[30] Корзина: /trash и восстановление (ADR 0044)');
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/trash'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    const trashRows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.trash-row')].map((r) => r.textContent)`);
    check('удалённое в списке с путём и размером', trashRows.length === 2 && /\/p\/src\/old\.js/.test(trashRows[0]) && /2\.0 КБ/.test(trashRows[0]) && /файлов: 12/.test(trashRows[1]), JSON.stringify(trashRows));
    await win.webContents.executeJavaScript(`document.querySelector('.trash-row[data-id="1700000000000-aaaaaaaa"] .trash-restore').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('«Восстановить» уходит в main', trashCalls.some((c) => c.type === 'restore' && c.id === '1700000000000-aaaaaaaa' && c.overwrite === false), JSON.stringify(trashCalls));
    check('список обновился', (await win.webContents.executeJavaScript(`document.querySelectorAll('.trash-row').length`)) === 1);
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[31] Рабочие папки чата (ADR 0045)');
    win.webContents.send('chat:event', { type: 'saved', sessionId: 's-dirs' });
    win.webContents.send('chat:event', { type: 'done', sessionId: 's-dirs', messages: [] });
    await new Promise((r) => setTimeout(r, 500));
    const bar = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#work-dirs'); return { hidden: b.hidden, text: b.textContent, chips: [...b.querySelectorAll('.work-dir')].map((c) => c.textContent) }; })()`);
    check('строка папок видна у чата', bar.hidden === false && dirCalls.some((c) => c.type === 'dirs' && c.sessionId === 's-dirs'), JSON.stringify(bar));
    check('только доп. папки и пропавшая, без дубля проекта', !bar.chips.includes('proj') && bar.chips.some((c) => c.startsWith('@Документы')) && bar.chips.some((c) => /old \(нет на диске\)/.test(c)), JSON.stringify(bar.chips));
    await win.webContents.executeJavaScript(`document.querySelector('.work-dir-add').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const afterAdd = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#work-dirs .work-dir')].map((c) => c.textContent)`);
    check('«＋ папка» — выбор в main и обновление', dirCalls.some((c) => c.type === 'add' && c.sessionId === 's-dirs') && afterAdd.some((c) => c.startsWith('@Финансы')), JSON.stringify(afterAdd));
    await win.webContents.executeJavaScript(`document.querySelector('.work-dir[data-dir="/home/u/Документы"] .work-dir-remove').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const afterRemove = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#work-dirs .work-dir')].map((c) => c.textContent)`);
    check('× убирает доступ', dirCalls.some((c) => c.type === 'remove' && c.dir === '/home/u/Документы') && !afterRemove.some((c) => c.startsWith('@Документы')), JSON.stringify(afterRemove));

    console.log('\n[32] «Код / Задача» (ADR 0046)');
    const kindState = () => win.webContents.executeJavaScript(`({ active: document.querySelector('#kind-toggle .kind-btn.active')?.dataset.kind, placeholder: document.querySelector('#input').placeholder })`);
    let k = await kindState();
    check('по умолчанию — «Код»', k.active === 'code', JSON.stringify(k));
    await win.webContents.executeJavaScript(`document.querySelector('#kind-toggle [data-kind=task]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    k = await kindState();
    check('«Задача»: кнопка активна, подсказка про документы', k.active === 'task' && /документами/.test(k.placeholder), JSON.stringify(k));
    check('выбор уходит в main для текущего чата', kindCalls.some((c) => c.kind === 'task' && c.sessionId === 's-dirs'), JSON.stringify(kindCalls));
    await win.webContents.executeJavaScript(`document.querySelector('#kind-toggle [data-kind=code]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('обратно в «Код»', (await kindState()).active === 'code');

    console.log('\n[33] Результаты чата (ADR 0047)');
    win.webContents.send('chat:event', { type: 'done', sessionId: 's-dirs', messages: [] });
    await new Promise((r) => setTimeout(r, 500));
    const resBtn = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#results-btn'); return { hidden: b.hidden, text: b.textContent }; })()`);
    check('кнопка «Результаты · 3»', resBtn.hidden === false && resBtn.text === '📄 Результаты · 3', JSON.stringify(resBtn));
    await win.webContents.executeJavaScript(`document.querySelector('#results-btn').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const rrows = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.result-row')].map((r) => ({ name: r.querySelector('.result-name').textContent, text: r.textContent, open: Boolean(r.querySelector('.result-open')) }))`);
    check('статусы и размер', /создан · 2\.0 КБ/.test(rrows[0]?.text) && /удалён · в корзине/.test(rrows[2]?.text), JSON.stringify(rrows));
    check('«Открыть» только у документа', rrows[0].open && !rrows[1].open && !rrows[2].open, JSON.stringify(rrows));
    await win.webContents.executeJavaScript(`document.querySelector('.result-row .result-name').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('превью текста', (await win.webContents.executeJavaScript(`document.querySelector('.result-preview').textContent`)) === '# Отчёт за квартал');
    await win.webContents.executeJavaScript(`document.querySelector('.result-open').click(); document.querySelectorAll('.result-show')[1].click();`);
    await new Promise((r) => setTimeout(r, 300));
    check('«Открыть» и «В папке» уходят в main с чатом и путём', resultCalls.some((c) => c.type === 'open' && c.file === '/p/отчёт.md' && c.sessionId === 's-dirs') && resultCalls.some((c) => c.type === 'show' && c.file === '/p/run.bat'), JSON.stringify(resultCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[34] Отправка через коннектор: превью (ADR 0048)');
    win.webContents.send('chat:event', {
      type: 'approval',
      id: 'appr-send',
      tool: 'mcp__gmail__send_email',
      name: 'mcp__gmail__send_email',
      cls: 'send',
      summary: 'Отправка через mcp__gmail__send_email',
      args: JSON.stringify({ to: 'boss@example.com', subject: 'Отчёт', body: 'Добрый день!\nОтчёт во вложении.' }, null, 2),
      risk: 'high',
      why: 'отправка от вашего имени спрашивается всегда',
      recommended: 'deny',
      suggestions: [],
    });
    await new Promise((r) => setTimeout(r, 400));
    const sendCard = await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.approval-card'); return { body: c?.querySelector('.approve-send-body')?.textContent || '', options: c ? c.querySelectorAll('.approve-option').length : 0, rec: c?.querySelector('.approve-option.recommended')?.textContent || '', cls: c?.querySelector('.approve-class')?.textContent || '' }; })()`);
    check('что уйдёт — открыто, по полям', /to: boss@example\.com/.test(sendCard.body) && /subject: Отчёт/.test(sendCard.body) && /Отчёт во вложении/.test(sendCard.body), JSON.stringify(sendCard));
    check('«Да, и не спрашивать» нет; рекомендуется «Нет»', sendCard.options === 2 && /Нет/.test(sendCard.rec), JSON.stringify(sendCard));
    check('класс — отправка от вашего имени', sendCard.cls === 'отправка от вашего имени', sendCard.cls);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    check('Esc — отказ', approvals.some((a) => a.id === 'appr-send' && a.allow === false), JSON.stringify(approvals.filter((a) => a.id === 'appr-send')));

    console.log('\n[35] Плановые задачи: /schedule (ADR 0050)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/schedule'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    const srow = await win.webContents.executeJavaScript(`document.querySelector('.schedule-row')?.textContent || ''`);
    check('задача с расписанием и последним запуском', /Сводка/.test(srow) && /по будням в 09:00/.test(srow) && /готово/.test(srow), srow);
    await win.webContents.executeJavaScript(`document.querySelector('.schedule-row .schedule-run').click()`);
    await new Promise((r) => setTimeout(r, 400));
    check('«Запустить» — в main', schedCalls.some((c) => c.type === 'run' && c.id === 't1'), JSON.stringify(schedCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.schedule-row input[type=checkbox]').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('флажок выключает задачу', schedCalls.some((c) => c.type === 'save' && c.id === 't1' && c.enabled === false), JSON.stringify(schedCalls));
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.schedule-row button')].find((b) => b.textContent === 'Журнал').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('журнал запусков', /Сводка готова/.test(await win.webContents.executeJavaScript(`document.querySelector('.schedule-log')?.textContent || ''`)));
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.schedule-title').value = 'Почта';
      document.querySelector('.schedule-prompt-input').value = 'Разбери входящие';
      document.querySelector('.schedule-type').value = 'daily';
      document.querySelector('.schedule-time').value = '07:30';
      document.querySelector('.schedule-add').click();
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const added = schedCalls.find((c) => c.type === 'save' && c.title === 'Почта');
    check('новая задача: каждый день в 07:30, вид «Задача»', added?.schedule?.type === 'daily' && added.schedule.time === '07:30' && added.schedule.days.length === 7 && added.kind === 'task' && added.prompt === 'Разбери входящие', JSON.stringify(added));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[36] Прерванная работа: «Продолжить» (ADR 0051)');
    await win.webContents.executeJavaScript(`loadSession('s-int')`).catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    let banner = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#run-banner'); return { hidden: b.hidden, text: b.textContent }; })()`);
    if (banner.hidden) {
      // loadSession не в глобальной области — открываем через событие уведомления.
      win.webContents.send('chat:event', { type: 'scheduled:open', sessionId: 's-int' });
      await new Promise((r) => setTimeout(r, 500));
      banner = await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#run-banner'); return { hidden: b.hidden, text: b.textContent }; })()`);
    }
    check('плашка «Работа прервалась» с прогрессом задач', banner.hidden === false && /Работа прервалась/.test(banner.text) && /сделано 1 из 3 задач/.test(banner.text), JSON.stringify(banner));
    const startsBefore = chatStarts.length;
    await win.webContents.executeJavaScript(`document.querySelector('.run-continue').click()`);
    await new Promise((r) => setTimeout(r, 500));
    const cont = chatStarts.slice(startsBefore)[0];
    check('«Продолжить» отправляет агенту просьбу продолжить без повторов', cont && /Продолжи с того места/.test(cont.text) && /не повторяй выполненные шаги/.test(cont.text) && cont.displayText === 'Продолжить прерванную работу' && cont.sessionId === 's-int', JSON.stringify(cont));
    check('текущий шаг в заголовке задач', /сейчас: Свести/.test(await win.webContents.executeJavaScript(`document.querySelector('.todos-head')?.textContent || ''`)));
    check('плашка скрыта после продолжения', await win.webContents.executeJavaScript(`document.querySelector('#run-banner').hidden`));

    console.log('\n[37] Каталог коннекторов (ADR 0052)');
    await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = '/connectors'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    const cards = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.connector:not(.local)')].map((c) => ({ id: c.dataset.id, text: c.textContent, token: Boolean(c.querySelector('.connector-token')), add: Boolean(c.querySelector('.connector-add')), remove: Boolean(c.querySelector('.connector-remove')) }))`);
    const connCard = (id) => cards.find((c) => c.id === id) || {};
    check('карточки каталога', cards.length === 4 && /Вход через браузер/.test(connCard('linear').text) && connCard('linear').add, JSON.stringify(cards));
    check('токен — поле только у токенных', connCard('github').token && !connCard('linear').token);
    check('подключённый — «нужен вход» и «Отключить»', /нужен вход/.test(connCard('notion').text) && connCard('notion').remove && !connCard('notion').add);
    check('коннектор организации помечен', /от организации/.test(connCard('1c').text));
    await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.connector[data-id=github]'); c.querySelector('.connector-token').value = 'ghp_x'; c.querySelector('.connector-add').click(); })()`);
    await new Promise((r) => setTimeout(r, 500));
    check('токен уходит в main при подключении', connCalls.some((c) => c.type === 'add' && c.id === 'github' && c.token === 'ghp_x'), JSON.stringify(connCalls));
    await win.webContents.executeJavaScript(`document.querySelector('.connector[data-id=linear] .connector-add').click()`);
    await new Promise((r) => setTimeout(r, 500));
    check('OAuth-коннектор подключается без токена', connCalls.some((c) => c.type === 'add' && c.id === 'linear' && !c.token));
    const linearAfter = await win.webContents.executeJavaScript(`document.querySelector('.connector[data-id=linear]').textContent`);
    check('после подключения — «подключён»', /подключён/.test(linearAfter), linearAfter);
    // Локальные коннекторы (CW3.3, ADR 0072).
    const locals = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.connector.local')].map((c) => c.dataset.id + ':' + c.querySelector('.badge').textContent + ':' + c.querySelector('.local-action').textContent).join('|')`);
    check('локальные — карточками в том же окне', locals === 'repowise:выключен:Включить|multica:не настроен:Установить|postgres:работает:Настроить', locals);
    await win.webContents.executeJavaScript(`document.querySelector('.connector.local[data-id=repowise] .local-action').click()`);
    await new Promise((r) => setTimeout(r, 400));
    const rwAfter = await win.webContents.executeJavaScript(`document.querySelector('.connector.local[data-id=repowise]').textContent`);
    check('«Включить» Repowise — сразу здесь', localCalls.join() === 'repowise:true' && /работает/.test(rwAfter) && /Выключить/.test(rwAfter), `${localCalls} ${rwAfter}`);
    await win.webContents.executeJavaScript(`document.querySelector('.connector.local[data-id=postgres] .local-action').click()`);
    await new Promise((r) => setTimeout(r, 300));
    check('«Настроить» хранилище — окно «Хранилища» на вкладке infra', boardOpens.some((b) => b.board === 'storage' && b.focus === 'tab:infra'), JSON.stringify(boardOpens));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[38] Глубина рассуждений в поле ввода (ADR 0058)');
    win.webContents.send('chat:event', { type: 'done', sessionId: 's-dirs', messages: [] });
    await new Promise((r) => setTimeout(r, 400));
    const eff = await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('#effort-select'); return { hidden: s.hidden, options: [...s.options].filter((o) => !o.hidden).map((o) => o.value) }; })()`);
    check('переключатель виден у модели с глубиной', eff.hidden === false && eff.options.join() === ',low,medium,high', JSON.stringify(eff));
    await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('#effort-select'); s.value = 'high'; s.dispatchEvent(new Event('change')); const i = document.querySelector('#input'); i.value = 'подумай глубоко'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await new Promise((r) => setTimeout(r, 500));
    check('глубина уходит с запросом', chatStarts.at(-1)?.effort === 'high', JSON.stringify(chatStarts.at(-1)));

    console.log('\n[39] /commit и /review (ADR 0059)');
    const slash = async (text) => {
      await win.webContents.executeJavaScript(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
      await new Promise((r) => setTimeout(r, 400));
      return chatStarts.at(-1);
    };
    const commit = await slash('/commit только тесты');
    check('/commit: смотреть diff, без push и секретов, подтверждение', /git diff/.test(commit?.text) && /Не делай `git push`/.test(commit?.text) && /секретами/.test(commit?.text) && /только тесты/.test(commit?.text) && commit?.displayText === '/commit только тесты', JSON.stringify(commit)?.slice(0, 300));
    const review = await slash('/review 42');
    check('/review 42: gh pr diff 42, только чтение, файл:строка', /gh pr diff 42/.test(review?.text) && /файлы не меняй/.test(review?.text) && /`файл:строка`/.test(review?.text));
    const local = await slash('/review');
    check('/review без номера — git diff HEAD', /git diff HEAD/.test(local?.text));

    console.log('\n[40] Проекты (ADR 0065)');
    await win.webContents.executeJavaScript(`document.querySelector('#projects-btn').click()`);
    await new Promise((r) => setTimeout(r, 500));
    const prow = await win.webContents.executeJavaScript(`document.querySelector('.project-row')?.textContent || ''`);
    check('проект в списке: папки, вид, коннекторы', /Отчётность/.test(prow) && /\/p\/reports \+ ещё 1/.test(prow) && /Задача/.test(prow) && /gmail/.test(prow), prow);
    await win.webContents.executeJavaScript(`document.querySelector('.project-open').click()`);
    await new Promise((r) => setTimeout(r, 500));
    check('«Открыть» — проект в main и вид «Задача» для нового чата', projCalls.some((c) => c.type === 'activate' && c.id === 'pr1') && kindCalls.some((c) => c.kind === 'task' && !c.sessionId), JSON.stringify({ projCalls, kindCalls: kindCalls.slice(-2) }));
    await win.webContents.executeJavaScript(`document.querySelector('.project-new').click()`);
    await new Promise((r) => setTimeout(r, 300));
    await win.webContents.executeJavaScript(`document.querySelector('.project-pick').click()`);
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`document.querySelector('.project-add-dir').click()`);
    await new Promise((r) => setTimeout(r, 200));
    await win.webContents.executeJavaScript(`(() => { document.querySelector('.project-name-input').value = 'Новый'; document.querySelector('.project-instructions').value = 'правила'; document.querySelector('.project-kind').value = 'code'; document.querySelector('.project-sandbox').value = 'docker'; document.querySelector('.project-save').click(); })()`);
    await new Promise((r) => setTimeout(r, 400));
    const savedProject = projCalls.find((c) => c.type === 'save');
    check('новый проект: папки из диалога, инструкции, вид', savedProject?.name === 'Новый' && savedProject.primaryDir === '/p/new-main' && savedProject.extraDirs.join() === '/p/new-extra' && savedProject.instructions === 'правила' && savedProject.kind === 'code' && savedProject.sandbox === 'docker', JSON.stringify(savedProject));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[41] Онбординг: роль → набор → коннекторы → пример (ADR 0070)');
    const ui = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '/onboarding'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await wait(500);
    const roleCards = await ui(`[...document.querySelectorAll('.role-card')].map((c) => c.dataset.role + ':' + c.classList.contains('installed')).join()`);
    check('/onboarding: карточки ролей, установленный отмечен', roleCards === 'developer:false,finance:true', roleCards);
    await ui(`document.querySelector('.role-card[data-role=developer]').click()`);
    await wait(400);
    const step2 = await ui(`document.querySelector('.onboarding-installed')?.textContent || ''`);
    check('выбор роли ставит набор и показывает, что в нём', roleCalls.join() === 'developer' && /навыков 1, команд 1/.test(step2), step2);
    await ui(`document.querySelector('.onboarding-connect').click()`);
    await wait(500);
    const shown = await ui(`[...document.querySelectorAll('.connector')].map((c) => c.dataset.id).join()`);
    check('«Подключить коннекторы» — только коннекторы роли', shown === 'linear,github', shown);
    const doneSave = savedSettings.findLast((s) => s.onboarding);
    check('закрытие мастера запоминает «пройден» и роль', doneSave?.onboarding?.done === true && doneSave.onboarding.role === 'developer', JSON.stringify(doneSave));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '/onboarding'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await wait(500);
    await ui(`document.querySelector('.role-card[data-role=finance]').click()`);
    await wait(400);
    const noConn = await ui(`!document.querySelector('.onboarding-connect')`);
    await ui(`document.querySelector('.onboarding-next').click()`);
    await wait(200);
    await ui(`[...document.querySelectorAll('.onboarding-example')][0].click()`);
    await wait(200);
    const inputText = await ui(`document.querySelector('#input').value`);
    const modalGone = await ui(`!document.querySelector('.role-cards, .onboarding-examples')`);
    check('роль без коннекторов; пример задачи — в поле ввода, мастер закрыт', noConn && inputText === 'Сверь выписку банка с реестром' && modalGone, JSON.stringify({ noConn, inputText, modalGone }));

    console.log('\n[42] MCP: ресурсы @сервер:uri и промпты /mcp__… (ADR 0071)');
    await ui(`(() => { const i = document.querySelector('#input'); i.value = 'смотри @sch'; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(500);
    const resItems = await ui(`[...document.querySelectorAll('#suggest .suggest-item')].map((b) => b.textContent).join('|')`);
    check('@ подсказывает ресурс MCP', resItems === 'db:db://schema', resItems);
    await ui(`(() => { const i = document.querySelector('#input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); })()`);
    await wait(200);
    check('выбор вставляет @сервер:uri', (await ui(`document.querySelector('#input').value`)) === 'смотри @db:db://schema ');
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '/mcp__'; i.setSelectionRange(6, 6); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(400);
    const promptItem = await ui(`document.querySelector('#suggest .suggest-item')?.textContent || ''`);
    check('промпт MCP в списке команд с аргументами и меткой', /\/mcp__db__review/.test(promptItem) && /<file> \[focus\]/.test(promptItem) && /MCP$/.test(promptItem), promptItem);
    await ui(`(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    console.log('\n[43] Чаты: имя, копия, файл, точки отката (ADR 0073)');
    await ui(`[...document.querySelectorAll('.session')].find((s) => s.textContent.includes('Тестовый диалог'))?.click()`);
    await wait(500);
    await ui(`document.querySelector('.session.active .session-rename').click()`);
    await wait(200);
    await ui(`(() => { const i = document.querySelector('.rename-input'); i.value = 'Отчёт за март'; document.querySelector('.rename-save').click(); })()`);
    await wait(300);
    check('✎ — переименование уходит в main', sessCalls.some((c) => c.type === 'rename' && c.id === 'test-session' && c.title === 'Отчёт за март'), JSON.stringify(sessCalls));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '/rename Новое имя'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await wait(400);
    check('/rename с именем — без окна', sessCalls.some((c) => c.type === 'rename' && c.title === 'Новое имя'));
    await ui(`document.querySelector('.session.active .session-fork').click()`);
    await wait(500);
    check('⑂ — копия чата', sessCalls.some((c) => c.type === 'fork' && c.id === 'test-session'));
    await ui(`(() => { document.activeElement?.blur(); for (let k = 0; k < 2; k += 1) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
    await wait(300);
    const points = await ui(`[...document.querySelectorAll('.rewind-point')].map((b) => b.textContent).join('|')`);
    check('двойной Esc — список точек отката, правки отмечены', points === '✎ Покажи отчёт', points);
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await wait(200);
    await ui(`document.querySelector('#export-chat').click()`);
    await wait(300);
    await ui(`[...document.querySelectorAll('.export-picker button')].find((b) => b.textContent.startsWith('Файл чата MAI'))?.click()`);
    await wait(300);
    check('«Скачать чат» → файл чата MAI', sessCalls.some((c) => c.type === 'export' && c.id === 'test-session'), JSON.stringify(sessCalls));

    console.log('\n[44] Тема: светлая, тёмная, как в системе (ADR 0074)');
    const bgNow = () => ui(`getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()`);
    nativeTheme.themeSource = 'light';
    await wait(300);
    const lightBg = await bgNow();
    if (process.env.MAI_SHOT) {
      win.webContents.invalidate();
      await wait(1000);
      fs.writeFileSync(process.env.MAI_SHOT, (await win.webContents.capturePage()).toPNG());
    }
    nativeTheme.themeSource = 'dark';
    await wait(300);
    const darkBg = await bgNow();
    check('светлая и тёмная палитры по prefers-color-scheme', lightBg === '#f6f7fb' && darkBg === '#0f1117', `${lightBg} ${darkBg}`);
    await ui(`document.querySelector('#settings-btn').click()`);
    await wait(500);
    const themeOptions = await ui(`(() => { const t = document.querySelector('.theme-select'); const v = [...t.options].map((o) => o.value).join(); t.value = 'system'; [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Сохранить').click(); return v; })()`);
    await wait(400);
    check('настройка «Тема» сохраняется', themeOptions === 'dark,light,system' && savedSettings.at(-1)?.theme === 'system', `${themeOptions} ${savedSettings.at(-1)?.theme}`);
    check('поле «Модель для Плана» сохраняется', savedSettings.at(-1)?.planModel === '', JSON.stringify(savedSettings.at(-1)?.planModel));
    const ns = savedSettings.at(-1)?.notifications;
    check('уведомления: по умолчанию все виды на рабочем столе, каналов нет', ns?.enabled === true && ns.desktop.length === 6 && Array.isArray(ns.channels) && ns.channels.length === 0, JSON.stringify(ns));
    // Канал Telegram: добавить, заполнить, сохранить; у MAX — поля бота и адресата.
    await ui(`document.querySelector('#settings-btn').click()`);
    await wait(500);
    const chanFields = await ui(`(() => {
      document.querySelector('.channel-add').click();
      const row = document.querySelector('.notify-channel:last-child');
      const typeSel = row.querySelector('.channel-type');
      const types = [...typeSel.options].map((o) => o.value).join();
      typeSel.value = 'max';
      typeSel.dispatchEvent(new Event('change'));
      const maxFields = [...row.querySelectorAll('[data-field]')].map((i) => i.dataset.field).join();
      typeSel.value = 'telegram';
      typeSel.dispatchEvent(new Event('change'));
      row.querySelector('[data-field=token]').value = '123:ABC';
      row.querySelector('[data-field=chatId]').value = '-100500';
      [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Сохранить').click();
      return { types, maxFields };
    })()`);
    await wait(400);
    const savedChan = savedSettings.at(-1)?.notifications?.channels?.[0];
    check('каналы: Telegram, MAX, WhatsApp, Rocket.Chat, webhook; у MAX — токен, адресат, адрес API', chanFields.types === 'telegram,max,whatsapp,rocketchat,webhook' && chanFields.maxFields === 'token,chatId,target,apiBase', JSON.stringify(chanFields));
    check('канал Telegram сохраняется с токеном, chat_id и событиями', savedChan?.type === 'telegram' && savedChan.token === '123:ABC' && savedChan.chatId === '-100500' && savedChan.kinds.join() === 'done,error,scheduled' && savedChan.enabled === true, JSON.stringify(savedChan));

    console.log('\n[45] Статусная строка, !команда, доступность (ADR 0074)');
    await wait(300);
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await wait(300);
    const status = await ui(`(() => { const s = document.querySelector('#statusline'); return { role: s.getAttribute('role'), text: s.textContent, branch: Boolean(s.querySelector('.status-branch')), mode: Boolean(s.querySelector('.status-mode')) }; })()`);
    check('статусная строка: модель · режим · ветка, role=status', status.role === 'status' && /⎇ dev/.test(status.text) && status.mode, JSON.stringify(status));
    await ui(`document.querySelector('#settings-btn').click()`);
    await wait(500);
    await ui(`(() => { document.querySelector('.statusline-item[data-item=context]').checked = true; document.querySelector('.statusline-item[data-item=cost]').checked = false; [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Сохранить').click(); })()`);
    await wait(400);
    check('состав строки сохраняется', JSON.stringify(savedSettings.at(-1)?.statusLine) === JSON.stringify(['model', 'mode', 'branch', 'context']), JSON.stringify(savedSettings.at(-1)?.statusLine));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '!npm test'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await wait(500);
    check('!команда уходит в main без модели', directCalls.length === 1 && directCalls[0].command === 'npm test' && chatStarts.every((c) => c.text !== '!npm test'), JSON.stringify(directCalls));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = ''; })()`);
    // Окно: dialog с подписью, фокус внутри, Esc закрывает и возвращает фокус.
    await ui(`document.querySelector('#settings-btn').focus(); document.querySelector('#settings-btn').click()`);
    await wait(500);
    const dlg = await ui(`(() => { const m = document.querySelector('.modal'); const id = m.getAttribute('aria-labelledby'); return { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), title: document.getElementById(id)?.textContent, inside: m.contains(document.activeElement) }; })()`);
    check('окно — role=dialog, aria-modal, подпись, фокус внутри', dlg.role === 'dialog' && dlg.modal === 'true' && dlg.title === 'Настройки' && dlg.inside, JSON.stringify(dlg));
    await ui(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(200);
    const after = await ui(`({ open: Boolean(document.querySelector('.modal-backdrop')), focus: document.activeElement?.id })`);
    check('Esc закрывает окно, фокус возвращается на кнопку', !after.open && after.focus === 'settings-btn', JSON.stringify(after));
    const labels = await ui(`['settings-btn', 'attach', 'send', 'stop'].every((id) => document.getElementById(id)?.getAttribute('aria-label'))`);
    check('кнопки-значки подписаны для читалок экрана', labels === true);

    console.log('\n[47] «Запомнить?» после прогона (F4, ADR 0084)');
    const curSession = await ui(`document.querySelector('.session.active')?.textContent ? 'test-session' : ''`);
    win.webContents.send('chat:event', { type: 'memory:suggest', sessionId: 'test-session', text: 'Тесты запускай через npm test -- --watch=false' });
    await wait(300);
    const memBar = await ui(`document.querySelector('.memory-suggest')?.textContent || ''`);
    check('плашка «Запомнить?» с уроком и тремя кнопками', /Запомнить: «Тесты запускай через npm test/.test(memBar) && /В проект/.test(memBar) && /Глобально/.test(memBar) && /Нет/.test(memBar), `${curSession} ${memBar}`);
    const before = memoryAppends.length;
    await ui(`document.querySelector('.memory-suggest-project').click()`);
    await wait(300);
    check('«В проект» — в память проекта, плашка уходит', memoryAppends.length === before + 1 && memoryAppends.at(-1).scope === 'project' && /npm test/.test(memoryAppends.at(-1).text) && (await ui(`!document.querySelector('.memory-suggest')`)), JSON.stringify(memoryAppends.at(-1)));
    win.webContents.send('chat:event', { type: 'memory:suggest', sessionId: 'другой-чат', text: 'x' });
    await wait(200);
    check('урок чужого чата не показывается', await ui(`!document.querySelector('.memory-suggest')`));

    console.log('\n[46] Git: /pr, /security-review, /worktree (ADR 0076)');
    const sec = await slash('/security-review 7');
    check('/security-review 7: gh pr diff, только чтение, путь атаки и уверенность', /gh pr diff 7/.test(sec?.text) && /файлы не меняй/.test(sec?.text) && /путь атаки/.test(sec?.text) && /уверенность/.test(sec?.text), sec?.text?.slice(0, 200));
    const pr = await slash('/pr для релиза');
    check('/pr: шаблон репозитория, не пушить в защищённую, без merge', /pull_request_template/.test(pr?.text) && /в защищённую ветку не пушь/.test(pr?.text) && /Не мерджи PR/.test(pr?.text) && /для релиза/.test(pr?.text), pr?.text?.slice(0, 200));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = '/worktree'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await wait(500);
    const wtRows = await ui(`[...document.querySelectorAll('.worktree-row')].map((r) => r.querySelector('b').textContent + ':' + Boolean(r.querySelector('.worktree-remove'))).join('|')`);
    check('/worktree: основная папка и копии, убрать — только копию', wtRows === 'основная папка:false|mai/wt-fix:true', wtRows);
    await ui(`(() => { document.querySelector('.worktree-name').value = 'new task'; document.querySelector('.worktree-create').click(); })()`);
    await wait(600);
    check('«Создать и открыть» — новая копия, чат в ней', wtCalls.some((c) => c.type === 'create' && c.name === 'new task'), JSON.stringify(wtCalls));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = ''; })()`);

    console.log('\n[48] Агент схем: diff и «Применить» (F10, ADR 0086)');
    const arch = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await arch.loadFile(path.join(root, 'renderer', 'board.html'), { query: { board: 'architecture' } });
    await wait(1500);
    const archUi = (code) => arch.webContents.executeJavaScript(code);
    await archUi(`(() => { const i = document.querySelector('#diagram-agent-input'); i.value = 'добавь Redis'; document.querySelector('[data-act=diagram-agent-send]').click(); })()`);
    await wait(600);
    const prop = await archUi(`(() => { const p = document.querySelector('.diagram-proposal'); return p ? { text: p.textContent, add: Boolean(p.querySelector('.diff-add')), apply: Boolean(p.querySelector('[data-act=diagram-apply]')) } : null; })()`);
    check('ответ агента — предложение с diff и кнопками, модель не тронута', prop && /\+1 −0/.test(prop.text) && prop.add && prop.apply && diagramApplies.length === 0, JSON.stringify(prop));
    await archUi(`document.querySelector('[data-act=diagram-apply]').click()`);
    await wait(500);
    const archAfter = await archUi(`document.querySelector('.diagram-proposal')?.textContent || ''`);
    check('«Применить» — запись с отпечатком базы, статус «применено»', diagramApplies.length === 1 && diagramApplies[0].baseHash === 'h1' && /redis/.test(JSON.stringify(diagramApplies[0].proposal)) && /применено/.test(archAfter) && !(await archUi(`Boolean(document.querySelector('[data-act=diagram-apply]'))`)), JSON.stringify(diagramApplies));
    arch.destroy();

    console.log('\n[49] Автосинхронизация хранилища (F12, ADR 0087)');
    const store = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await store.loadFile(path.join(root, 'renderer', 'board.html'), { query: { board: 'storage' } });
    await wait(1200);
    const storeUi = (code) => store.webContents.executeJavaScript(code);
    await storeUi(`document.querySelector('[data-act=storage-tab][data-tab=infra]')?.click()`);
    await wait(600);
    const manual = await storeUi(`document.querySelector('.auto-sync-status')?.textContent || ''`);
    check('по умолчанию выключено — «вручную»', /вручную/.test(manual) && !(await storeUi(`document.querySelector('#infra-auto-sync').checked`)), manual);
    const syncSavedFrom = savedSettings.length;
    await storeUi(`document.querySelector('#infra-auto-sync').click()`);
    await wait(900);
    check('флажок сохраняет infra.autoSync', savedSettings.slice(syncSavedFrom).some((p) => p.infra?.autoSync === true), JSON.stringify(savedSettings.slice(syncSavedFrom)));
    const line = await storeUi(`document.querySelector('.auto-sync-status')?.textContent || ''`);
    check('состояние очереди: повтор, правок, ошибка', /ошибка, повтор/.test(line) && /правок в очереди: 2/.test(line) && /connection refused/.test(line), line);
    await storeUi(`document.querySelector('[data-act=infra-sync-now]').click()`);
    await wait(500);
    const synced = await storeUi(`document.querySelector('.auto-sync-status')?.textContent || ''`);
    check('«Синхронизировать сейчас» — прогон и «синхронизировано»', syncNowCalls.length === 1 && /синхронизировано/.test(synced), synced);

    console.log('\n[50] Repowise: MCP-сервер и перезапуск (F13, ADR 0088)');
    await storeUi(`document.querySelector('[data-act=storage-tab][data-tab=repowise]')?.click()`);
    await wait(700);
    const rwCard = await storeUi(`document.querySelector('.repowise-mcp')?.textContent.replace(/\\s+/g, ' ') || ''`);
    check('карточка MCP: отвечает, перезапусков и причина', /отвечает/.test(rwCard) && /перезапусков: 1/.test(rwCard) && /таймаут ask/.test(rwCard), rwCard);
    await storeUi(`document.querySelector('[data-act=repowise-restart]').click()`);
    await wait(700);
    const rwCard2 = await storeUi(`document.querySelector('.repowise-mcp')?.textContent || ''`);
    check('«Перезапустить» — вызов и обновлённый счётчик', rwRestarts === 2 && /перезапусков: 2/.test(rwCard2), rwCard2);
    store.destroy();

    console.log('\n[51] Multica: статусы обратно в tasks.md (F14, ADR 0089)');
    await ui(`document.querySelector('[data-panel=multica]').click()`);
    await wait(700);
    const pullBtn = await ui(`Boolean(document.querySelector('.modal-backdrop .multica-pull'))`);
    check('в панели Multica — «Статусы → tasks.md»', pullBtn);
    await ui(`document.querySelector('.modal-backdrop .multica-pull').click()`);
    await wait(500);
    const pullToasts = await ui(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
    check('вызов с папкой проекта и отчёт: отмечено, отменено', multicaPulls.length === 1 && multicaPulls[0] && /отмечено 1/.test(pullToasts) && /Отменены в Multica/.test(pullToasts), `${JSON.stringify(multicaPulls)} ${pullToasts}`);
    const wsState = await ui(`(() => { const ws = document.querySelector('.modal-backdrop .multica-ws'); const pr = document.querySelector('.modal-backdrop .multica-project'); return { ws: ws?.value, wsCount: ws?.options.length, prOptions: [...(pr?.options || [])].map((o) => o.value).join(',') }; })()`);
    check('Multica: workspace проекта выбран, проекты workspace загружены (E2.3)', wsState.ws === 'ws-team' && wsState.wsCount === 3 && wsState.prOptions === ',pr-mai' && multicaProjectCalls.includes('ws-team'), JSON.stringify(wsState));
    await ui(`(() => { const pr = document.querySelector('.modal-backdrop .multica-project'); pr.value = 'pr-mai'; document.querySelector('.modal-backdrop .multica-save-target').click(); })()`);
    await wait(400);
    const savedToasts = await ui(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
    check('«Сохранить для проекта»: workspace, проект, scope project и подсказка про git', multicaTargets.length === 1 && multicaTargets[0].workspaceId === 'ws-team' && multicaTargets[0].projectId === 'pr-mai' && multicaTargets[0].scope === 'project' && multicaTargets[0].projectDir && /закоммитьте/.test(savedToasts), `${JSON.stringify(multicaTargets)} ${savedToasts}`);
    await ui(`(() => { const ws = document.querySelector('.modal-backdrop .multica-ws'); ws.value = 'ws-own'; ws.dispatchEvent(new Event('change')); })()`);
    await wait(400);
    const ownProjects = await ui(`[...document.querySelector('.modal-backdrop .multica-project').options].map((o) => o.value).join(',')`);
    check('смена workspace перезагружает проекты', ownProjects === '' && multicaProjectCalls.includes('ws-own'), ownProjects);
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[52] Калибратор архитектуры и PRD (F15, ADR 0090)');
    const cal = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await cal.loadFile(path.join(root, 'renderer', 'board.html'), { query: { board: 'architecture' } });
    await wait(1200);
    const calUi = (code) => cal.webContents.executeJavaScript(code);
    await calUi(`document.querySelector('[data-act=arch-tab][data-tab=calibration]').click()`);
    await wait(500);
    const calPrev = await calUi(`document.querySelector('.calibration')?.textContent || ''`);
    check('вкладка «Калибровка» — прошлый отчёт из артефакта', /Прошлый отчёт/.test(calPrev) && /Нет SSO/.test(calPrev), calPrev.slice(0, 200));
    await calUi(`document.querySelector('[data-act=calibrate]').click()`);
    await wait(600);
    const calErr = await calUi(`(() => { const e = document.querySelector('.calibration-error'); return e ? { text: e.textContent, retry: Boolean(e.querySelector('[data-act=calibrate]')), log: document.querySelector('.calibration-log')?.open } : null; })()`);
    check('ошибка — сообщение, «Повторить» и открытый журнал, отчёт на месте', calErr && /180 с/.test(calErr.text) && calErr.retry && calErr.log && /Нет SSO/.test(await calUi(`document.querySelector('.calibration').textContent`)), JSON.stringify(calErr));
    await calUi(`document.querySelector('.calibration-error [data-act=calibrate]').click()`);
    await wait(600);
    const calOk = await calUi(`(() => ({ rows: document.querySelectorAll('.calibration-row').length, diff: document.querySelector('.calibration-diff')?.textContent || '', fresh: [...document.querySelectorAll('.calibration-row')].filter((r) => /новое/.test(r.textContent)).length, tab: document.querySelector('[data-tab=calibration]').textContent, gone: document.querySelector('.calibration').textContent.includes('Ушли: Кто админ') }))()`);
    check('повтор — таблица находок, сравнение и «новое»', calOk.rows === 2 && /новых 1/.test(calOk.diff) && /ушло 1/.test(calOk.diff) && calOk.fresh === 1 && /Калибровка · 2/.test(calOk.tab) && calOk.gone, JSON.stringify(calOk));
    cal.destroy();

    console.log('\n[53] «Проект в отдельной папке» вместо «песочницы» (F16, ADR 0091)');
    const names = await ui(`({ btn: document.querySelector('#new-project-btn').title, docker: document.querySelector('[data-panel=sandbox]').textContent.trim() })`);
    console.log('\n[54] Голос: ошибка на кнопке и повтор записи (F18, ADR 0092)');
    await ui(`document.querySelector('#mic').click()`);
    await wait(400);
    const micDown = await ui(`({ cls: document.querySelector('#mic').className, title: document.querySelector('#mic').title, retry: Boolean(document.querySelector('#mic-retry')) })`);
    check('MAS не запущен — ошибка на кнопке с причиной, без «↻»', /error/.test(micDown.cls) && /MAS не запущен/.test(micDown.title) && !micDown.retry, JSON.stringify(micDown));
    voiceUp = true;
    // Синтетический микрофон: тон из генератора вместо устройства.
    await ui(`navigator.mediaDevices.getUserMedia = async () => { const c = new AudioContext(); const o = c.createOscillator(); const d = c.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream; }; true`);
    await ui(`document.querySelector('#mic').click()`);
    await wait(1500);
    const recording = await ui(`document.querySelector('#mic').classList.contains('recording')`);
    await ui(`document.querySelector('#mic').click()`);
    await wait(800);
    const micFail = await ui(`({ cls: document.querySelector('#mic').className, title: document.querySelector('#mic').title, retry: Boolean(document.querySelector('#mic-retry')) })`);
    check('запись есть, распознавание упало — ошибка и «↻»', recording && voiceSends.length === 1 && voiceSends[0] > 44 && /error/.test(micFail.cls) && /HTTP 500/.test(micFail.title) && micFail.retry, JSON.stringify({ recording, voiceSends, micFail }));
    await ui(`document.querySelector('#input').value = ''`);
    await ui(`document.querySelector('#mic-retry').click()`);
    await wait(600);
    const micOk = await ui(`({ cls: document.querySelector('#mic').className, input: document.querySelector('#input').value, retry: Boolean(document.querySelector('#mic-retry')) })`);
    check('«↻» — та же запись, текст в поле, состояние сброшено', voiceSends.length === 2 && voiceSends[1] === voiceSends[0] && micOk.input === 'надиктованный текст' && !/error/.test(micOk.cls) && !micOk.retry, JSON.stringify({ voiceSends, micOk }));
    await ui(`document.querySelector('#input').value = ''`);

    console.log('\n[55] Корпоративный режим: экран «только вход» (F21, ADR 0093)');
    corporate = true;
    const corp = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await corp.loadFile(path.join(root, 'renderer', 'index.html'));
    await wait(1500);
    const corpUi = (code) => corp.webContents.executeJavaScript(code);
    const login0 = await corpUi(`({ screen: Boolean(document.querySelector('.login-only')), text: document.querySelector('.login-only')?.textContent || '', chats: document.querySelectorAll('.session-item').length })`);
    check('без входа — только экран входа с адресом организации', login0.screen && /Вход через Keycloak обязателен/.test(login0.text) && /sso.example/.test(login0.text) && login0.chats === 0, JSON.stringify(login0));
    await corpUi(`document.querySelector('.login-only-button').click()`);
    await wait(500);
    const login1 = await corpUi(`({ status: document.querySelector('.login-only-status').textContent, button: document.querySelector('.login-only-button').textContent, disabled: document.querySelector('.login-only-button').disabled })`);
    check('вход не удался — причина и «Повторить вход»', /не подтвердил вход/.test(login1.status) && login1.button === 'Повторить вход' && !login1.disabled, JSON.stringify(login1));
    await corpUi(`document.querySelector('.login-only-button').click()`);
    await wait(2500);
    const login2 = await corpUi(`({ screen: Boolean(document.querySelector('.login-only')), input: Boolean(document.querySelector('#input')) })`);
    check('после входа — перезагрузка и обычное окно', loginCalls.length === 2 && !login2.screen && login2.input, JSON.stringify({ loginCalls: loginCalls.length, login2 }));
    corp.destroy();
    corporate = false;

    console.log('\n[56] /signoff — тесты и статус коммита (N1, ADR 0097)');
    const slashCmd = (text) => ui(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
    await slashCmd('/signoff');
    await wait(700);
    const so1 = await ui(`({ title: document.querySelector('.modal-backdrop .modal h2, .modal-backdrop .modal-title')?.textContent || document.querySelector('.modal-backdrop')?.textContent.slice(0, 60), verdict: document.querySelector('.signoff-verdict')?.textContent || '', log: document.querySelector('.signoff-log')?.textContent || '' })`);
    check('тесты упали — ✗ с причиной и вывод тестов', signoffCalls[0]?.fail === false && signoffCalls[0].context === '' && /✗ Тесты не прошли/.test(so1.verdict) && /FAIL test-x.mjs/.test(so1.log), JSON.stringify(so1));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await slashCmd('/signoff fail lint');
    await wait(700);
    const so2 = await ui(`document.querySelector('.signoff-verdict')?.textContent || ''`);
    check('/signoff fail lint — failure на acme/demo', signoffCalls[1]?.fail === true && signoffCalls[1].context === 'lint' && /✓ signoff\/lint = failure на acme\/demo@abcdef1/.test(so2), `${JSON.stringify(signoffCalls[1])} ${so2}`);
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await ui(`document.querySelector('#input').value = ''`);

    console.log('\n[57] /privacy — куда уходят данные (N2, ADR 0098)');
    await slashCmd('/privacy');
    await wait(600);
    const priv = await ui(`({ verdict: document.querySelector('.privacy-verdict')?.textContent || '', items: [...document.querySelectorAll('.privacy-finding')].map((f) => f.className + '|' + f.textContent), list: [...document.querySelectorAll('.privacy-checklist li')].map((l) => l.textContent) })`);
    check('итог, находки по уровням и чек-лист', /Наружу: 1/.test(priv.verdict) && priv.items.length === 3 && /level-fail.*наружу.*OpenAI.*Выберите локальную/.test(priv.items[0]) && priv.list[0].startsWith('✗') && priv.list[1].startsWith('✓'), JSON.stringify(priv));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await ui(`document.querySelector('#input').value = ''`);

    console.log('\n[58] Локальные модели в один клик (N4, ADR 0100)');
    await ui(`document.querySelector('[data-panel=providers]').click()`);
    await wait(800);
    const loc = await ui(`({ items: [...document.querySelectorAll('.local-model')].map((i) => i.textContent), add: document.querySelectorAll('.local-add').length, hint: document.querySelector('.local-models-hint')?.textContent || '' })`);
    check('найдены Ollama (2 модели, «Добавить») и LM Studio без моделей', loc.items.length === 2 && /Ollama.*2 моделей.*qwen3:8b/.test(loc.items[0]) && /нет моделей/.test(loc.items[1]) && loc.add === 1 && /текстовый протокол/.test(loc.hint), JSON.stringify(loc));
    await ui(`document.querySelector('.local-add').click()`);
    await wait(600);
    check('«Добавить» — провайдер ollama', localAdds.length === 1 && localAdds[0].id === 'ollama', JSON.stringify(localAdds));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[59] /updates — обновления по риску и ветка с тестами (N6, ADR 0102)');
    await slashCmd('/updates');
    await wait(600);
    const up0 = await ui(`document.querySelector('.updates-head')?.textContent || ''`);
    check('отчёта нет — подсказка «Проверить сейчас»', /Проверить сейчас/.test(up0), up0);
    await ui(`document.querySelector('.updates-scan').click()`);
    await wait(500);
    const up1 = await ui(`({ items: [...document.querySelectorAll('.updates-item')].map((i) => i.textContent), picks: document.querySelectorAll('.updates-pick').length, disabled: document.querySelector('.updates-apply').disabled })`);
    check('уязвимость высокого риска первой; выбрать можно только обновление npm', up1.items.length === 2 && /высокий.*уязвимость: tar/.test(up1.items[0]) && /openai 6.49.0 → 6.50.0/.test(up1.items[1]) && up1.picks === 1 && up1.disabled, JSON.stringify(up1));
    await ui(`(() => { const c = document.querySelector('.updates-pick'); c.checked = true; c.dispatchEvent(new Event('change')); document.querySelector('.updates-apply').click(); })()`);
    await wait(600);
    const up2 = await ui(`document.querySelector('.updates-result')?.textContent || ''`);
    check('«Обновить на ветке» — openai@6.50.0, тесты прошли, проект не тронут', updateApplies[0]?.packages?.[0]?.name === 'openai' && updateApplies[0].packages[0].version === '6.50.0' && /✓ Стабильно: ветка mai\/update-deps/.test(up2) && /\/worktree/.test(up2), `${JSON.stringify(updateApplies)} ${up2}`);
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await ui(`document.querySelector('#input').value = ''`);

    console.log('\n[60] /cleanup — освободить место (N7, ADR 0103)');
    await slashCmd('/cleanup');
    await wait(600);
    const cl = await ui(`({ status: document.querySelector('.cleanup-status')?.textContent || '', picks: document.querySelectorAll('.cleanup-pick').length, readonly: document.querySelectorAll('.cleanup-item.readonly').length, total: document.querySelector('.cleanup-total')?.textContent || '' })`);
    check('стабильная версия, удаляемое отмечено, worktree — только показан', /стабильно/.test(cl.status) && cl.picks === 2 && cl.readonly === 1 && /освободится 3,0 МБ/.test(cl.total), JSON.stringify(cl));
    await ui(`(() => { const c = document.querySelectorAll('.cleanup-pick')[1]; c.checked = false; c.dispatchEvent(new Event('change')); document.querySelector('.cleanup-apply').click(); })()`);
    await wait(600);
    check('удаляется только отмеченное', cleanupCalls.length === 1 && cleanupCalls[0].length === 1 && /impeccable-4.8.1/.test(cleanupCalls[0][0]), JSON.stringify(cleanupCalls));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await ui(`document.querySelector('#input').value = ''`);

    console.log('\n[60a] Атрибут hidden скрывает элемент');
    const hiddenShown = await ui(`[...document.querySelectorAll('[hidden]')].filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.id || n.className).slice(0, 5)`);
    check('ни один элемент с hidden не виден (баннер прерванной работы и др.)', hiddenShown.length === 0, JSON.stringify(hiddenShown));

    console.log('\n[61] Строка ввода: чип хода (N9)');
    const chip0 = await ui(`({ text: document.querySelector('#turn-chip').textContent.replace(/\\s+/g, ' ').trim(), popHidden: document.querySelector('#turn-pop').hidden, inPop: Boolean(document.querySelector('#turn-pop #mode-select')) && Boolean(document.querySelector('#turn-pop #kind-toggle')), ctxInStatus: Boolean(document.querySelector('.statusbar #context-meter')) && Boolean(document.querySelector('.statusbar #results-btn')), visibleInBar: [...document.querySelectorAll('.composer-actions > *')].filter((e) => !e.hidden && e.offsetParent).map((e) => e.id || e.className).join(',') })`);
    check('в строке ввода: +, микрофон, чип, отправка; режим и вид — в окне чипа; контекст — в строке состояния', /^(Код|Задача) · /.test(chip0.text) && chip0.popHidden && chip0.inPop && chip0.ctxInStatus && !/mode-select|kind-toggle|context-meter/.test(chip0.visibleInBar), JSON.stringify(chip0));
    await ui(`document.querySelector('#turn-chip').click()`);
    await wait(200);
    const chip1 = await ui(`({ open: !document.querySelector('#turn-pop').hidden, expanded: document.querySelector('#turn-chip').getAttribute('aria-expanded') })`);
    check('клик по чипу — окно открыто', chip1.open && chip1.expanded === 'true', JSON.stringify(chip1));
    await ui(`document.querySelector('#kind-toggle [data-kind=task]').click()`);
    await wait(500);
    const chip2 = await ui(`document.querySelector('#turn-chip .turn-kind').textContent`);
    check('«Задача» в окне — чип показывает «Задача»', chip2 === 'Задача', chip2);
    await ui(`document.querySelector('#kind-toggle [data-kind=code]').click()`);
    await wait(400);
    await ui(`document.body.click()`);
    await wait(200);
    check('клик вне окна — закрыто и не видно', await ui(`document.querySelector('#turn-pop').hidden && getComputedStyle(document.querySelector('#turn-pop')).display === 'none' && document.querySelector('#turn-chip').getAttribute('aria-expanded') === 'false'`));

    console.log('\n[62] Шапка: «Кто выполняет» и меню (N9)');
    const head0 = await ui(`({ panels: [...document.querySelectorAll('.topbar [data-panel]')].filter((b) => b.offsetParent).map((b) => b.dataset.panel).join(','), runner: document.querySelector('#runner-chip .runner-name').textContent, selectsInPop: Boolean(document.querySelector('#runner-pop #model-select')) && Boolean(document.querySelector('#runner-pop #runtime-select')) })`);
    check('в шапке видны только «?» и «Доступ»; модель и рантайм — в окне «Кто выполняет»', head0.panels === 'docs,auth' && head0.runner === 'test-model' && head0.selectsInPop, JSON.stringify(head0));
    await ui(`document.querySelector('#turn-chip').click()`);
    await ui(`document.querySelector('#project-menu-btn').click()`);
    await wait(200);
    const head1 = await ui(`({ menu: getComputedStyle(document.querySelector('#project-menu')).display !== 'none', turn: getComputedStyle(document.querySelector('#turn-pop')).display, items: [...document.querySelectorAll('#project-menu [data-panel]')].map((b) => b.dataset.panel).join(',') })`);
    check('меню «Проект»: доски, данные, AGENTS.md, память, навыки, Multica; окно чипа закрылось', head1.menu && head1.turn === 'none' && head1.items === 'boards,storage,agents,memory,skills,multica', JSON.stringify(head1));
    await ui(`document.querySelector('#connections-menu-btn').click()`);
    await wait(200);
    const head2 = await ui(`({ project: getComputedStyle(document.querySelector('#project-menu')).display, items: [...document.querySelectorAll('#connections-menu [data-panel]')].map((b) => b.dataset.panel).join(',') })`);
    check('«Подключения»: коннекторы, MCP, пакеты, рантаймы, Docker; «Проект» закрылось', head2.project === 'none' && head2.items === 'connectors,mcp,plugins,runtimes,sandbox', JSON.stringify(head2));
    await ui(`document.querySelector('#connections-menu [data-panel=mcp]').click()`);
    await wait(500);
    const head3 = await ui(`({ closed: getComputedStyle(document.querySelector('#connections-menu')).display === 'none', modal: Boolean(document.querySelector('.modal-backdrop')) })`);
    check('пункт меню открывает окно и закрывает меню', head3.closed && head3.modal, JSON.stringify(head3));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[63] Настройки вкладками (N9)');
    await ui(`document.querySelector('#settings-btn').click()`);
    await wait(600);
    const st0 = await ui(`({ tabs: [...document.querySelectorAll('.settings-tab')].map((b) => b.dataset.tab).join(','), on: document.querySelector('.settings-tab.on')?.dataset.tab, visible: [...document.querySelectorAll('.settings-pane')].filter((p) => getComputedStyle(p).display !== 'none').length })`);
    check('вкладки: основное, уведомления, агент, безопасность, данные, голос, обслуживание, доступ; видна одна', st0.tabs === 'Основное,Уведомления,Агент и браузер,Безопасность,Данные и приватность,Голос и OCR,Обслуживание,Доступ' && st0.on === 'Основное' && st0.visible === 1, JSON.stringify(st0));
    await ui(`document.querySelector('.settings-tab[data-tab="Данные и приватность"]').click()`);
    await wait(200);
    const st1 = await ui(`({ privacy: Boolean(document.querySelector('.settings-pane:not([hidden]) .settings-privacy')), secret: Boolean(document.querySelector('.settings-pane:not([hidden]) .secret-filter-mode')) })`);
    check('«Данные и приватность»: отчёт /privacy и фильтр секретов', st1.privacy && st1.secret, JSON.stringify(st1));
    await ui(`document.querySelector('.settings-tab[data-tab="Обслуживание"]').click()`);
    await wait(300);
    const st2 = await ui(`document.querySelector('.settings-pane:not([hidden])').textContent`);
    check('«Обслуживание»: обновления и место с кнопками', /Обновления \(\/updates\)/.test(st2) && /Освободить место \(\/cleanup\)/.test(st2), st2.slice(0, 200));
    const saved0 = savedSettings.length;
    await ui(`[...document.querySelectorAll('.modal-foot button')].find((b) => /Сохранить/.test(b.textContent))?.click()`);
    await wait(500);
    check('«Сохранить» с другой вкладки сохраняет поля всех вкладок', savedSettings.length === saved0 + 1 && 'secretFilter' in savedSettings.at(-1) && 'shell' in savedSettings.at(-1) && 'voice' in savedSettings.at(-1), JSON.stringify(Object.keys(savedSettings.at(-1) || {})));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);

    console.log('\n[64] Боковая панель: проект одной кнопкой, «⤓» у чата (N9)');
    const sb0 = await ui(`({ visible: [...document.querySelectorAll('.sidebar button')].filter((b) => b.offsetParent && !b.closest('#sessions')).map((b) => b.id || b.className).join(','), exportRow: Boolean(document.querySelector('#sessions .session .session-export')) })`);
    check('в панели видны: новый чат, «этот проект», кнопка проекта; «Скачать чат» — у строки чата', sb0.visible === 'new-chat,sessions-scope,project-btn' && sb0.exportRow, JSON.stringify(sb0));
    await ui(`document.querySelector('#project-btn').click()`);
    await wait(200);
    const sb1 = await ui(`({ open: getComputedStyle(document.querySelector('#sidebar-project-menu')).display !== 'none', items: [...document.querySelectorAll('#sidebar-project-menu .menu-item')].map((b) => b.id).join(',') })`);
    check('меню проекта: сменить папку, проекты, новый проект, доверие', sb1.open && sb1.items === 'project-pick,projects-btn,new-project-btn,project-trust-item', JSON.stringify(sb1));
    await ui(`document.querySelector('#project-trust-item').click()`);
    await wait(600);
    const sb2 = await ui(`({ closed: getComputedStyle(document.querySelector('#sidebar-project-menu')).display === 'none', tab: document.querySelector('.settings-tab.on')?.dataset.tab })`);
    check('«Доверие к папкам…» — настройки на вкладке «Безопасность»', sb2.closed && sb2.tab === 'Безопасность', JSON.stringify(sb2));
    await ui(`document.querySelector('.modal-backdrop .x')?.click()`);
    await wait(200);
    await ui(`document.querySelector('#sessions .session .session-export').click()`);
    await wait(700);
    const sb3 = await ui(`[...document.querySelectorAll('.export-picker button')].map((b) => b.textContent.trim()).length`);
    check('«⤓» у строки чата — меню форматов', sb3 >= 2, sb3);
    await ui(`document.querySelector('.export-picker') && document.body.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    console.log('\n[65] Команды «/» по группам (N9)');
    const typeSlash = (v) => ui(`(() => { const i = document.querySelector('#input'); i.focus(); i.value = ${JSON.stringify('X')}; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); })()`.replace('"X"', JSON.stringify(v)));
    await typeSlash('/');
    await wait(500);
    const sl0 = await ui(`({ open: !document.querySelector('#suggest').hidden, groups: [...document.querySelectorAll('#suggest .suggest-group')].map((g) => g.textContent).join(','), items: [...document.querySelectorAll('#suggest .suggest-item code')].map((c) => c.textContent).join(',') })`);
    check('пустой «/»: все команды по группам, свои — отдельно в конце', sl0.open && sl0.groups === 'Чат,Модель и режим,Проект,Свои команды' && sl0.items === '/help,/clear,/mode,/init,/review,/handoff,/mcp__db__review', JSON.stringify(sl0));
    await typeSlash('/cl');
    await wait(400);
    const sl1 = await ui(`({ open: !document.querySelector('#suggest').hidden, groups: [...document.querySelectorAll('#suggest .suggest-group')].map((g) => g.textContent).join(','), items: [...document.querySelectorAll('#suggest .suggest-item code')].map((c) => c.textContent).join(',') })`);
    check('«/cl»: только /clear в группе «Чат»', sl1.open && sl1.items === '/clear' && sl1.groups === 'Чат', JSON.stringify(sl1));
    await ui(`(() => { const i = document.querySelector('#input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await wait(200);

    check('кнопка нового проекта — «в отдельной папке», не изоляция; панель — «Docker»', /отдельной папке/.test(names.btn) && /не изоляция/.test(names.btn) && !/песочниц/i.test(names.btn) && names.docker === 'Docker', JSON.stringify(names));
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.message || err}`);
    console.log(err?.stack || '');
  }

  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  win.destroy();
  // Electron держит файлы кеша: удаляем после выхода, ошибку не считаем провалом.
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* временная папка останется, это не влияет на результат */
  }
  app.exit(fail ? 1 : 0);
});
