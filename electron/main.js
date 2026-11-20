import { app, BrowserWindow, dialog, ipcMain, shell, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, publicSettings, dataDir, providerUserAgent, migrateSecrets } from './lib/config.js';
import { titleBarOptions } from './lib/window.js';
import { masStatus, masTranscribe, masConfig } from './lib/mas.js';
import { listModels, resolveModel, modelContext } from './lib/models.js';
import { startRuntime, describeRuntime, probeRuntime, permissionPlan } from './lib/runtimes.js';
import { createSession, deleteSession, getSession, listSessions, saveSession, setSessionMode, addSessionRules, removeSessionRules } from './lib/sessions.js';
import { runAgent, compactSession, describeContext } from './lib/agent.js';
import { DEFAULT_CONTEXT } from './lib/context.js';
import { createRecorder, rewindPlan, rewindFiles, checkpointTurns, removeCheckpoints } from './lib/checkpoints.js';
import { collectHooks, createHookRunner, HOOK_EVENTS } from './lib/hooks.js';
import { listAgentDefs } from './lib/agent-defs.js';
import { readManaged, readProjectLevels, mergeLevels, updateLocalRules, projectSettingsFiles } from './lib/settings-levels.js';
import { listPackages, packageDirs, packageHooks, packageMcpServers, installPackage, uninstallPackage } from './lib/packages.js';
import { createSkill, deleteSkill, listSkills, readAgents, writeAgents, agentsFile, globalAgentsFile, installBundledSkills } from './lib/skills.js';
import { readMemoryState, saveMemory, saveMemoryFile, memoryVersion, restoreMemory } from './lib/memory.js';
import { McpManager } from './lib/mcp.js';
import { loadPlugins, pluginDirs } from './lib/plugins.js';
import { disposePluginHosts, retirePluginHosts } from './lib/plugin-host.js';
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
import { checkCommand, redactSecrets } from './lib/guardrails.js';
import { emitLog, emitSpan, telemetryStatus } from './lib/telemetry.js';
import * as infra from './lib/infra.js';
import * as repowise from './lib/repowise.js';
import { editDiagram } from './lib/diagram-agent.js';
import { createWorkspace, listWorkspaces, sandboxRoot } from './lib/workspace.js';
import { authStatus, configureAuth, setLocalRole, loginKeycloak, logout, requireAdmin } from './lib/auth.js';
import { listDocs, readDoc, searchDocs } from './lib/docs.js';
import * as multica from './lib/multica.js';
import * as sandbox from './lib/container.js';
import { saveFromPaths, saveImage, uploadsRoot, removeSessionUploads, adoptDraftUploads, recognizeAttachment } from './lib/attachments.js';
import { ocrStatus } from './lib/ocr.js';
import { normalizeMode, MODE_INFO, PERMISSION_MODES } from './lib/permissions.js';
import { effectiveMode, mergeRules, parseRule, classifyTool, evaluate, relativeSubject } from './lib/policy.js';
import { createAuditLog, readAudit } from './lib/audit.js';
import { trustState, setTrust, removeTrust, listTrust, inspectProject } from './lib/trust.js';
import { guardIpc } from './lib/ipc-permissions.js';
import { isImageFile } from './lib/vision.js';
import { acquireProject } from './lib/project-lock.js';
import { BUILTIN_COMMANDS, listCustomCommands, expandTemplate, searchFiles, resolveMentions } from './lib/commands.js';
import { buildExport, fileNameFor, chatToMarkdown, FORMATS } from './lib/export/index.js';
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

/** Сколько ждём ответа на подтверждение, прежде чем отменить действие. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

let mainWindow = null;

// Матрица прав IPC (ADR 0028): роль проверяется до любого обработчика.
// Канал без записи в матрице считается admin-only.
guardIpc(ipcMain, requireAdmin, {
  onUnknown: (channel) => console.warn(`[ipc] канал ${channel} не внесён в матрицу прав — доступен только admin`),
});

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

/** Доверие к папке проекта (ADR 0028). Песочницы, созданные приложением, доверены. */
function projectTrust(projectDir) {
  return trustState(dataDir(), projectDir, { autoTrusted: [sandboxRoot()] });
}

function isTrusted(projectDir) {
  return projectTrust(projectDir).state === 'trusted';
}

/** Ответ IPC, когда решения о доверии ещё нет: окно спросит и повторит запуск. */
function needTrust(projectDir) {
  const trust = projectTrust(projectDir);
  if (trust.state !== 'unknown') return null;
  return { ok: false, needTrust: true, projectDir, found: inspectProject(projectDir), error: 'Папка проекта не доверена' };
}

/** Включённые пакеты (ADR 0037): глобальные и, для доверенной папки, проектные. */
function packagesFor(projectDir) {
  const settings = loadSettings();
  const dir = projectDir || settings.projectDir;
  return listPackages(dir, dataDir(), { includeProject: isTrusted(dir), settings: settings.packages || {} }).filter((p) => p.enabled);
}

function mcpConfigs(projectDir) {
  const settings = loadSettings();
  const dir = projectDir || settings.projectDir;
  // MCP проекта запускает процессы из чужого репозитория — только после доверия.
  // Порядок: глобальные → пакеты → проект (последний сильнее).
  return { ...(settings.mcpServers || {}), ...packageMcpServers(packagesFor(dir)), ...(isTrusted(dir) ? projectMcpConfig(dir) : {}) };
}

/** Управляемые настройки организации (ADR 0038): читаются при каждом решении — правка файла действует сразу. */
function managed() {
  return readManaged();
}

function managedHooks() {
  const org = managed();
  return org.hooks ? [{ source: 'managed', config: org.hooks }] : [];
}

/** «Без вопросов» недоступен: гость, недоверенная папка или запрет организации. */
function bypassBlocked(projectDir) {
  return authStatus().role !== 'admin' || (projectDir && !isTrusted(projectDir)) || managed().disableBypassMode;
}

/** Правила всех уровней для PolicyEngine и откуда каждое пришло. */
function rulesFor(sessionId, projectDir) {
  const settings = loadSettings();
  const session = sessionId ? getSession(sessionId) : null;
  const dir = projectDir || session?.projectDir || settings.projectDir;
  const levels = readProjectLevels(dir, { trusted: isTrusted(dir) });
  return mergeLevels([
    { level: 'managed', rules: managed().permissions },
    { level: 'user', rules: settings.permissions },
    { level: 'project', rules: levels.project },
    { level: 'local', rules: levels.local },
    { level: 'session', rules: session?.permissionRules },
  ]);
}

/** Режим разрешений для внешнего рантайма: тот же, что у встроенного агента в этом чате. */
function runtimeMode(sessionId, projectDir) {
  const settings = loadSettings();
  const session = sessionId ? getSession(sessionId) : null;
  let mode = effectiveMode(session?.permissionMode || settings.permissionMode, authStatus().role);
  if (mode === 'bypass' && bypassBlocked(projectDir)) mode = 'manual';
  return mode;
}

/** loadPlugins с учётом доверия: плагины проекта исполняются в main-процессе. */
function loadPluginsFor(projectDir) {
  return loadPlugins(projectDir, { includeProject: isTrusted(projectDir), extraDirs: packageDirs(packagesFor(projectDir), 'plugins') });
}

function send(window, event) {
  if (!window || window.isDestroyed()) return;
  // Главное окно слушает chat:event, окна досок — board:event.
  window.webContents.send('chat:event', event);
  window.webContents.send('board:event', event);
}

