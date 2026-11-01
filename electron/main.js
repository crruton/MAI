import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, publicSettings, dataDir } from './lib/config.js';
import { listModels } from './lib/models.js';
import { createSession, deleteSession, getSession, listSessions, saveSession } from './lib/sessions.js';
import { runAgent } from './lib/agent.js';
import { createSkill, deleteSkill, listSkills, readAgents, writeAgents, agentsFile, globalAgentsFile } from './lib/skills.js';
import { McpManager } from './lib/mcp.js';
import { loadPlugins, pluginDirs } from './lib/plugins.js';

// Node внутри Electron не доверяет корпоративным корневым сертификатам Windows,
// и запросы к api-ai.mai.ru падают с «unable to get local issuer certificate».
// Флаг --use-system-ca решает проблему, но его нужно передать до старта Node,
// поэтому при первом запуске приложение перезапускает себя с этим флагом.
if (!String(process.env.NODE_OPTIONS || '').includes('--use-system-ca') && !process.env.MAI_CODE_RELAUNCHED) {
  const child = spawn(process.execPath, [app.getAppPath(), ...process.argv.slice(2)], {
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

function send(window, event) {
  if (window && !window.isDestroyed()) window.webContents.send('chat:event', event);
}

function runState(window) {
  const id = window.id;
  if (!runs.has(id)) runs.set(id, { controller: null, approvals: new Map() });
  return runs.get(id);
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
  createWindow();
  const settings = loadSettings();
  mcp.sync(settings.mcpServers || {}).catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- настройки ----------

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:save', async (_e, patch) => {
  const clean = { ...patch };
  if (clean.apiKey === '***' || clean.apiKey === '') delete clean.apiKey;
  const next = saveSettings(clean);
  if (patch.mcpServers) await mcp.sync(next.mcpServers || {});
  return { ...next, apiKey: next.apiKey ? '***' : '', apiKeySet: Boolean(next.apiKey) };
});

ipcMain.handle('models:list', async (_e, force) => {
  try {
    return { ok: true, models: await listModels({ force }) };
  } catch (err) {
    console.error('[models]', err?.message, err?.cause?.message || '');
    return { ok: false, error: err.message };
  }
});

// ---------- проект ----------

ipcMain.handle('project:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  saveSettings({ projectDir: result.filePaths[0] });
  return result.filePaths[0];
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
  if (!settings.apiKey) return { ok: false, error: 'Не задан API-ключ MAI. Откройте настройки.' };

  const projectDir = payload.projectDir || settings.projectDir;
  const model = payload.model || settings.model;
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
        projectDir,
        model,
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
      send(window, { type: 'saved', sessionId: session.id, title: session.title, plugins: loaded });
    } catch (err) {
      const aborted = controller.signal.aborted;
      send(window, {
        type: 'error',
        message: aborted ? 'Остановлено пользователем' : err?.message || String(err),
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

ipcMain.handle('chat:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  runState(window).controller?.abort();
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

ipcMain.handle('agents:write', (_e, { file, content }) => writeAgents(file, content));

// ---------- навыки ----------

ipcMain.handle('skills:list', (_e, projectDir) =>
  listSkills(projectDir).map(({ name, description, scope, file }) => ({ name, description, scope, file })),
);
ipcMain.handle('skills:create', (_e, { projectDir, ...data }) => createSkill(projectDir, data));
ipcMain.handle('skills:delete', (_e, file) => deleteSkill(file));

// ---------- MCP ----------

ipcMain.handle('mcp:status', () => mcp.status());
ipcMain.handle('mcp:sync', async () => {
  const settings = loadSettings();
  return mcp.sync(settings.mcpServers || {});
});
ipcMain.handle('mcp:connect', async (_e, name) => {
  const settings = loadSettings();
  const config = (settings.mcpServers || {})[name];
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
