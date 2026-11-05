import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, publicSettings, dataDir } from './lib/config.js';
import { listModels, resolveModel } from './lib/models.js';
import { startRuntime, describeRuntime } from './lib/runtimes.js';
import { createSession, deleteSession, getSession, listSessions, saveSession } from './lib/sessions.js';
import { runAgent } from './lib/agent.js';
import { createSkill, deleteSkill, listSkills, readAgents, writeAgents, agentsFile, globalAgentsFile, readMemory, writeMemory, installBundledSkills } from './lib/skills.js';
import { McpManager } from './lib/mcp.js';
import { loadPlugins, pluginDirs } from './lib/plugins.js';
import {
  listArtifacts,
  readArtifact,
  writeArtifact,
  artifactHistory,
  readVersion,
  restoreArtifact,
  deleteArtifact,
  diffArtifact,
  importExisting,
  searchArtifacts,
  exportArtifact,
  stats as artifactStats,
  artifactsRoot,
} from './lib/artifacts.js';
import {
  loadBoards,
  saveBoards,
  generateViews,
  saveBaseline,
  scanQuality,
  correctionPrompt,
  recordCorrection,
  updateCorrection,
} from './lib/boards.js';
import { gitStatus, gitDiff, gitHead } from './lib/git.js';
import { runStage } from './lib/deploy.js';
import * as infra from './lib/infra.js';
import * as repowise from './lib/repowise.js';
import { editDiagram } from './lib/diagram-agent.js';
import { createWorkspace, listWorkspaces, sandboxRoot } from './lib/workspace.js';
import { authStatus, configureAuth, setLocalRole, loginKeycloak, logout, requireAdmin } from './lib/auth.js';
import { listDocs, readDoc, searchDocs } from './lib/docs.js';
import * as multica from './lib/multica.js';
import * as sandbox from './lib/container.js';