function runState(window) {
  const id = window.id;
  if (!runs.has(id)) runs.set(id, { controller: null, runtime: null, runtimeGroup: null, stage: null, correction: null, approvals: new Map(), questions: new Map(), queue: [] });
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
    all.push({ at: new Date().toISOString(), ...entry, message: redactSecrets(entry?.message || '') });
    fs.writeFileSync(file, JSON.stringify(all.slice(-500), null, 2), 'utf8');
  } catch {
    /* журнал ошибок не должен ломать приложение */
  }
  emitLog(entry?.message || 'error', { severity: 'ERROR', attributes: { source: entry?.source || 'app', ...entry } });
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
    ...titleBarOptions(),
    title: `MAI Code — ${titles[board] || board}`,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Песочница рендерера (A2.5): preload получает только безопасные модули Electron.
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
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
    ...titleBarOptions(),
    title: 'MAI Code',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Песочница рендерера (A2.5): preload получает только безопасные модули Electron.
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: true,
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
  // Ключи из settings.json старого формата шифруются хранилищем ОС (ADR 0031).
  try {
    const secrets = migrateSecrets();
    if (secrets.migrated) emitLog(`Зашифровано секретов в settings.json: ${secrets.migrated}`);
    if (secrets.protection !== 'os') console.warn(`[secrets] защита ключей: ${secrets.protection}`);
  } catch (err) {
    console.error('[secrets] не удалось зашифровать ключи:', err?.message || err);
  }
  createWindow();
  const settings = loadSettings();
  emitLog('MAI Code запущен', { attributes: { platform: process.platform, version: app.getVersion() } });
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
  disposePluginHosts();
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
    for (const handle of state.runtimeGroup || []) {
      try {
        handle.kill();
      } catch {
        /* уже завершено */
      }
    }
    state.runtimeGroup = null;
  }
  try {
    repowise.stopAll();
  } catch {
    /* ignore */
  }
});

// ---------- настройки ----------

ipcMain.handle('settings:get', () => publicSettings());
ipcMain.handle('telemetry:status', () => telemetryStatus());

// ---------- MAS: распознавание речи ----------

ipcMain.handle('mas:status', () => masStatus());

ipcMain.handle('mas:config', () => {
  const config = masConfig();
  return { enabled: config.enabled, url: config.url, model: config.model, tokenSet: Boolean(config.token) };
});

ipcMain.handle('mas:transcribe', async (_e, payload) => {
  const wav = payload?.wav;
  if (!wav || !wav.byteLength) throw new Error('Пустая запись');
  return masTranscribe({ wav: Buffer.from(wav), model: payload?.model });
});

// ---------- OCR: распознавание текста на изображениях ----------