// Node внутри Electron не доверяет корпоративным корневым сертификатам Windows,
// и запросы к api-ai.mai.ru падают с «unable to get local issuer certificate».
// Флаг --use-system-ca решает проблему, но его нужно передать до старта Node,
// поэтому при первом запуске приложение перезапускает себя с этим флагом.
if (!String(process.env.NODE_OPTIONS || '').includes('--use-system-ca') && !process.env.MAI_CODE_RELAUNCHED) {
  // В dev-режиме argv: [electron, путь-к-приложению, ...флаги], в упакованном:
  // [exe, ...флаги]. Нельзя резать одинаково, иначе упакованное приложение
  // теряет первый аргумент (например, --remote-debugging-port).
  const args = process.defaultApp
    ? [app.getAppPath(), ...process.argv.slice(2)]
    : process.argv.slice(1);
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --use-system-ca`.trim(),
      MAI_CODE_RELAUNCHED: '1',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  app.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcp = new McpManager();
const runs = new Map(); // windowId -> { controller, approvals: Map }

let mainWindow = null;

/**
 * MCP-серверы проекта лежат в <проект>/.mai-code/mcp.json и дополняют
 * глобальные настройки. Проектные записи имеют приоритет.
 */
function projectMcpConfig(projectDir) {
  if (!projectDir) return {};
  try {
    const file = path.join(projectDir, '.mai-code', 'mcp.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.mcpServers || data || {};
  } catch {
    return {};
  }
}

function mcpConfigs(projectDir) {
  const settings = loadSettings();
  return { ...(settings.mcpServers || {}), ...projectMcpConfig(projectDir || settings.projectDir) };
}

function send(window, event) {
  if (!window || window.isDestroyed()) return;
  // Главное окно слушает chat:event, окна досок — board:event.
  window.webContents.send('chat:event', event);
  window.webContents.send('board:event', event);
}

function runState(window) {
  const id = window.id;
  if (!runs.has(id)) runs.set(id, { controller: null, runtime: null, stage: null, correction: null, approvals: new Map() });
  return runs.get(id);
}

function projectOf(payload) {
  return payload?.projectDir || loadSettings().projectDir;
}

function logError(entry) {
  try {
    const file = path.join(dataDir(), 'errors.json');
    let all = [];
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      all = [];
    }
    all.push({ at: new Date().toISOString(), ...entry });
    fs.writeFileSync(file, JSON.stringify(all.slice(-500), null, 2), 'utf8');
  } catch {
    /* журнал ошибок не должен ломать приложение */
  }
}

const boardWindows = new Map(); // board -> BrowserWindow

function openBoardWindow(board, focus = '') {
  const existing = boardWindows.get(board);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    if (focus) existing.webContents.send('board:focus', { focus });
    return existing.id;
  }

  const titles = {
    delivery: 'Доставка',
    architecture: 'Архитектура',
    runners: 'Рантаймы и деплой',
    quality: 'Качество и самокоррекция',
    storage: 'Хранилище и инфраструктура',
  };

  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0f1117',
    title: `MAI Code — ${titles[board] || board}`,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'board.html'), { query: { board, focus } });
  boardWindows.set(board, win);
  win.on('closed', () => {
    runs.delete(win.id);
    if (boardWindows.get(board) === win) boardWindows.delete(board);
  });
  return win.id;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1117',
    title: 'MAI Code',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    runs.delete(mainWindow?.id);
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    installBundledSkills(path.join(app.getAppPath(), 'skills'));
  } catch (err) {
    console.error('[skills] не удалось установить вложенные навыки:', err?.message || err);
  }
  createWindow();
  const settings = loadSettings();
  mcp.sync(mcpConfigs(settings.projectDir)).catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Останавливаем всё, что породило приложение: стадии, самокоррекцию,
// внешние рантаймы и MCP-сервер repowise.
app.on('before-quit', () => {
  for (const state of runs.values()) {
    try {
      state.stage?.kill();
    } catch {
      /* уже завершено */
    }
    try {
      state.correction?.abort();
    } catch {
      /* уже завершено */
    }
    try {
      state.runtime?.kill();
    } catch {
      /* уже завершено */
    }
  }
  try {
    repowise.stopAll();
  } catch {
    /* ignore */
  }
});

// ---------- настройки ----------

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:save', async (_e, patch) => {
  if (patch.projectDir || patch.providers || patch.infra || patch.repowise || patch.runtimes || patch.auth) {
    requireAdmin();
  }
  const clean = { ...patch };
  delete clean.apiKey;
  delete clean.baseURL;
  delete clean.model;
  const next = saveSettings(clean);
  if (patch.mcpServers) await mcp.sync(mcpConfigs(next.projectDir));
  return publicSettings();
});

// ---------- роли и доступ ----------

ipcMain.handle('auth:status', () => authStatus());

ipcMain.handle('auth:configure', (_e, payload) => {
  requireAdmin();
  return configureAuth(payload || {});
});

ipcMain.handle('auth:login', async () => {
  try {
    return { ok: true, ...(await loginKeycloak()) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('auth:logout', () => logout());

// Локальная роль — это переключатель интерфейса, а не граница безопасности.
// Разрешаем менять её без admin, иначе guest не сможет вернуться назад.
// В режиме Keycloak роль приходит из токена и здесь не меняется.
ipcMain.handle('auth:setRole', (_e, role) => setLocalRole(role));

ipcMain.handle('models:list', async (_e, force) => {
  try {
    const { models, errors } = await listModels({ force });
    return { ok: true, models, errors };
  } catch (err) {
    console.error('[models]', err?.message, err?.cause?.message || '');
    return { ok: false, error: err.message };
  }
});

// ---------- провайдеры ----------

ipcMain.handle('providers:list', () => publicSettings().providers);

ipcMain.handle('providers:save', async (_e, { id, provider }) => {
  requireAdmin();
  const key = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!key) return { ok: false, error: 'Нужен идентификатор провайдера' };
  if (!provider?.baseURL) return { ok: false, error: 'Нужен Base URL' };

  const settings = loadSettings();
  const providers = { ...settings.providers };
  const previous = providers[key] || {};
  const nextKey = provider.apiKey && provider.apiKey !== '***' ? provider.apiKey : previous.apiKey || '';

  providers[key] = {
    name: provider.name || key,
    baseURL: String(provider.baseURL).replace(/\/$/, ''),
    apiKey: nextKey,
    models: (provider.models || []).filter((m) => m?.id),
  };

  saveSettings({ providers });
  return { ok: true, providers: publicSettings().providers };
});

ipcMain.handle('providers:remove', async (_e, id) => {
  requireAdmin();
  const settings = loadSettings();
  if (Object.keys(settings.providers).length <= 1) {
    return { ok: false, error: 'Нельзя удалить последнего провайдера' };
  }
  const providers = { ...settings.providers };
  delete providers[id];
  const patch = { providers };
  if (String(settings.activeModel).startsWith(`${id}/`)) {
    const first = Object.keys(providers)[0];
    patch.activeModel = `${first}/${providers[first].models?.[0]?.id || 'default'}`;
  }
  saveSettings(patch);
  return { ok: true, providers: publicSettings().providers };
});

ipcMain.handle('providers:test', async (_e, id) => {
  const settings = loadSettings();
  const provider = settings.providers[id];
  if (!provider) return { ok: false, error: 'Провайдер не найден' };
  try {
    const res = await fetch(`${provider.baseURL}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const body = JSON.parse(text);
    return { ok: true, status: res.status, count: (body.data || []).length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------- рантаймы ----------

ipcMain.handle('runtimes:list', () => loadSettings().runtimes || {});

ipcMain.handle('runtimes:save', (_e, runtimes) => {
  requireAdmin();
  saveSettings({ runtimes });
  return loadSettings().runtimes;
});

ipcMain.handle('runtimes:run', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.runtime) return { ok: false, error: 'Рантайм уже выполняется' };

  const settings = loadSettings();
  const runtime = settings.runtimes?.[payload.runtime];
  if (!runtime) return { ok: false, error: 'Рантайм не найден' };
  if (!runtime.command) return { ok: false, error: 'У рантайма не задана команда' };

  const projectDir = payload.projectDir || settings.projectDir;
  const model = payload.model || settings.activeModel || '';
  const prompt = String(payload.text || '').trim();
  if (!prompt) return { ok: false, error: 'Пустой запрос' };

  let session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) session = createSession({ title: '', model, projectDir });
  session.projectDir = projectDir;
  session.model = model;
  session.messages.push({ role: 'user', content: prompt });
  if (!session.title || session.title === 'Новый чат') {
    session.title = prompt.slice(0, 60);
  }
  saveSession(session);

  const handle = startRuntime({
    runtime,
    prompt,
    model,
    projectDir,
    onData: (text) => send(window, { type: 'runtime:chunk', text }),
    onExit: ({ code, error, output }) => {
      state.runtime = null;
      session.messages.push({
        role: 'runtime',
        name: runtime.name || payload.runtime,
        content: output || '',
        code,
      });
      saveSession(session);
      if (error || (code !== 0 && code !== null)) {
        logError({
          source: 'runtime',
          runtime: payload.runtime,
          message: error || `Рантайм завершился с кодом ${code}`,
        });
      }
      send(window, {
        type: 'runtime:exit',
        code,
        error,
        sessionId: session.id,
        name: runtime.name || payload.runtime,
        output: output || '',
      });
    },
  });

  state.runtime = handle;
  send(window, {
    type: 'runtime:start',
    name: runtime.name || payload.runtime,
    command: describeRuntime(runtime, { prompt, model, projectDir, target: runtime.target || '' }),
  });

  return { ok: true, sessionId: session.id, title: session.title };
});

ipcMain.handle('runtimes:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  runState(window).runtime?.kill();
  return true;
});

// ---------- проект ----------

ipcMain.handle('project:pick', async () => {
  requireAdmin();
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  saveSettings({ projectDir: result.filePaths[0] });
  return result.filePaths[0];
});

// ---------- песочницы проектов ----------

ipcMain.handle('workspace:root', () => sandboxRoot());
ipcMain.handle('workspace:list', () => listWorkspaces());
ipcMain.handle('workspace:create', async (_e, payload) => {
  requireAdmin();
  try {
    const result = createWorkspace(payload || {});
    saveSettings({ projectDir: result.projectDir });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

// ---------- сессии ----------

ipcMain.handle('sessions:list', () => listSessions());
ipcMain.handle('sessions:get', (_e, id) => getSession(id));
ipcMain.handle('sessions:create', (_e, data) => createSession(data || {}));
ipcMain.handle('sessions:delete', (_e, id) => deleteSession(id));

// ---------- чат ----------

ipcMain.handle('chat:start', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.controller) return { ok: false, error: 'Уже выполняется другой запрос' };

  const settings = loadSettings();
  const activeKey = payload.model || settings.activeModel;
  let resolved;
  try {
    resolved = resolveModel(settings, activeKey);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!resolved.provider.apiKey) {
    return { ok: false, error: `Не задан API-ключ провайдера «${resolved.provider.name}». Откройте панель «Провайдеры».` };
  }

  const projectDir = payload.projectDir || settings.projectDir;
  const model = activeKey;

  // Ревизор опционален: если модель не разрешилась, работаем без него.
  let reviewer = null;
  if (settings.reviewer?.enabled) {
    try {
      const reviewerKey = settings.reviewer.model || activeKey;
      const resolvedReviewer = resolveModel(settings, reviewerKey);
      if (resolvedReviewer.provider.apiKey) {
        reviewer = {
          provider: resolvedReviewer.provider,
          model: resolvedReviewer.modelId,
          maxRounds: Math.max(0, Math.min(5, Number(settings.reviewer.maxRounds ?? 2))),
        };
      }
    } catch {
      reviewer = null;
    }
  }
  let session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) {
    session = createSession({ title: '', model, projectDir });
  }
  session.model = model;
  session.projectDir = projectDir;
  if (payload.text) {
    session.messages.push({ role: 'user', content: payload.text });
    if (!session.title || session.title === 'Новый чат') {
      session.title = payload.text.trim().slice(0, 60) || 'Новый чат';
    }
  }
  saveSession(session);

  const controller = new AbortController();
  state.controller = controller;

  const { tools: pluginTools, transforms, loaded } = await loadPlugins(projectDir);

  (async () => {
    try {
      const history = await runAgent({
        settings,
        provider: resolved.provider,
        projectDir,
        model: resolved.modelId,
        messages: session.messages,
        signal: controller.signal,
        mcp,
        pluginTools,
        transforms,
        reviewer,
        emit: (e) => send(window, e),
        approve: (name, summary) =>
          new Promise((resolve) => {
            const id = crypto.randomUUID();
            state.approvals.set(id, resolve);
            send(window, { type: 'approval', id, name, summary });
          }),
      });
      session.messages = history;
      saveSession(session);
      // runAgent выходит из цикла по abort без исключения — не выдаём это за успех.
      if (controller.signal.aborted) throw new Error('Остановлено пользователем');
      send(window, { type: 'saved', sessionId: session.id, title: session.title, plugins: loaded });
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted ? 'Остановлено пользователем' : err?.message || String(err);
      if (!aborted) logError({ source: 'agent', model, message, cause: err?.cause?.message || '' });
      send(window, {
        type: 'error',
        message,
        aborted,
      });
      session.messages = session.messages;
      saveSession(session);
    } finally {
      state.controller = null;
      state.approvals.clear();
    }
  })();

  return { ok: true, sessionId: session.id, title: session.title };
});