ipcMain.handle('ocr:status', async (_e, payload) => {
  try {
    const status = await ocrStatus(undefined, { force: Boolean(payload?.force) });
    const { config, ...rest } = status;
    return { ok: true, ...rest, language: config.language, model: config.model };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('ocr:recognize', async (_e, payload) => {
  try {
    const { projectDir, path: target, language, engine } = payload || {};
    const result = await recognizeAttachment({ projectDir, path: target, language, engine });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('settings:save', async (_e, patch) => {
  if (patch.projectDir || patch.providers || patch.infra || patch.repowise || patch.runtimes || patch.auth || patch.guardrails || patch.telemetry) {
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
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...(() => {
          const ua = providerUserAgent(id, provider);
          return ua ? { 'User-Agent': ua } : {};
        })(),
      },
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

ipcMain.handle('runtimes:probe', (_e, payload) => {
  const runtimes = loadSettings().runtimes || {};
  const ids = payload?.runtime ? [payload.runtime] : Object.keys(runtimes);
  const result = {};
  for (const id of ids) {
    if (runtimes[id]) result[id] = probeRuntime(runtimes[id]);
  }
  return result;
});

function runtimeSession(payload, settings, prompt, model, projectDir, display = prompt) {
  let session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) session = createSession({ title: '', model, projectDir });
  session.projectDir = projectDir;
  session.model = model;
  const adopted = adoptDraftUploads(projectDir, session.id);
  if (adopted) prompt = String(prompt).split(adopted.from).join(adopted.to);
  session.messages.push({ role: 'user', content: prompt, display });
  if (!session.title || session.title === 'Новый чат') session.title = display.slice(0, 60);
  saveSession(session);
  return session;
}

ipcMain.handle('runtimes:run', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.runtime || state.runtimeGroup?.length) return { ok: false, error: 'Рантайм уже выполняется' };

  const settings = loadSettings();
  const runtime = settings.runtimes?.[payload.runtime];
  if (!runtime) return { ok: false, error: 'Рантайм не найден' };
  if (runtime.enabled === false) return { ok: false, error: 'Рантайм выключен. Включите его в панели «Рантаймы».' };
  if (!runtime.command) return { ok: false, error: 'У рантайма не задана команда' };

  const projectDir = payload.projectDir || settings.projectDir;
  const trustGate = needTrust(projectDir);
  if (trustGate) return trustGate;
  const model = payload.model || settings.activeModel || '';
  const prompt = String(payload.text || '').trim();
  if (!prompt) return { ok: false, error: 'Пустой запрос' };

  // Режим проверяется до записи сообщения в чат: отказ — это ошибка запуска, а не ответ рантайма.
  const permissionMode = runtimeMode(payload.sessionId, projectDir);
  const permission = permissionPlan(runtime, permissionMode);
  if (!permission.ok) return { ok: false, error: permission.error, permissionDenied: true };
  // Рантайм с правом записи занимает папку (A3.6); только чтение — нет.
  const lock = permission.readOnly || permissionMode === 'plan'
    ? { ok: true, release: () => {} }
    : acquireProject(projectDir, { label: `рантайм ${runtime.name || payload.runtime}` });
  if (!lock.ok) return { ok: false, busy: true, error: lock.error };

  const session = runtimeSession(payload, settings, prompt, model, projectDir, payload.displayText || prompt);
  const startedAt = Date.now();

  const handle = startRuntime({
    runtime,
    prompt,
    model,
    projectDir,
    permissionMode,
    onData: (text) => send(window, { type: 'runtime:chunk', runtimeId: payload.runtime, text }),
    onExit: ({ code, error, output }) => {
      state.runtime = null;
      lock.release();
      emitSpan('runtime.run', {
        startMs: startedAt,
        endMs: Date.now(),
        attributes: { runtime: payload.runtime, mode: runtime.mode || 'host', code },
        error: error || '',
      });
      session.messages.push({
        role: 'runtime',
        runtimeId: payload.runtime,
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
        runtimeId: payload.runtime,
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
    runtimeId: payload.runtime,
    name: runtime.name || payload.runtime,
    command: describeRuntime(runtime, { prompt, model, projectDir, target: runtime.target || '' }, permissionMode),
  });

  return { ok: true, sessionId: session.id, title: session.title };
});

/** Параллельный запуск нескольких включённых рантаймов на один запрос. */
ipcMain.handle('runtimes:runMany', async (event, payload) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.runtime || state.runtimeGroup?.length) return { ok: false, error: 'Рантайм уже выполняется' };

  const settings = loadSettings();
  const ids = Array.isArray(payload?.runtimes) ? payload.runtimes : [];
  const selected = [];
  for (const id of ids) {
    const runtime = settings.runtimes?.[id];
    if (!runtime || runtime.enabled === false || !runtime.command) continue;
    selected.push({ id, runtime });
  }
  if (!selected.length) return { ok: false, error: 'Нет включённых рантаймов с командой' };

  const projectDir = payload.projectDir || settings.projectDir;
  const trustGate = needTrust(projectDir);
  if (trustGate) return trustGate;
  const model = payload.model || settings.activeModel || '';
  const prompt = String(payload.text || '').trim();
  if (!prompt) return { ok: false, error: 'Пустой запрос' };

  const permissionMode = runtimeMode(payload.sessionId, projectDir);
  const refused = selected
    .map(({ id, runtime }) => ({ id, plan: permissionPlan(runtime, permissionMode) }))
    .filter((item) => !item.plan.ok);
  if (refused.length) {
    return { ok: false, permissionDenied: true, error: refused.map((item) => item.plan.error).join('\n') };
  }
  // Несколько агентов с правом записи в одной папке — та же гонка, что A3.6:
  // группа занимает папку целиком, пока не завершится последний.
  const writers = permissionMode !== 'plan' && selected.some(({ runtime }) => !permissionPlan(runtime, permissionMode).readOnly);
  if (writers && selected.length > 1) {
    return {
      ok: false,
      error:
        'Несколько рантаймов с правом записи в одну папку перезапишут правки друг друга. ' +
        'Запустите их в режиме «План» или по одному.',
    };
  }
  const lock = writers ? acquireProject(projectDir, { label: 'группа рантаймов' }) : { ok: true, release: () => {} };
  if (!lock.ok) return { ok: false, busy: true, error: lock.error };

  const session = runtimeSession(payload, settings, prompt, model, projectDir, payload.displayText || prompt);
  let pending = selected.length;
  const handles = [];
  state.runtimeGroup = handles;

  for (const { id, runtime } of selected) {
    const name = runtime.name || id;
    const startedAt = Date.now();
    send(window, {
      type: 'runtime:start',
      runtimeId: id,
      name,
      command: describeRuntime(runtime, { prompt, model, projectDir, target: runtime.target || '' }, permissionMode),
    });
    const handle = startRuntime({
      runtime,
      prompt,
      model,
      projectDir,
      permissionMode,
      onData: (text) => send(window, { type: 'runtime:chunk', runtimeId: id, text }),
      onExit: ({ code, error, output }) => {
        emitSpan('runtime.run', {
          startMs: startedAt,
          endMs: Date.now(),
          attributes: { runtime: id, mode: runtime.mode || 'host', code, parallel: true },
          error: error || '',
        });
        session.messages.push({ role: 'runtime', runtimeId: id, name, content: output || '', code });
        saveSession(session);
        if (error || (code !== 0 && code !== null)) {
          logError({ source: 'runtime', runtime: id, message: error || `Рантайм завершился с кодом ${code}` });
        }
        pending -= 1;
        if (pending <= 0) {
          state.runtimeGroup = null;
          lock.release();
        }
        send(window, {
          type: 'runtime:exit',
          runtimeId: id,
          code,
          error,
          sessionId: session.id,
          name,
          output: output || '',
          pending: Math.max(0, pending),
        });
      },
    });
    handles.push(handle);
  }

  return { ok: true, sessionId: session.id, title: session.title, runtimes: selected.map((s) => s.id) };
});

ipcMain.handle('runtimes:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  state.runtime?.kill();
  for (const handle of state.runtimeGroup || []) handle.kill();
  return true;
});

// ---------- проект ----------

ipcMain.handle('project:pick', async () => {
  requireAdmin();
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  // Процесс плагинов старого проекта держит его папку (cwd): останавливаем после текущих вызовов.
  retirePluginHosts();
  saveSettings({ projectDir: result.filePaths[0] });
  return result.filePaths[0];
});

// ---------- слэш-команды и упоминания файлов (CC7.7–CC7.9) ----------

ipcMain.handle('commands:list', (_e, projectDir) => {
  const dir = projectDir || loadSettings().projectDir;
  const trusted = isTrusted(dir);
  const custom = listCustomCommands(dir, dataDir(), { includeProject: trusted, extraDirs: packageDirs(packagesFor(dir), 'commands') }).map(({ name, description, argumentHint, source }) => ({
    name,
    description,
    argumentHint,
    source,
  }));
  const taken = new Set([...BUILTIN_COMMANDS.map((c) => c.name), ...custom.map((c) => c.name.toLowerCase())]);
  const skills = listSkills(dir, { includeProject: trusted, extraDirs: packageDirs(packagesFor(dir), 'skills') })
    .filter((skill) => /^[a-z0-9][a-z0-9_-]*$/i.test(skill.name) && !taken.has(skill.name.toLowerCase()))
    .map((skill) => ({ name: skill.name, description: skill.description || 'навык', argumentHint: '<задача>', source: 'skill' }));
  return [...BUILTIN_COMMANDS.map((c) => ({ ...c, source: 'builtin' })), ...custom, ...skills];
});

/** Своя команда или навык → текст запроса агенту. */
ipcMain.handle('commands:expand', (_e, payload = {}) => {
  const dir = payload.projectDir || loadSettings().projectDir;
  const name = String(payload.name || '').toLowerCase();
  const trusted = isTrusted(dir);
  const custom = listCustomCommands(dir, dataDir(), { includeProject: trusted, extraDirs: packageDirs(packagesFor(dir), 'commands') }).find((c) => c.name.toLowerCase() === name);
  if (custom) return { ok: true, prompt: expandTemplate(custom.body, payload.args), source: custom.source };
  const skill = listSkills(dir, { includeProject: trusted, extraDirs: packageDirs(packagesFor(dir), 'skills') }).find((s) => s.name.toLowerCase() === name);
  if (skill) {
    const task = String(payload.args || '').trim();
    return {
      ok: true,
      source: 'skill',
      prompt: `Используй навык «${skill.name}»: загрузи его инструментом load_skill и действуй по нему.${task ? `\n\nЗадача: ${task}` : ''}`,
    };
  }
  return { ok: false, error: `Команда /${payload.name} не найдена` };
});

ipcMain.handle('files:search', (_e, payload = {}) => {
  const dir = payload.projectDir || loadSettings().projectDir;
  if (!dir) return [];
  return searchFiles(dir, payload.query, { limit: 20 });
});

// ---------- доверие к папке (ADR 0028) ----------

ipcMain.handle('trust:get', (_e, projectDir) => {
  const dir = projectDir || loadSettings().projectDir;
  return { projectDir: dir, ...projectTrust(dir), found: inspectProject(dir) };
});

/**
 * Доверить папку может только admin: это включает исполнение её кода.
 * «Ограниченно» доступно всем — это только сужает возможности.
 */
ipcMain.handle('trust:set', async (_e, payload) => {
  const { projectDir, state } = payload || {};
  if (state === 'trusted') requireAdmin();
  const result = setTrust(dataDir(), projectDir, state);
  // MCP проекта подключается или отключается сразу.
  await mcp.sync(mcpConfigs(loadSettings().projectDir)).catch(() => {});
  return { ok: true, projectDir, ...result, found: inspectProject(projectDir) };
});

ipcMain.handle('trust:list', () => listTrust(dataDir()));

ipcMain.handle('trust:remove', async (_e, projectDir) => {
  requireAdmin();
  const result = removeTrust(dataDir(), projectDir);
  await mcp.sync(mcpConfigs(loadSettings().projectDir)).catch(() => {});
  return { ok: true, projectDir, ...result };
});

// ---------- режимы разрешений ----------

/**
 * Режим живёт в сессии. Если сессии ещё нет (новый чат), отдаём значение
 * по умолчанию из настроек — его увидит селектор до первого сообщения.
 */
ipcMain.handle('permissions:modes', (_e, sessionId) => {
  const settings = loadSettings();
  const session = sessionId ? getSession(sessionId) : null;
  const role = authStatus().role;
  const dir = session?.projectDir || settings.projectDir;
  const org = managed();
  const levels = readProjectLevels(dir, { trusted: isTrusted(dir) });
  const blocked = bypassBlocked(dir);
  const clamp = (mode) => (effectiveMode(mode, role) === 'bypass' && blocked ? 'manual' : effectiveMode(mode, role));
  return {
    current: clamp(session?.permissionMode || settings.permissionMode),
    fallback: clamp(settings.permissionMode),
    sessionId: session?.id || null,
    role,
    // «Без вопросов» недоступен гостю, в недоверенной папке и при запрете организации.
    modes: PERMISSION_MODES.map((id) => ({
      ...MODE_INFO[id],
      disabled: Boolean(id === 'bypass' && blocked),
      ...(id === 'bypass' && org.disableBypassMode ? { reason: 'запрещён настройками организации' } : {}),
    })),
    rules: {
      managed: org.permissions,
      global: mergeRules(settings.permissions),
      project: levels.project,
      local: levels.local,
      session: mergeRules(session?.permissionRules),
    },
    managed: { present: org.present, file: org.file, disableBypassMode: org.disableBypassMode },
    files: dir ? projectSettingsFiles(dir) : null,
    trusted: isTrusted(dir),
  };
});

/**
 * Сохраняет режим в сессию. Если сессии нет, запоминаем как значение по
 * умолчанию: иначе выбор в новом чате потерялся бы до первого сообщения.
 * Проверка роли — здесь, в main: интерфейс можно обойти.
 */
ipcMain.handle('permissions:set', (_e, payload) => {
  const { mode, sessionId } = payload || {};
  const next = normalizeMode(mode);
  if (MODE_INFO[next]?.adminOnly && authStatus().role !== 'admin') {
    return { ok: false, error: `Режим «${MODE_INFO[next].label}» доступен только роли admin`, mode: effectiveMode(next, 'guest') };
  }
  if (next === 'bypass' && managed().disableBypassMode) {
    return { ok: false, error: 'Режим «Без вопросов» запрещён настройками организации', mode: 'manual' };
  }
  if (sessionId) {
    const session = setSessionMode(sessionId, next);
    if (session) return { ok: true, mode: next, sessionId: session.id, scope: 'session' };
  }
  saveSettings({ permissionMode: next });
  return { ok: true, mode: next, sessionId: null, scope: 'default' };
});

/** Что будет с вызовом при текущих режиме и правилах — для панели «Разрешения» (CC2.9). */
ipcMain.handle('permissions:explain', (_e, payload = {}) => {
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  const dir = session?.projectDir || loadSettings().projectDir;
  const tool = String(payload.tool || 'run_shell');
  const cls = classifyTool(tool);
  const { rules, origin } = rulesFor(session?.id, dir);
  const mode = policyFor(session?.id, dir).getMode();
  const subject = cls === 'exec' ? String(payload.subject || '') : payload.subject ? relativeSubject(dir, payload.subject) : null;
  const decision = evaluate({ tool, cls, subject, mode, rules, guardrails: loadSettings().guardrails, role: authStatus().role });
  return { ...decision, tool, cls, subject, levels: decision.rule ? origin[`${decision.action}:${decision.rule}`] || origin[`allow:${decision.rule}`] || [] : [] };
});

/** Правила разрешений: сессия или глобально. Глобальные меняет только admin. */
ipcMain.handle('permissions:rules', (_e, payload) => {
  const { sessionId, scope = 'session', kind = 'allow', add = [], remove = [] } = payload || {};
  const valid = (list) => (list || []).map(String).filter((rule) => parseRule(rule));
  if (scope === 'local') {
    // Личные правила проекта (ADR 0038): только для доверенной папки, меняет admin.
    requireAdmin();
    const session = sessionId ? getSession(sessionId) : null;
    const dir = session?.projectDir || loadSettings().projectDir;
    if (!isTrusted(dir)) return { ok: false, error: 'Папка не доверена — правила проекта не сохраняются' };
    return { ok: true, rules: updateLocalRules(dir, { kind, add: valid(add), remove: valid(remove) }) };
  }
  if (scope === 'global') {
    requireAdmin();
    const current = mergeRules(loadSettings().permissions);
    const key = ['allow', 'ask', 'deny'].includes(kind) ? kind : 'allow';
    const drop = new Set(valid(remove));
    current[key] = [...current[key].filter((r) => !drop.has(r)), ...valid(add).filter((r) => !current[key].includes(r))];
    saveSettings({ permissions: current });
    return { ok: true, rules: current };
  }
  if (!sessionId) return { ok: false, error: 'нет сессии' };
  if (remove?.length) removeSessionRules(sessionId, valid(remove));
  const updated = add?.length ? addSessionRules(sessionId, kind, valid(add)) : getSession(sessionId);
  return { ok: true, rules: mergeRules(updated?.permissionRules) };
});

ipcMain.handle('permissions:audit', (_e, payload) => {
  requireAdmin();
  return readAudit(dataDir(), { limit: Number(payload?.limit) || 200 });
});

// ---------- вложения ----------

ipcMain.handle('attachments:add', (_e, payload) => {
  try {
    const { projectDir, sessionId, paths } = payload || {};
    return { ok: true, ...saveFromPaths({ projectDir, sessionId, paths }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), entries: [], errors: [] };
  }
});

ipcMain.handle('attachments:addImage', (_e, payload) => {
  try {
    const { projectDir, sessionId, name, dataUrl } = payload || {};
    return { ok: true, entry: saveImage({ projectDir, sessionId, name, dataUrl }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('attachments:pick', async (_e, payload) => {
  const { projectDir, sessionId } = payload || {};
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Прикрепить файлы',
    filters: [
      { name: 'Все файлы', extensions: ['*'] },
      { name: 'Документы', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'md', 'csv'] },
      { name: 'Архивы', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'] },
      { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, entries: [], errors: [] };
  try {
    return { ok: true, ...saveFromPaths({ projectDir, sessionId, paths: result.filePaths }) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), entries: [], errors: [] };
  }
});

ipcMain.handle('attachments:remove', (_e, payload) => {
  const { projectDir, path: target } = payload || {};
  if (!projectDir || !target) return { ok: false, error: 'нет пути' };
  const full = path.resolve(projectDir, target);
  const rel = path.relative(uploadsRoot(projectDir), full);
  // Удалять можно только внутри папки вложений: иначе агент сотрёт файлы проекта.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'путь вне папки вложений' };
  }
  try {
    fs.rmSync(full, { recursive: true, force: true });
    fs.rmSync(`${full}.txt`, { force: true });
    fs.rmSync(`${full}.index.txt`, { force: true });
    fs.rmSync(`${full}.extracted`, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('attachments:open', async (_e, payload) => {
  const { projectDir, path: target } = payload || {};
  if (!projectDir || !target) return false;
  const full = path.resolve(projectDir, target);
  const rel = path.relative(projectDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  await shell.openPath(full);
  return true;
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

// Фильтр по проекту и поиск по тексту (CC6.6, CC6.7).
ipcMain.handle('sessions:list', (_e, options) => listSessions(options && typeof options === 'object' ? { projectDir: String(options.projectDir || ''), query: String(options.query || '').slice(0, 200) } : {}));
ipcMain.handle('sessions:get', (_e, id) => getSession(id));
ipcMain.handle('sessions:create', (_e, data) => createSession(data || {}));
ipcMain.handle('sessions:delete', (_e, id) => {
  const session = getSession(id);
  if (session?.projectDir) removeSessionUploads(session.projectDir, id);
  removeCheckpoints(dataDir(), id);
  return deleteSession(id);
});

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
  const trustGate = needTrust(projectDir);
  if (trustGate) return trustGate;
  const trusted = isTrusted(projectDir);
  // Один пишущий прогон на папку (A3.6): иначе чат и самокоррекция перезаписывают друг друга.
  const lock = acquireProject(projectDir, { label: 'чат агента' });
  if (!lock.ok) return { ok: false, busy: true, error: lock.error };
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
  // UserPromptSubmit и SessionStart (ADR 0035): до записи сообщения в чат.
  const hooks = hookRunnerFor(window, { projectDir, sessionId: payload.sessionId || '', trusted });
  if (payload.text && hooks.has('UserPromptSubmit')) {
    const hook = await hooks.run('UserPromptSubmit', { prompt: String(payload.displayText || payload.text) });
    if (hook.decision === 'block' || hook.decision === 'deny') {
      lock.release();
      return { ok: false, error: `Хук UserPromptSubmit не пропустил запрос: ${hook.reason || 'без причины'}` };
    }
    if (hook.context.length) payload.text = `${payload.text}\n\n[Контекст от хука]\n${hook.context.join('\n')}`;
  }
  if (!payload.sessionId && payload.text && hooks.has('SessionStart')) {
    const start = await hooks.run('SessionStart', { source: 'new' });
    if (start.context.length) payload.text = `${payload.text}\n\n[Контекст начала сессии]\n${start.context.join('\n')}`;
  }
  let session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) {
    // Режим из интерфейса переносим в новую сессию: пользователь выбрал его
    // до первого сообщения, и выбор не должен потеряться.
    session = createSession({
      title: '',
      model,
      projectDir,
      permissionMode: payload.permissionMode ? normalizeMode(payload.permissionMode) : '',
    });
  }
  session.model = model;
  session.projectDir = projectDir;
  // Вложения прикрепляют до создания сессии, поэтому они лежат в `draft`.
  // Переносим их в папку сессии и правим пути в тексте запроса.
  const adopted = adoptDraftUploads(projectDir, session.id);
  if (adopted && payload.text) {
    payload.text = String(payload.text).split(adopted.from).join(adopted.to);
  }
  // Упоминания @файл — ссылкой, не копией (CC7.9): агент прочитает сам.
  const mentions = payload.text ? resolveMentions(projectDir, payload.text) : [];
  if (mentions.length) {
    payload.text = `${payload.text}\n\n[Упомянуты: ${mentions.map((m) => `${m.path}${m.dir ? ' (папка)' : ''}`).join(', ')}. Прочитай их через read_file или list_files.]`;
  }
  // Пути изображений из вложений: в сессии храним путь, base64 собирается на запрос (F1).
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .map((p) => String(p || ''))
    .map((p) => (adopted ? p.split(adopted.from).join(adopted.to) : p))
    .filter((p) => isImageFile(p))
    .slice(0, 20);
  if (payload.text) {
    const display = payload.displayText || payload.text;
    session.messages.push({ role: 'user', content: payload.text, display, ...(images.length ? { images } : {}) });
    if (!session.title || session.title === 'Новый чат') {
      session.title = display.trim().slice(0, 60) || 'Новый чат';
    }
  }
  saveSession(session);

  const controller = new AbortController();
  state.controller = controller;

  let plugins;
  try {
    plugins = await loadPluginsFor(projectDir);
  } catch (err) {
    state.controller = null;
    lock.release();
    return { ok: false, error: `Плагины не загрузились: ${err?.message || String(err)}` };
  }
  const { tools: pluginTools, transforms, loaded } = plugins;

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
        permissionMode: session.permissionMode || '',
        policy: policyFor(session.id, projectDir),
        audit,
        trusted,
        // Размер контекста модели — для индикатора и автокомпакции (CC5.1, CC5.3).
        contextWindow: modelContext(resolved.providerId, resolved.modelId, resolved.provider) || DEFAULT_CONTEXT,
        // Чекпоинты правок для отката (CC6.1).
        checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
        hooks,
        // Типы субагентов: встроенные и свои (проекта — только доверенная папка, ADR 0036).
        agentDefs: listAgentDefs(projectDir, dataDir(), { includeProject: trusted, extraDirs: packageDirs(packagesFor(projectDir), 'agents') }),
        skillDirs: packageDirs(packagesFor(projectDir), 'skills'),
        // История сохраняется после каждого шага: при сбое выполненные
        // правки и команды не пропадают из сессии (они уже на диске).
        onHistory: (history) => {
          session.messages = history;
          saveSession(session);
        },
        emit: (e) => send(window, e),
        approve: makeApprover(window, state, session.id),
        ask: makeAsker(window, state, session.id, projectDir),
        // Очередь сообщений, написанных во время работы (CC7.5).
        pullQueued: () => state.queue.splice(0),
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
      // onHistory уже сохранил выполненные шаги; здесь фиксируем финальное состояние.
      saveSession(session);
    } finally {
      state.controller = null;
      state.approvals.clear();
      state.questions.clear();
      // Не взятые агентом сообщения возвращаем в поле ввода, чтобы они не пропали.
      const leftover = state.queue.splice(0);
      if (leftover.length) send(window, { type: 'queued:returned', items: leftover });
      lock.release();
    }
  })();

  return { ok: true, sessionId: session.id, title: session.title };
});

const audit = (record) => auditLog()(record);
let auditInstance = null;
function auditLog() {
  auditInstance ||= createAuditLog(dataDir());
  return auditInstance;
}

/**
 * Политика для прогона агента: режим, правила и роль читаются на каждый
 * вызов, поэтому переключение в интерфейсе действует сразу (ADR 0027).
 */
function policyFor(sessionId, projectDir = '') {
  return {
    role: authStatus().role,
    getMode: () => {
      const settings = loadSettings();
      const session = sessionId ? getSession(sessionId) : null;
      const mode = effectiveMode(session?.permissionMode || settings.permissionMode, authStatus().role);
      // «Без вопросов» не действует в недоверенной папке (ADR 0028) и при запрете организации (ADR 0038).
      if (mode === 'bypass' && bypassBlocked(projectDir)) return 'manual';
      return mode;
    },
    // Правила всех уровней: организация, пользователь, проект, локальные, чат (ADR 0038).
    getRules: () => rulesFor(sessionId, projectDir).rules,
  };
}

/**
 * Хуки прогона (ADR 0035): глобальные и проекта (только доверенная папка).
 * Каждое срабатывание пишется в журнал решений и показывается в окне.
 */
function hookRunnerFor(window, { projectDir, sessionId, trusted }) {
  const settings = loadSettings();
  return createHookRunner({
    // Хуки организации (ADR 0038) идут первыми и не выключаются пользователем.
    hooks: collectHooks({ settingsHooks: settings.hooks, projectDir, trusted, packageHooks: [...managedHooks(), ...packageHooks(packagesFor(projectDir))] }),
    projectDir,
    sessionId,
    onRun: (record) => {
      audit({ at: new Date().toISOString(), tool: `hook:${record.event}`, source: record.source, cls: 'hook', subject: record.command.slice(0, 300), decision: record.decision || (record.code === 0 ? 'ok' : 'error'), code: record.code, ms: record.ms, error: record.error });
      send(window, { type: 'hook', ...record });
    },
  });
}

/**
 * Создаёт функцию approve: показывает запрос в окне и ждёт ответа.
 * Решение «спрашивать ли» уже принял PolicyEngine — сюда приходят только ask.
 * Ответ «да, и не спрашивать» сохраняет правила в сессию или глобально.
 */
function makeApprover(window, state, sessionId) {
  return (request, legacySummary = '') => {
    const payload = typeof request === 'string' ? { tool: request, summary: legacySummary } : request || {};
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      // Таймаут обязателен: если окно потеряло событие или пользователь закрыл
      // модалку, промис иначе не резолвится никогда и прогон висит вечно.
      const timer = setTimeout(() => {
        if (!state.approvals.has(id)) return;
        state.approvals.delete(id);
        send(window, { type: 'approval:expired', id, name: payload.tool });
        resolve({ allow: false, message: 'Подтверждение не получено за 10 минут — действие отменено.' });
      }, APPROVAL_TIMEOUT_MS);
      state.approvals.set(id, (answer) => {
        clearTimeout(timer);
        if (answer?.allow && answer.remember && answer.rules?.length) {
          const rules = answer.rules.filter((rule) => parseRule(rule));
          try {
            if (answer.remember === 'global') {
              requireAdmin();
              const current = mergeRules(loadSettings().permissions);
              current.allow = [...current.allow, ...rules.filter((r) => !current.allow.includes(r))];
              saveSettings({ permissions: current });
            } else if (answer.remember === 'local') {
              // Личные правила проекта — .mai-code/settings.local.json (ADR 0038).
              const dir = (sessionId && getSession(sessionId)?.projectDir) || loadSettings().projectDir;
              if (!isTrusted(dir)) throw new Error('папка не доверена — правила проекта не сохраняются');
              requireAdmin();
              updateLocalRules(dir, { kind: 'allow', add: rules });
            } else if (sessionId) {
              addSessionRules(sessionId, 'allow', rules);
            }
          } catch (err) {
            send(window, { type: 'notice', text: `Правило не сохранено: ${err?.message || String(err)}` });
          }
        }
        resolve(answer);
      });
      // Для обратной совместимости окна досок: name и summary остаются.
      send(window, { type: 'approval', id, name: payload.tool, ...payload });
    });
  };
}

/**
 * Вопрос пользователю из ask_user или карточка плана из exit_plan (CC1.7, CC1.8).
 * Ответ на план с выбранным режимом сразу меняет режим сессии: PolicyEngine
 * читает режим на каждый вызов, и следующая итерация получит инструменты записи.
 */
function makeAsker(window, state, sessionId, projectDir) {
  return (request) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (!state.questions.has(id)) return;
        state.questions.delete(id);
        send(window, { type: 'question:expired', id });
        resolve({ cancelled: true });
      }, APPROVAL_TIMEOUT_MS);
      state.questions.set(id, (answer) => {
        clearTimeout(timer);
        if (request.kind === 'plan' && answer?.action === 'approve') {
          const wanted = normalizeMode(answer.mode);
          let mode = ['manual', 'acceptEdits', 'smart', 'bypass'].includes(wanted) ? wanted : 'manual';
          // Те же ограничения, что у селектора режима: гостю и в недоверенной папке — без «Без вопросов».
          if (mode === 'bypass' && bypassBlocked(projectDir)) mode = 'manual';
          if (sessionId) setSessionMode(sessionId, mode);
          answer = { ...answer, mode };
          send(window, { type: 'mode:changed', sessionId, mode });
        }
        resolve(answer);
      });
      send(window, { type: 'question', id, ...request });
    });
}

/** Закрывает висящие подтверждения отказом, иначе инструмент ждёт клика вечно. */
function denyApprovals(state) {
  for (const resolve of state.approvals.values()) resolve({ allow: false, message: 'Остановлено пользователем.' });
  state.approvals.clear();
  for (const resolve of state.questions.values()) resolve({ cancelled: true });
  state.questions.clear();
}

ipcMain.handle('chat:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  denyApprovals(state);
  state.controller?.abort();
  return true;
});

// ---------- чекпоинты и откат (CC6.1) ----------

ipcMain.handle('checkpoints:turns', (_e, sessionId) => (sessionId ? checkpointTurns(dataDir(), sessionId) : []));

/** Что вернёт откат к сообщению: файлы и меняются ли они с тех пор. */
ipcMain.handle('checkpoints:plan', (_e, payload = {}) => {
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) return { ok: false, error: 'Чат не найден' };
  const turn = Number(payload.turn);
  const message = session.messages?.[turn];
  if (message?.role !== 'user') return { ok: false, error: 'Откат возможен только к сообщению пользователя' };
  return {
    ok: true,
    text: message.display || message.content || '',
    later: session.messages.length - turn,
    files: rewindPlan(dataDir(), session.id, turn).map((f) => ({ ...f, file: path.relative(session.projectDir || '', f.file) || f.file })),
  };
});

/**
 * Откат к сообщению пользователя: `code` — файлы, `conversation` — история
 * (сообщение и всё после него удаляются, текст возвращается в поле ввода), `both`.
 */
ipcMain.handle('checkpoints:rewind', (event, payload = {}) => {
  const state = runState(BrowserWindow.fromWebContents(event.sender));
  if (state.controller) return { ok: false, error: 'Агент работает — остановите его перед откатом' };
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) return { ok: false, error: 'Чат не найден' };
  const turn = Number(payload.turn);
  const message = session.messages?.[turn];
  if (message?.role !== 'user') return { ok: false, error: 'Откат возможен только к сообщению пользователя' };
  const mode = ['code', 'conversation', 'both'].includes(payload.mode) ? payload.mode : 'both';
  const lock = acquireProject(session.projectDir, { label: 'откат' });
  if (!lock.ok) return { ok: false, busy: true, error: lock.error };
  try {
    let files = { restored: [], failed: [] };
    if (mode !== 'conversation') files = rewindFiles(dataDir(), session.id, turn);
    if (mode !== 'code') {
      session.messages = session.messages.slice(0, turn);
      saveSession(session);
    }
    audit({ at: new Date().toISOString(), tool: 'rewind', source: 'user', cls: 'write', subject: `ход ${turn}`, mode, decision: 'allow', restored: files.restored.length });
    return { ok: true, mode, text: message.display || message.content || '', messages: session.messages, ...files };
  } finally {
    lock.release();
  }
});

// ---------- пакеты плагинов (ADR 0037) ----------

ipcMain.handle('packages:list', (_e, projectDir) => {
  const settings = loadSettings();
  const dir = projectDir || settings.projectDir;
  return {
    packages: listPackages(dir, dataDir(), { includeProject: isTrusted(dir), settings: settings.packages || {} }),
    trusted: isTrusted(dir),
    globalDir: path.join(dataDir(), 'packages'),
  };
});

/** Установка из папки или git-URL в глобальные пакеты. Код пакета исполняется — только admin. */
ipcMain.handle('packages:install', async (_e, payload = {}) => {
  try {
    const pkg = installPackage({ from: payload.from, dataDir: dataDir(), replace: payload.replace === true });
    retirePluginHosts();
    await mcp.sync(mcpConfigs(loadSettings().projectDir)).catch(() => {});
    audit({ at: new Date().toISOString(), tool: 'package:install', source: 'user', cls: 'external', subject: `${pkg.name} ← ${String(payload.from).slice(0, 300)}`, decision: 'allow' });
    return { ok: true, package: pkg };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('packages:uninstall', async (_e, name) => {
  try {
    uninstallPackage({ name, dataDir: dataDir() });
    retirePluginHosts();
    await mcp.sync(mcpConfigs(loadSettings().projectDir)).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('packages:toggle', async (_e, payload = {}) => {
  const settings = loadSettings();
  const packages = { ...(settings.packages || {}) };
  packages[String(payload.name)] = { ...(packages[payload.name] || {}), enabled: payload.enabled === true };
  saveSettings({ packages });
  retirePluginHosts();
  await mcp.sync(mcpConfigs(settings.projectDir)).catch(() => {});
  return { ok: true };
});

/** Типы субагентов для `/agents` (CC8.2). */
ipcMain.handle('agents:defs', (_e, projectDir) => {
  const dir = projectDir || loadSettings().projectDir;
  return listAgentDefs(dir, dataDir(), { includeProject: isTrusted(dir), extraDirs: packageDirs(packagesFor(dir), 'agents') }).map(({ name, description, tools, source }) => ({ name, description, tools, source }));
});

/** Хуки для `/hooks`: события, matcher, команда, источник (CC3.3). */
ipcMain.handle('hooks:list', (_e, projectDir) => {
  const dir = projectDir || loadSettings().projectDir;
  const trusted = isTrusted(dir);
  const config = collectHooks({ settingsHooks: loadSettings().hooks, projectDir: dir, trusted, packageHooks: [...managedHooks(), ...packageHooks(packagesFor(dir))] });
  const rows = [];
  for (const event of HOOK_EVENTS) {
    for (const group of config[event] || []) {
      for (const hook of group.hooks) rows.push({ event, matcher: group.matcher || '*', command: hook.command, timeout: hook.timeout, source: hook.source });
    }
  }
  return { rows, trusted, projectFile: path.join(dir || '', '.mai-code', 'hooks.json') };
});

/** Ручная компакция (`/compact [что учесть]`, CC5.3). Только когда агент не работает. */
ipcMain.handle('chat:compact', async (event, payload = {}) => {
  const state = runState(BrowserWindow.fromWebContents(event.sender));
  if (state.controller) return { ok: false, error: 'Агент работает — сожмите контекст после ответа' };
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) return { ok: false, error: 'Нет чата для компакции' };
  const settings = loadSettings();
  let resolved;
  try {
    resolved = resolveModel(settings, session.model || settings.activeModel);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!resolved.provider.apiKey) return { ok: false, error: `Не задан API-ключ провайдера «${resolved.provider.name}»` };
  try {
    const { marker, history } = await compactSession({
      provider: resolved.provider,
      model: resolved.modelId,
      messages: session.messages || [],
      instructions: String(payload.instructions || '').slice(0, 2000),
    });
    if (!marker) return { ok: false, error: 'Сжимать нечего: в чате меньше двух запросов' };
    session.messages = history;
    saveSession(session);
    return { ok: true, marker, messages: history };
  } catch (err) {
    return { ok: false, error: `Компакция не удалась: ${err?.message || String(err)}` };
  }
});

/** Разбор контекста для `/context` (CC5.2). */
ipcMain.handle('context:stats', (_e, payload = {}) => {
  const settings = loadSettings();
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  const projectDir = session?.projectDir || payload.projectDir || settings.projectDir;
  let window = DEFAULT_CONTEXT;
  try {
    const resolved = resolveModel(settings, payload.model || session?.model || settings.activeModel);
    window = modelContext(resolved.providerId, resolved.modelId, resolved.provider) || DEFAULT_CONTEXT;
  } catch {
    /* модель не разрешилась — окно по умолчанию */
  }
  return describeContext({
    settings,
    projectDir,
    mode: runtimeMode(session?.id, projectDir),
    trusted: isTrusted(projectDir),
    mcp,
    history: session?.messages || [],
    window,
    skillDirs: packageDirs(packagesFor(projectDir), 'skills'),
  });
});

/** Сообщение во время работы агента: встанет в историю перед следующим шагом. */
ipcMain.handle('chat:queue', (event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (!state.controller) return { ok: false, idle: true };
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, error: 'Пустое сообщение' };
  if (state.queue.length >= 10) return { ok: false, error: 'В очереди уже 10 сообщений' };
  const item = { id: crypto.randomUUID(), text: text.slice(0, 100_000), display: String(payload.displayText || text).slice(0, 100_000) };
  state.queue.push(item);
  return { ok: true, id: item.id, size: state.queue.length };
});

ipcMain.handle('chat:unqueue', (event, payload = {}) => {
  const state = runState(BrowserWindow.fromWebContents(event.sender));
  const index = state.queue.findIndex((item) => item.id === payload.id);
  if (index === -1) return { ok: false, error: 'Сообщение уже передано агенту' };
  const [item] = state.queue.splice(index, 1);
  return { ok: true, item };
});

ipcMain.handle('chat:answer', (event, payload = {}) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  const resolve = state.questions.get(payload.id);
  if (resolve) {
    state.questions.delete(payload.id);
    const answer = payload.answer || {};
    resolve({
      cancelled: answer.cancelled === true,
      answers: Array.isArray(answer.answers) ? answer.answers.map((a) => (Array.isArray(a) ? a.map(String) : String(a ?? ''))) : [],
      action: answer.action === 'revise' ? 'revise' : answer.action === 'approve' ? 'approve' : '',
      mode: String(answer.mode || ''),
      alternative: Number.isInteger(answer.alternative) ? answer.alternative : -1,
      feedback: String(answer.feedback || '').slice(0, 4000),
    });
  }
  return true;
});

ipcMain.handle('chat:approval', (event, payload = {}) => {
  const { id, allow, remember, rules, feedback } = payload;
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  const resolve = state.approvals.get(id);
  if (resolve) {
    state.approvals.delete(id);
    // allow === undefined означает «модалку закрыли без ответа» — это отказ.
    resolve({
      allow: allow === true,
      remember: ['global', 'session', 'local'].includes(remember) ? remember : null,
      rules: Array.isArray(rules) ? rules.map(String) : [],
      feedback: String(feedback || '').slice(0, 2000),
    });
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

ipcMain.handle('memory:read', (_e, projectDir) => readMemoryState(projectDir));
ipcMain.handle('memory:write', (_e, { file, content, projectDir }) => {
  requireAdmin();
  return saveMemoryFile(projectOf({ projectDir }), file, content);
});

/** Быстрая запись `# текст` из поля ввода (CC4.3): строка в конец памяти, без дублей. */
ipcMain.handle('memory:append', (_e, payload = {}) => {
  const projectDir = projectOf(payload);
  const scope = payload.scope === 'global' ? 'global' : 'project';
  const text = String(payload.text || '').trim().slice(0, 4000);
  if (!text) return { ok: false, error: 'Пустая запись' };
  const state = readMemoryState(projectDir);
  const current = String(state[scope] || '');
  const line = text.startsWith('- ') ? text : `- ${text}`;
  if (current.includes(text)) return { ok: true, changed: false, scope };
  const separator = current.trim() ? (current.endsWith('\n') ? '' : '\n') : '';
  const result = saveMemory(projectDir, { scope, content: `${current}${separator}${line}\n`, note: 'запись из поля ввода (#)' });
  return { ok: true, changed: true, scope, version: result.version };
});

ipcMain.handle('memory:save', (_e, payload) => {
  requireAdmin();
  return saveMemory(projectOf(payload), { scope: payload.scope, content: payload.content, note: payload.note });
});

ipcMain.handle('memory:version', (_e, payload) =>
  memoryVersion(projectOf(payload), payload.scope, payload.version),
);

ipcMain.handle('memory:restore', (_e, payload) => {
  requireAdmin();
  return restoreMemory(projectOf(payload), payload.scope, payload.version);
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
ipcMain.handle('multica:install', () => {
  requireAdmin();
  return multica.installCli();
});
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
  const { loaded } = await loadPluginsFor(projectDir);
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
// Плагин исполняется в отдельном процессе (ADR 0030): без доступа к Electron,
// окнам и переменным окружения с ключами. Файлы проекта доступны.

export default {
  name: 'example-plugin',

  tools: [
    {
      // Класс действия (ADR 0027): read | write | exec | network | external.
      // Без поля инструмент считается внешним, и пользователя спросят.
      kind: 'read',
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
  // Хук может быть async и должен вернуть массив сообщений.
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

/**
 * Экспорт ответа агента в файл: md, txt, docx, xlsx.
 *
 * Сборка содержимого — в `electron/lib/export`, здесь только диалог сохранения
 * и запись. Форматы не требуют сети и внешних библиотек. См. ADR 0025.
 */
async function saveExport(event, markdown, format, title) {
  const key = String(format || 'md').toLowerCase();
  if (!FORMATS[key]) {
    return { ok: false, error: `Неизвестный формат: ${format}. Доступны: ${Object.keys(FORMATS).join(', ')}` };
  }
  const text = String(markdown || '');
  if (!text.trim()) return { ok: false, error: 'Нечего сохранять: ответ пуст' };

  let built;
  try {
    built = buildExport(text, key, { title });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: 'Скачать ответ',
    defaultPath: path.join(app.getPath('downloads'), fileNameFor(text, built.ext)),
    filters: [{ name: FORMATS[key].name, extensions: [built.ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(filePath, built.data);
  } catch (err) {
    return { ok: false, error: `Не удалось записать файл: ${err.message}` };
  }
  return { ok: true, file: filePath, format: key };
}

ipcMain.handle('export:message', async (event, payload) =>
  saveExport(event, payload?.markdown, payload?.format, payload?.title),
);

ipcMain.handle('export:chat', async (event, payload) => {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const markdown = chatToMarkdown(messages, { title: payload?.title });
  return saveExport(event, markdown, payload?.format, payload?.title);
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
  scanQuality(projectOf(payload), { loadPlugins: loadPluginsFor }),
);

ipcMain.handle('boards:git', (_e, payload) => gitStatus(projectOf(payload)));
ipcMain.handle('boards:diff', (_e, payload) => gitDiff(projectOf(payload), payload?.file || ''));

ipcMain.handle('boards:stageRun', (event, payload) => {
  requireAdmin();
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  if (state.stage) return { ok: false, error: 'Стадия уже выполняется' };

  const projectDir = projectOf(payload);
  // Команда стадии лежит в boards.json проекта: её мог подложить чужой
  // репозиторий. Без доверия к папке стадии не запускаются (A1.11, ADR 0028).
  if (!isTrusted(projectDir)) {
    return { ok: false, error: 'Стадии запускают команды из boards.json проекта — сначала доверьте папку в главном окне.' };
  }
  const data = loadBoards(projectDir);
  const stage = (data.runners.stages || []).find((s) => s.id === payload.stageId);
  if (!stage) return { ok: false, error: 'Стадия не найдена' };

  const command = payload.command || stage.command;
  if (!command) return { ok: false, error: 'Не задана команда стадии' };

  const guard = checkCommand(command, { guardrails: loadSettings().guardrails });
  if (!guard.allowed) return { ok: false, error: `Guardrails: ${guard.reason}` };

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
  const trustGate = needTrust(projectDir);
  if (trustGate) return trustGate;
  const trusted = isTrusted(projectDir);
  const settings = loadSettings();
  const resolved = resolveModel(settings, payload.model || settings.activeModel);
  if (!resolved.provider.apiKey) return { ok: false, error: 'Нет ключа выбранного провайдера' };
  const boards = loadBoards(projectDir);
  const selected = (boards.quality.issues || []).filter(
    (issue) => issue.status !== 'ignored' && (!payload.issueIds?.length || payload.issueIds.includes(issue.id)),
  );
  if (!selected.length) return { ok: false, error: 'Нет проблем для исправления' };
  const lock = acquireProject(projectDir, { label: 'самокоррекция' });
  if (!lock.ok) return { ok: false, busy: true, error: lock.error };

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
  let plugins;
  try {
    plugins = await loadPluginsFor(projectDir);
  } catch (err) {
    state.correction = null;
    lock.release();
    return { ok: false, error: `Плагины не загрузились: ${err?.message || String(err)}` };
  }
  const { tools: pluginTools, transforms } = plugins;

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
        permissionMode: session.permissionMode || '',
        policy: policyFor(session.id, projectDir),
        audit,
        trusted,
        // Размер контекста модели — для индикатора и автокомпакции (CC5.1, CC5.3).
        contextWindow: modelContext(resolved.providerId, resolved.modelId, resolved.provider) || DEFAULT_CONTEXT,
        // Чекпоинты правок для отката (CC6.1).
        checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
        // История сохраняется после каждого шага: при сбое выполненные
        // правки и команды не пропадают из сессии (они уже на диске).
        onHistory: (history) => {
          session.messages = history;
          saveSession(session);
        },
        emit: (e) => send(window, e),
        approve: makeApprover(window, state, session.id),
        ask: makeAsker(window, state, session.id, projectDir),
      });
      session.messages = history;
      saveSession(session);
      if (controller.signal.aborted) throw new Error('Остановлено пользователем');
      const scan = await scanQuality(projectDir, { loadPlugins: loadPluginsFor });
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
      lock.release();
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
ipcMain.handle('repowise:distill', (_e, payload) => {
  // Команда выполняется в оболочке: те же guardrails, что у run_shell.
  const guard = checkCommand(String(payload?.command || ''), { guardrails: loadSettings().guardrails });
  if (!guard.allowed) return { ok: false, output: `Guardrails заблокировали команду: ${guard.reason}` };
  return repowiseResult(() => repowise.distill(projectOf(payload), payload.command));
});

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
  // shell.openPath запускает файл ассоциированной программой — это исполнение.
  // Окну нужно только открывать папки, поэтому файлы не открываем (ADR 0028).
  if (!target) return false;
  try {
    if (!fs.statSync(target).isDirectory()) return false;
  } catch {
    return false;
  }
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

// В песочнице preload нет модуля clipboard — запись идёт через main (A2.5).
ipcMain.handle('app:clipboard', (_e, text) => {
  clipboard.writeText(String(text ?? '').slice(0, 5_000_000));
  return true;
});

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