/** Закрывает висящие подтверждения отказом, иначе инструмент ждёт клика вечно. */
function denyApprovals(state) {
  for (const resolve of state.approvals.values()) resolve(false);
  state.approvals.clear();
}

ipcMain.handle('chat:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  denyApprovals(state);
  state.controller?.abort();
  return true;
});

ipcMain.handle('chat:approval', (event, { id, allow }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  const resolve = state.approvals.get(id);
  if (resolve) {
    state.approvals.delete(id);
    resolve(Boolean(allow));
  }
  return true;
});

// ---------- AGENTS.md ----------

ipcMain.handle('agents:read', (_e, projectDir) => {
  const data = readAgents(projectDir);
  return { ...data, projectFile: agentsFile(projectDir), globalFile: globalAgentsFile() };
});

ipcMain.handle('agents:write', (_e, { file, content }) => {
  requireAdmin();
  return writeAgents(file, content);
});

// ---------- память ----------

ipcMain.handle('memory:read', (_e, projectDir) => readMemory(projectDir));
ipcMain.handle('memory:write', (_e, { file, content }) => {
  requireAdmin();
  return writeMemory(file, content);
});

// ---------- навыки ----------

ipcMain.handle('skills:list', (_e, projectDir) =>
  listSkills(projectDir).map(({ name, description, scope, file }) => ({ name, description, scope, file })),
);
ipcMain.handle('skills:create', (_e, { projectDir, ...data }) => {
  requireAdmin();
  return createSkill(projectDir, data);
});
ipcMain.handle('skills:delete', (_e, file) => {
  requireAdmin();
  return deleteSkill(file);
});

// ---------- Multica ----------

ipcMain.handle('multica:status', () => multica.status());
ipcMain.handle('multica:auth', () => multica.authStatus());
ipcMain.handle('multica:issues', (_e, limit) => multica.listIssues(limit || 30));
ipcMain.handle('multica:syncDocs', (_e, projectDir) => {
  requireAdmin();
  return multica.syncOpenSpec(projectDir || loadSettings().projectDir);
});

// ---------- Docker-песочницы ----------

ipcMain.handle('sandbox:status', () => sandbox.dockerStatus());
ipcMain.handle('sandbox:list', () => sandbox.listContainers());
ipcMain.handle('sandbox:start', (_e, payload) => {
  requireAdmin();
  return sandbox.startContainer(payload || {});
});
ipcMain.handle('sandbox:stop', (_e, payload) => {
  requireAdmin();
  return sandbox.stopContainer(payload?.name, { remove: payload?.remove !== false });
});
ipcMain.handle('sandbox:logs', (_e, payload) => sandbox.containerLogs(payload?.name, payload?.lines || 200));
ipcMain.handle('sandbox:exec', (_e, payload) => {
  requireAdmin();
  return sandbox.execInContainer(payload?.name, payload?.command);
});

// ---------- встроенная документация ----------

ipcMain.handle('docs:list', () => listDocs());
ipcMain.handle('docs:read', (_e, relative) => readDoc(relative));
ipcMain.handle('docs:search', (_e, query) => searchDocs(query));

// ---------- MCP ----------

ipcMain.handle('mcp:status', () => mcp.status());
ipcMain.handle('mcp:configs', (_e, projectDir) => mcpConfigs(projectDir));
ipcMain.handle('mcp:sync', async (_e, projectDir) => {
  const settings = loadSettings();
  return mcp.sync(mcpConfigs(projectDir || settings.projectDir));
});
ipcMain.handle('mcp:connect', async (_e, name, projectDir) => {
  const config = mcpConfigs(projectDir)[name];
  if (!config) return { ok: false, error: 'Сервер не найден в настройках' };
  return mcp.connect(name, config);
});
ipcMain.handle('mcp:remove', async (_e, name) => {
  const settings = loadSettings();
  const servers = { ...(settings.mcpServers || {}) };
  delete servers[name];
  saveSettings({ mcpServers: servers });
  await mcp.disconnect(name);
  return true;
});

// ---------- плагины ----------

ipcMain.handle('plugins:list', async (_e, projectDir) => {
  const { loaded } = await loadPlugins(projectDir);
  return { plugins: loaded, dirs: pluginDirs(projectDir) };
});
ipcMain.handle('plugins:openFolder', async (_e, projectDir) => {
  const dir = pluginDirs(projectDir)[0];
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle('plugins:createExample', async (_e, projectDir) => {
  const dir = pluginDirs(projectDir)[0];
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'example-plugin.js');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `// Пример плагина MAI Code. Файл лежит в <проект>/.mai-code/plugins/.
// Плагин может добавить инструмент агенту и/или переписать историю сообщений.

export default {
  name: 'example-plugin',

  tools: [
    {
      schema: {
        type: 'function',
        function: {
          name: 'project_time',
          description: 'Показать текущие дату и время на машине пользователя',
          parameters: { type: 'object', properties: {} },
        },
      },
      async run() {
        return new Date().toLocaleString('ru-RU');
      },
    },
  ],

  // Необязательный хук: можно дописать контекст в историю перед запросом.
  // transformMessages(messages) { return messages; },
};
`,
      'utf8',
    );
  }
  await shell.openPath(dir);
  return file;
});

// ---------- артефакты ----------

ipcMain.handle('artifacts:list', (_e, payload) =>
  listArtifacts(projectOf(payload), { kind: payload?.kind || '', query: payload?.query || '' }),
);

ipcMain.handle('artifacts:get', (_e, payload) => readArtifact(projectOf(payload), payload.id));

ipcMain.handle('artifacts:save', (_e, payload) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const artifact = writeArtifact(projectDir, payload.artifact || {});
  return { ok: true, artifact, stats: artifactStats(projectDir) };
});

ipcMain.handle('artifacts:history', (_e, payload) => artifactHistory(projectOf(payload), payload.id));

ipcMain.handle('artifacts:version', (_e, payload) =>
  readVersion(projectOf(payload), payload.id, payload.version),
);

ipcMain.handle('artifacts:restore', (_e, payload) => {
  requireAdmin();
  return restoreArtifact(projectOf(payload), payload.id, payload.version);
});

ipcMain.handle('artifacts:delete', (_e, payload) => {
  requireAdmin();
  return deleteArtifact(projectOf(payload), payload.id);
});

ipcMain.handle('artifacts:diff', (_e, payload) =>
  diffArtifact(projectOf(payload), payload.id, payload.from, payload.to),
);

ipcMain.handle('artifacts:search', (_e, payload) =>
  searchArtifacts(projectOf(payload), payload.query || ''),
);

ipcMain.handle('artifacts:import', (_e, payload) => {
  requireAdmin();
  return importExisting(projectOf(payload));
});

ipcMain.handle('artifacts:stats', (_e, payload) => artifactStats(projectOf(payload)));

ipcMain.handle('artifacts:openFolder', async (_e, payload) => {
  const dir = artifactsRoot(projectOf(payload));
  fs.mkdirSync(dir, { recursive: true });
  await shell.openPath(dir);
  return dir;
});

ipcMain.handle('artifacts:export', async (event, payload) => {
  const projectDir = projectOf(payload);
  const artifact = readArtifact(projectDir, payload.id);
  const ext = artifact.kind === 'openapi' ? 'json' : artifact.kind === 'plugin' ? 'js' : artifact.kind === 'diagram' ? 'puml' : 'md';
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    defaultPath: path.join(projectDir, `${artifact.slug}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  exportArtifact(projectDir, payload.id, result.filePath);
  return { ok: true, file: result.filePath };
});

ipcMain.handle('artifacts:applyToFile', (_e, payload) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const artifact = readArtifact(projectDir, payload.id);
  const target = artifact.meta?.file;
  if (!target) return { ok: false, error: 'У артефакта нет привязанного файла' };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, artifact.content, 'utf8');
  return { ok: true, file: target };
});

// ---------- доски ----------

ipcMain.handle('boards:open', (_e, payload) => openBoardWindow(payload?.board || 'delivery', payload?.focus || ''));

ipcMain.handle('boards:load', (_e, payload) => {
  const projectDir = projectOf(payload);
  return { boards: loadBoards(projectDir), projectDir, settings: publicSettings() };
});

ipcMain.handle('boards:save', (_e, payload) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const allowed = ['delivery', 'architecture', 'runners', 'quality'];
  if (!allowed.includes(payload.section)) throw new Error('Неизвестная секция доски');
  const data = loadBoards(projectDir);
  data[payload.section] = payload.data;
  return saveBoards(projectDir, data);
});

ipcMain.handle('boards:views', async (_e, payload) => {
  const projectDir = projectOf(payload);
  return generateViews(projectDir, await gitHead(projectDir));
});

ipcMain.handle('boards:baseline', async (_e, payload) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  return saveBaseline(projectDir, await gitHead(projectDir));
});

ipcMain.handle('boards:scan', async (_e, payload) =>
  scanQuality(projectOf(payload), { loadPlugins }),
);

ipcMain.handle('boards:git', (_e, payload) => gitStatus(projectOf(payload)));
ipcMain.handle('boards:diff', (_e, payload) => gitDiff(projectOf(payload), payload?.file || ''));

ipcMain.handle('boards:stageRun', (event, payload) => {
  requireAdmin();
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.stage) return { ok: false, error: 'Стадия уже выполняется' };

  const projectDir = projectOf(payload);
  const data = loadBoards(projectDir);
  const stage = (data.runners.stages || []).find((s) => s.id === payload.stageId);
  if (!stage) return { ok: false, error: 'Стадия не найдена' };

  const command = payload.command || stage.command;
  if (!command) return { ok: false, error: 'Не задана команда стадии' };

  stage.status = 'running';
  stage.lastRunAt = new Date().toISOString();
  saveBoards(projectDir, data);

  const handle = runStage({
    projectDir,
    command,
    onData: (text) => send(window, { type: 'stage:chunk', stageId: stage.id, text }),
    onExit: ({ code, error, log }) => {
      state.stage = null;
      const next = loadBoards(projectDir);
      const item = (next.runners.stages || []).find((s) => s.id === stage.id);
      if (item) {
        item.status = code === 0 ? 'ok' : 'error';
        item.lastExit = code;
        item.log = String(log || '').slice(-60_000);
        item.lastRunAt = new Date().toISOString();
      }
      saveBoards(projectDir, next);
      if (code !== 0) {
        logError({ source: 'deploy', stage: stage.id, command, message: error || `код ${code}` });
      }
      send(window, {
        type: 'stage:exit',
        stageId: stage.id,
        code,
        error,
        log: item?.log || '',
      });
    },
  });

  state.stage = handle;
  return { ok: true, stageId: stage.id, command };
});

ipcMain.handle('boards:stageStop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  runState(window).stage?.kill();
  return true;
});

ipcMain.handle('boards:runtimeStatus', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  return {
    runtimes: loadSettings().runtimes || {},
    running: Boolean(state.runtime),
    stageRunning: Boolean(state.stage),
  };
});

ipcMain.handle('boards:errors', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'errors.json'), 'utf8'));
  } catch {
    return [];
  }
});

ipcMain.handle('boards:clearErrors', () => {
  fs.writeFileSync(path.join(dataDir(), 'errors.json'), '[]', 'utf8');
  return true;
});

ipcMain.handle('boards:correction', async (event, payload) => {
  requireAdmin();
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.correction) return { ok: false, error: 'Самокоррекция уже выполняется' };

  const projectDir = projectOf(payload);
  const settings = loadSettings();
  const resolved = resolveModel(settings, payload.model || settings.activeModel);
  if (!resolved.provider.apiKey) return { ok: false, error: 'Нет ключа выбранного провайдера' };

  const boards = loadBoards(projectDir);
  const selected = (boards.quality.issues || []).filter(
    (issue) => issue.status !== 'ignored' && (!payload.issueIds?.length || payload.issueIds.includes(issue.id)),
  );
  if (!selected.length) return { ok: false, error: 'Нет проблем для исправления' };

  const session = createSession({
    title: `Самокоррекция · ${new Date().toLocaleString('ru-RU')}`,
    model: payload.model || settings.activeModel,
    projectDir,
  });
  const prompt = correctionPrompt(projectDir, selected);
  session.messages.push({ role: 'user', content: prompt });
  saveSession(session);

  const correction = recordCorrection(projectDir, {
    issueIds: selected.map((i) => i.id),
    sessionId: session.id,
    status: 'running',
    summary: '',
  });

  const controller = new AbortController();
  state.correction = controller;
  const { tools: pluginTools, transforms } = await loadPlugins(projectDir);

  (async () => {
    try {
      const history = await runAgent({
        settings,
        provider: resolved.provider,
        projectDir,
        model: resolved.modelId,
        messages: session.messages,
        signal: controller.signal,
        mcp,
        pluginTools,
        transforms,
        emit: (e) => send(window, e),
        approve: (name, summary) =>
          new Promise((resolve) => {
            const id = crypto.randomUUID();
            state.approvals.set(id, resolve);
            send(window, { type: 'approval', id, name, summary });
          }),
      });
      session.messages = history;
      saveSession(session);
      if (controller.signal.aborted) throw new Error('Остановлено пользователем');
      const scan = await scanQuality(projectDir, { loadPlugins });
      updateCorrection(projectDir, correction.id, {
        status: 'done',
        finishedAt: new Date().toISOString(),
        summary: `Осталось проблем: ${scan.summary.open}`,
      });
      send(window, {
        type: 'correction:done',
        correctionId: correction.id,
        sessionId: session.id,
        issues: scan.issues,
        summary: scan.summary,
      });
    } catch (err) {
      const aborted = controller.signal.aborted;
      updateCorrection(projectDir, correction.id, {
        status: aborted ? 'stopped' : 'error',
        finishedAt: new Date().toISOString(),
        summary: aborted ? 'остановлено пользователем' : err?.message || String(err),
      });
      send(window, {
        type: 'correction:error',
        correctionId: correction.id,
        message: aborted ? 'Остановлено пользователем' : err?.message || String(err),
      });
      if (!aborted) logError({ source: 'correction', message: err?.message || String(err) });
    } finally {
      state.correction = null;
      state.approvals.clear();
    }
  })();

  return { ok: true, sessionId: session.id, correctionId: correction.id, issues: selected.length };
});

ipcMain.handle('boards:correctionStop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  denyApprovals(state);
  state.correction?.abort();
  return true;
});

ipcMain.handle('boards:exportView', async (event, payload) => {
  const projectDir = projectOf(payload);
  const { views } = generateViews(projectDir, await gitHead(projectDir));
  const view = views[payload.view];
  if (!view) return { ok: false, error: 'Представление не найдено' };
  const dir = path.join(artifactsRoot(projectDir), 'exports');
  fs.mkdirSync(dir, { recursive: true });
  if (payload.view === 'openapi') {
    const file = path.join(dir, 'openapi.json');
    fs.writeFileSync(file, JSON.stringify(view.spec, null, 2), 'utf8');
    return { ok: true, file };
  }
  const file = path.join(dir, `${payload.view}.puml`);
  fs.writeFileSync(file, view.puml, 'utf8');
  return { ok: true, file, puml: view.puml };
});

/**
 * Скачивание схемы в выбранном формате. Для SVG/PNG рендерер присылает уже
 * готовые данные, для PUML/JSON main генерирует их из модели.
 */
ipcMain.handle('boards:exportDiagram', async (event, payload) => {
  const projectDir = projectOf(payload);
  const format = String(payload.format || '').toLowerCase();
  const allowed = new Set(['svg', 'png', 'puml', 'json']);
  if (!allowed.has(format)) return { ok: false, error: `Неизвестный формат: ${format}` };

  const { views } = generateViews(projectDir, await gitHead(projectDir));
  const view = views[payload.view];
  if (!view) return { ok: false, error: 'Представление не найдено' };

  const safeView = String(payload.view || 'diagram').replace(/[^a-z0-9_-]/gi, '-');
  const stamp = new Date().toISOString().slice(0, 10);
  const ext = format === 'json' ? 'json' : format;
  const filename = `${safeView}-${stamp}.${ext}`;
  const filters = {
    svg: [{ name: 'SVG', extensions: ['svg'] }],
    png: [{ name: 'PNG', extensions: ['png'] }],
    puml: [{ name: 'PlantUML', extensions: ['puml', 'plantuml'] }],
    json: [{ name: 'JSON', extensions: ['json'] }],
  }[format];

  let data = payload.data;
  if (format === 'puml') data = view.puml || '';
  if (format === 'json') {
    if (payload.view === 'openapi') {
      data = JSON.stringify(view.spec || {}, null, 2);
    } else {
      // Для обычных представлений JSON — это снимок модели и исходников схемы,
      // чтобы файл можно было передать в другой инструмент или сравнить.
      const boards = loadBoards(projectDir);
      data = JSON.stringify(
        {
          view: payload.view,
          title: view.title,
          mermaid: view.mermaid,
          puml: view.puml,
          model: boards.architecture?.model || {},
        },
        null,
        2,
      );
    }
  }
  if (format === 'svg') data = String(data || '');
  if (format === 'png') {
    const raw = String(data || '');
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    data = Buffer.from(base64, 'base64');
  }
  if (!data) return { ok: false, error: 'Нет данных для сохранения' };

  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Скачать схему',
    defaultPath: path.join(app.getPath('downloads'), filename),
    filters,
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  if (format === 'png') fs.writeFileSync(filePath, data);
  else fs.writeFileSync(filePath, data, 'utf8');
  return { ok: true, file: filePath, format };
});

/**
 * Растеризация SVG в PNG через скрытое offscreen-окно.
 *
 * Canvas в рендерере «тускнеет» на SVG с foreignObject (Mermaid рисует так
 * подписи), а nativeImage не декодирует SVG. Offscreen-окно рендерит ту же
 * разметку Chromium и отдаёт снимок без ограничения tainted canvas.
 */
ipcMain.handle('boards:rasterize', async (_e, payload) => {
  const svg = String(payload?.svg || '');
  if (!svg.trim()) return { ok: false, error: 'Пустой SVG' };
  const factor = Math.min(Math.max(Number(payload?.scale) || 2, 1), 3);
  const baseWidth = Math.max(1, Math.ceil(Number(payload?.width) || 1200));
  const baseHeight = Math.max(1, Math.ceil(Number(payload?.height) || 800));
  const width = Math.min(baseWidth * factor, 6000);
  const height = Math.min(baseHeight * factor, 6000);

  let win;
  try {
    win = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
    });
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <style>
        html, body { margin: 0; padding: 0; background: #10131b; overflow: hidden; }
        svg { display: block; width: ${width}px; height: ${height}px; }
      </style></head><body>${svg}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) return { ok: false, error: 'Снимок получился пустым' };
    return { ok: true, dataUrl: image.toDataURL(), width, height };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    win?.destroy();
  }
});

ipcMain.handle('boards:diagramChat', async (_e, payload) => {
  requireAdmin();
  const settings = loadSettings();
  let resolved;
  try {
    resolved = resolveModel(settings, payload.model || settings.activeModel);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!resolved.provider.apiKey) {
    return { ok: false, error: `Не задан API-ключ провайдера «${resolved.provider.name}».` };
  }
  try {
    return await editDiagram({
      provider: resolved.provider,
      model: resolved.modelId,
      settings,
      projectDir: projectOf(payload),
      view: payload.view,
      message: String(payload.message || ''),
      history: Array.isArray(payload.history) ? payload.history : [],
    });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('boards:saveView', (_e, payload) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const { views } = generateViews(projectDir, '');
  const view = views[payload.view];
  if (!view) return { ok: false, error: 'Представление не найдено' };
  const artifact = writeArtifact(projectDir, {
    id: `diagram:${payload.view}`,
    kind: payload.view === 'openapi' ? 'openapi' : 'diagram',
    name: `Архитектура · ${payload.view}`,
    title: view.title,
    content: payload.view === 'openapi' ? JSON.stringify(view.spec, null, 2) : `${view.mermaid}\n\n--- PlantUML ---\n${view.puml}\n`,
    meta: { view: payload.view, generatedAt: new Date().toISOString() },
    note: 'сгенерировано доской архитектуры',
  });
  return { ok: true, artifact };
});

// ---------- инфраструктура ----------

const infraResult = async (fn) => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};

ipcMain.handle('infra:status', () => infra.probe());
ipcMain.handle('infra:sync', (_e, payload) =>
  infraResult(() => infra.syncAll(projectOf(payload), { embed: payload?.embed !== false })),
);
ipcMain.handle('infra:pushSecrets', () => infraResult(() => infra.pushSecrets()));
ipcMain.handle('infra:pullSecrets', () => infraResult(() => infra.pullSecrets()));
ipcMain.handle('infra:search', (_e, payload) =>
  infraResult(() => infra.remoteSearch(projectOf(payload), payload.query)),
);
ipcMain.handle('infra:upload', (_e, payload) => infraResult(() => infra.uploadArtifacts(projectOf(payload))));
ipcMain.handle('infra:download', (_e, payload) =>
  infraResult(() => infra.downloadArtifact(projectOf(payload), payload.id)),
);

// ---------- repowise ----------

const repowiseResult = async (fn) => {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};

ipcMain.handle('repowise:status', (_e, payload) => repowise.status(projectOf(payload)));
ipcMain.handle('repowise:install', () => repowiseResult(() => repowise.install()));
ipcMain.handle('repowise:init', (_e, payload) =>
  repowiseResult(() => repowise.init(projectOf(payload), { editorSetup: Boolean(payload?.editorSetup) })),
);
ipcMain.handle('repowise:update', (_e, payload) => repowiseResult(() => repowise.update(projectOf(payload))));
ipcMain.handle('repowise:doctor', (_e, payload) => repowiseResult(() => repowise.doctor(projectOf(payload))));
ipcMain.handle('repowise:ask', (_e, payload) =>
  repowiseResult(() => repowise.ask(projectOf(payload), payload.question)),
);
ipcMain.handle('repowise:search', (_e, payload) =>
  repowiseResult(() => repowise.search(projectOf(payload), payload.query)),
);
ipcMain.handle('repowise:context', (_e, payload) =>
  repowiseResult(() => repowise.context(projectOf(payload), payload.files)),
);
ipcMain.handle('repowise:risk', (_e, payload) =>
  repowiseResult(() => repowise.risk(projectOf(payload), payload.range)),
);
ipcMain.handle('repowise:distill', (_e, payload) =>
  repowiseResult(() => repowise.distill(projectOf(payload), payload.command)),
);

ipcMain.handle('repowise:connectMcp', async (_e, payload) => {
  const projectDir = projectOf(payload);
  const settings = loadSettings();
  const servers = { ...(settings.mcpServers || {}) };
  servers.repowise = repowise.mcpConfig(projectDir);
  saveSettings({ mcpServers: servers });
  const result = await mcp.sync(servers);
  return { ok: Boolean(result.repowise?.ok), status: mcp.status(), result };
});

ipcMain.handle('repowise:serve', async (_e, payload) => {
  const projectDir = projectOf(payload);
  const res = await repowise.serve(projectDir);
  if (res.url) await shell.openExternal(res.url);
  return res;
});

ipcMain.handle('repowise:stopServe', (_e, payload) => repowise.stopServe(projectOf(payload)));

// ---------- прочее ----------

ipcMain.handle('app:openPath', async (_e, target) => {
  if (!target) return false;
  await shell.openPath(target);
  return true;
});
ipcMain.handle('app:showItem', (_e, target) => {
  if (target) shell.showItemInFolder(target);
  return true;
});
ipcMain.handle('app:openExternal', async (_e, url) => {
  if (!/^https?:\/\//i.test(url || '')) return false;
  await shell.openExternal(url);
  return true;
});
ipcMain.handle('app:dataDir', () => dataDir());

ipcMain.handle('app:focusMain', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return true;
  }
  createWindow();
  return true;
});
