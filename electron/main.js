import { app, BrowserWindow, dialog, ipcMain, shell, clipboard, Notification, nativeTheme, safeStorage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, publicSettings, dataDir, providerUserAgent, migrateSecrets, secretBox } from './lib/config.js';
import { titleBarOptions, windowColors, normalizeTheme } from './lib/window.js';
import { masStatus, masTranscribe, masConfig } from './lib/mas.js';
import { voiceConfig, providerVoiceStatus, providerTranscribe } from './lib/voice.js';
import { listModels, resolveModel, modelContext } from './lib/models.js';
import { startRuntime, describeRuntime, probeRuntime, permissionPlan, exportRuntimes, importRuntimes } from './lib/runtimes.js';
import { createSession, deleteSession, getSession, listSessions, saveSession, setSessionMode, setSessionDirs, setSessionKind, setSessionRun, markInterrupted, addSessionRules, removeSessionRules, renameSession, forkSession, importSession, expiredSessions } from './lib/sessions.js';
import { runAgent, compactSession, describeContext, suggestTitle, suggestLesson } from './lib/agent.js';
import { DEFAULT_CONTEXT } from './lib/context.js';
import { createRecorder, rewindPlan, rewindFiles, checkpointTurns, removeCheckpoints } from './lib/checkpoints.js';
import { collectHooks, createHookRunner, HOOK_EVENTS } from './lib/hooks.js';
import { listAgentDefs } from './lib/agent-defs.js';
import { normalizeShellSandbox } from './lib/shell-sandbox.js';
import { createOAuthStore } from './lib/mcp-oauth.js';
import { listTrash, restoreFromTrash, purgeTrash } from './lib/trash.js';
import { disposeBackground, execute as executeShell } from './lib/tools/shell.js';
import { normalizeRoots } from './lib/workroots.js';
import { listConnectors, connectorServerConfig } from './lib/connectors.js';
import { sessionResults, previewResult, resultFile } from './lib/results.js';
import { createScheduleStore, isDue, nextRunAt, describeSchedule } from './lib/scheduler.js';
import { modelCapabilities } from './lib/capabilities.js';
import { createTracer, NO_TRACER } from './lib/tracer.js';
import { createProjectStore } from './lib/projects.js';
import { renderPdf, renderPng } from './lib/pdf-render.js';
import { createAgentBrowser } from './lib/browser-agent.js';
import { listMarketplaces, refreshMarketplace, installFromMarketplace, normalizeMarketplace, catalogDir, CATALOG } from './lib/marketplace.js';
import { readManaged, readProjectLevels, mergeLevels, updateLocalRules, projectSettingsFiles, updateLocalMcp } from './lib/settings-levels.js';
import { listPackages, packageDirs, packageHooks, packageMcpServers, installPackage, uninstallPackage } from './lib/packages.js';
import { listRoles, installRole } from './lib/roles.js';
import { installRoleSkills, catalogRoles } from './lib/catalog-roles.js';
import { skillConflicts } from './lib/skills.js';
import { wrapData } from './lib/injection.js';
import { localConnectors } from './lib/local-connectors.js';
import { createNotifier } from './lib/notify.js';
import { currentBranch } from './lib/git-guard.js';
import { repoRoot, realPath, createWorktree, listWorktrees, removeWorktree, worktreeId } from './lib/worktree.js';
import { createSkill, deleteSkill, listSkills, readAgents, writeAgents, agentsFile, globalAgentsFile, installBundledSkills, skillVersion } from './lib/skills.js';
import { scanUpdates, scanDue, installArgs } from './lib/update-scan.js';
import { trackVersion, planCleanup, applyCleanup, formatBytes } from './lib/cleaner.js';
import { readMemoryState, saveMemory, saveMemoryFile, memoryVersion, restoreMemory } from './lib/memory.js';
import { McpManager } from './lib/mcp.js';
import { loadPlugins, pluginDirs } from './lib/plugins.js';
import { disposePluginHosts, retirePluginHosts } from './lib/plugin-host.js';
import { createSyncQueue } from './lib/sync-queue.js';
import {
  onArtifactWrite,
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
  saveBoardSection,
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
import { removeTree } from './lib/remove-tree.js';
import { emitLog, emitSpan, telemetryStatus, flushMetrics } from './lib/telemetry.js';
import * as infra from './lib/infra.js';
import * as repowise from './lib/repowise.js';
import { editDiagram, applyDiagram } from './lib/diagram-agent.js';
import { buildContext as calibrationContext, calibrate, renderMarkdown as calibrationMarkdown } from './lib/calibrator.js';
import { listChanges as openspecChanges } from './lib/openspec.js';
import { createWorkspace, listWorkspaces, sandboxRoot } from './lib/workspace.js';
import { authStatus, configureAuth, setLocalRole, loginKeycloak, logout, requireAdmin, sessionGateFor, ensureSession } from './lib/auth.js';
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
import { isCliInvocation, parseCliArgs, CLI_HELP, streamLine, resultObject } from './lib/cli.js';
import { isSelfCheck, selfCheckOut, runSelfCheck } from './lib/self-check.js';
import { applySystemCa } from './lib/system-ca.js';
import { runSignoff, testCommandFor } from './lib/signoff.js';
import { dataBoundaryReport } from './lib/data-boundary.js';
import { detectLocalModels, providerFromLocal } from './lib/local-models.js';
import { spawnShell, killTree as killProcessTree } from './lib/proc.js';
import { BUILTIN_COMMANDS, listCustomCommands, expandTemplate, searchFiles, resolveMentions, promptArgs, resolveResourceMentions } from './lib/commands.js';
import { buildExport, fileNameFor, chatToMarkdown, FORMATS } from './lib/export/index.js';
// Node внутри Electron не доверяет корпоративным корневым сертификатам Windows,
// и запросы к api-ai.mai.ru падают с «unable to get local issuer certificate».
// Системные корни подключаются прямо в процессе (ADR 0095): NODE_OPTIONS в
// собранном Electron игнорируется. Если API нет (старый Electron) — запасной путь:
// перезапуск с --use-system-ca, как раньше.
const SYSTEM_CA = applySystemCa();
const NEEDS_RELAUNCH = !SYSTEM_CA && !String(process.env.NODE_OPTIONS || '').includes('--use-system-ca') && !process.env.MAI_CODE_RELAUNCHED;
if (NEEDS_RELAUNCH) {
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
    // CLI (CC12.1) и самопроверка (F25): вывод и код выхода дочернего процесса — наши.
    ...(isCliInvocation(process.argv) || isSelfCheck(process.argv) ? { stdio: 'inherit' } : { detached: true, stdio: 'ignore' }),
  });
  if (isCliInvocation(process.argv) || isSelfCheck(process.argv)) child.on('exit', (code) => app.exit(code ?? 1));
  else {
    child.unref();
    app.exit(0);
  }
}

// Безголовый запуск (CC12.1, ADR 0077): `mai -p "задача"` — без окна и планировщика.
const CLI = isCliInvocation(process.argv) ? parseCliArgs(process.argv.slice(process.defaultApp ? 2 : 1), { cwd: process.env.MAI_CLI_CWD || process.cwd() }) : null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// OAuth удалённых MCP (ADR 0041): токены — в mcp-oauth.json, зашифрованы как ключи провайдеров.
const mcp = new McpManager({
  oauth: {
    store: createOAuthStore(path.join(dataDir(), 'mcp-oauth.json'), secretBox),
    openBrowser: (url) => shell.openExternal(url),
    get callbackPort() {
      return Number(loadSettings().oauth?.callbackPort) || undefined;
    },
  },
});
const runs = new Map(); // windowId -> { controller, approvals: Map }

/** Сколько ждём ответа на подтверждение, прежде чем отменить действие. */
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

let mainWindow = null;

// Матрица прав IPC (ADR 0028): роль проверяется до любого обработчика.
// Канал без записи в матрице считается admin-only.
guardIpc(ipcMain, requireAdmin, {
  onUnknown: (channel) => console.warn(`[ipc] канал ${channel} не внесён в матрицу прав — доступен только admin`),
  sessionGate: sessionGateFor,
});

// Продление сессии Keycloak (F21): раз в минуту истёкший access token
// обновляется по refresh_token; не вышло — сессия закрывается.
const sessionTimer = setInterval(() => ensureSession().catch(() => {}), 60_000);
sessionTimer.unref?.();

/**
 * MCP-серверы проекта лежат в <проект>/.mai-code/mcp.json и дополняют
 * глобальные настройки. Проектные записи имеют приоритет.
 */
function projectMcpConfig(projectDir, file = 'mcp.json') {
  if (!projectDir) return {};
  try {
    file = path.join(projectDir, '.mai-code', file);
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
  // Порядок: глобальные → пакеты → проект → локальные (последний сильнее, CC9.5).
  return Object.fromEntries(mcpSources(dir).map(({ name, config }) => [name, config]));
}

/** MCP-серверы с областью: global | package | project | local. Позднее сильнее. */
function mcpSources(projectDir) {
  const settings = loadSettings();
  const dir = projectDir || settings.projectDir;
  const trusted = isTrusted(dir);
  const layers = [
    ['global', settings.mcpServers || {}],
    ['package', packageMcpServers(packagesFor(dir))],
    ['project', trusted ? projectMcpConfig(dir) : {}],
    ['local', trusted ? projectMcpConfig(dir, 'mcp.local.json') : {}],
  ];
  const merged = new Map();
  for (const [scope, servers] of layers) {
    for (const [name, config] of Object.entries(servers || {})) {
      if (config && typeof config === 'object') merged.set(name, { name, scope, config });
    }
  }
  return [...merged.values()];
}

/** Управляемые настройки организации (ADR 0038): читаются при каждом решении — правка файла действует сразу. */
function managed() {
  return readManaged();
}

function managedHooks() {
  const org = managed();
  return org.hooks ? [{ source: 'managed', config: org.hooks }] : [];
}

/** Docker проверяется не чаще раза в минуту и только когда песочница команд включена (ADR 0040). */
let dockerCache = { at: 0, available: false };
function dockerReady() {
  if (Date.now() - dockerCache.at < 60_000) return dockerCache.available;
  dockerCache = { at: Date.now(), available: Boolean(sandbox.dockerStatus().available) };
  return dockerCache.available;
}

// Браузер агента (CW4.1, ADR 0069): одно окно на приложение, создаётся при первом открытии страницы.
let agentBrowser = null;
function browserFor(settings) {
  if (settings.browserEnabled === false) return null;
  if (!agentBrowser) agentBrowser = createAgentBrowser({ BrowserWindow });
  return agentBrowser;
}

/** Модель для «Плана» (CC13.5): своя, если задана и отличается от основной. */
function plannerFor(settings, activeKey) {
  const key = String(settings.planModel || '').trim();
  if (!key || key === activeKey) return null;
  try {
    const r = resolveModel(settings, key);
    return r.provider?.apiKey ? { provider: r.provider, model: r.modelId, label: key } : null;
  } catch {
    return null;
  }
}

function agentSettings(settings) {
  const shellSandbox = normalizeShellSandbox(settings.shellSandbox);
  return {
    ...settings,
    shellSandbox,
    // Docker нужен и для режима «только в Задаче», и для проектов с песочницей (CW1.3).
    dockerAvailable: dockerReady,
    // Корзина для delete_file (CW1.4).
    trashDir: path.join(dataDir(), 'trash'),
    // PDF для create_document (CW2.4, ADR 0067).
    renderPdf: (html) => renderPdf(BrowserWindow, html),
    renderPng: (html, options) => renderPng(BrowserWindow, html, options),
    previewDir: path.join(app.getPath('temp'), 'mai-previews'),
    browser: browserFor(settings),
    // Длинный вывод инструментов — в файл (CC1.13).
    outputDir: path.join(dataDir(), 'tool-output'),
  };
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
    backgroundColor: windowColors(nativeTheme.shouldUseDarkColors).background,
    ...titleBarOptions(process.platform, { dark: nativeTheme.shouldUseDarkColors }),
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

/** Тема (CC7.16, ADR 0074): CSS следует prefers-color-scheme, а его задаёт nativeTheme. */
function applyTheme(theme) {
  nativeTheme.themeSource = normalizeTheme(theme);
}
nativeTheme.on('updated', () => {
  const colors = windowColors(nativeTheme.shouldUseDarkColors);
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.setBackgroundColor(colors.background);
      if (process.platform !== 'darwin') win.setTitleBarOverlay?.({ color: colors.color, symbolColor: colors.symbolColor });
    } catch {
      /* окно без полосы заголовка (PDF, браузер агента) */
    }
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: windowColors(nativeTheme.shouldUseDarkColors).background,
    ...titleBarOptions(process.platform, { dark: nativeTheme.shouldUseDarkColors }),
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
    // Окно браузера агента не держит приложение открытым.
    agentBrowser?.close();
    runs.delete(mainWindow?.id);
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Самопроверка установленного приложения (F25, ADR 0095): без окна, отчёт JSON.
  if (isSelfCheck(process.argv)) {
    if (NEEDS_RELAUNCH) return;
    const report = await runSelfCheck({ appPath: app.getAppPath(), userData: app.getPath('userData'), version: app.getVersion(), safeStorage, systemCa: SYSTEM_CA }).catch((err) => ({ ok: false, error: err?.message || String(err), checks: [] }));
    const out = selfCheckOut(process.argv);
    const text = JSON.stringify(report, null, 2);
    if (out) {
      try {
        fs.writeFileSync(out, text, 'utf8');
      } catch (err) {
        console.error(`[self-check] не записан ${out}: ${err?.message || err}`);
      }
    }
    console.log(text);
    app.exit(report.ok ? 0 : 1);
    return;
  }
  if (CLI) {
    // Перезапуск с --use-system-ca ещё идёт — ответит дочерний процесс.
    if (NEEDS_RELAUNCH) return;
    app.exit(await runCli(CLI));
    return;
  }
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
  applyTheme(loadSettings().theme);
  createWindow();
  // Сканер обновлений (N6): раз в сутки, в фоне, через полторы минуты после старта.
  scheduleUpdateScan();
  // Чистильщик (N7): отсчёт стабильной работы версии — с её первого запуска.
  versionHistory();
  const settings = loadSettings();
  emitLog('MAI Code запущен', { attributes: { platform: process.platform, version: app.getVersion() } });
  mcp.sync(mcpConfigs(settings.projectDir)).catch(() => {});
  // Прогоны, прерванные закрытием приложения (CW5.2), — отметить, чтобы их можно было продолжить.
  try {
    const interrupted = markInterrupted();
    if (interrupted.length) emitLog(`Прерванных прогонов: ${interrupted.length}`);
  } catch (err) {
    console.error('[sessions] не удалось отметить прерванные прогоны:', err?.message || err);
  }
  // Срок хранения чатов (CC6.9): старше N дней без изменений — удалить.
  try {
    const expired = expiredSessions(settings.sessionRetentionDays);
    for (const id of expired) removeSessionFully(id);
    if (expired.length) emitLog(`Удалено старых чатов: ${expired.length}`);
  } catch (err) {
    console.error('[sessions] не удалось очистить старые чаты:', err?.message || err);
  }
  startScheduler();
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
  // Фоновые команды агента (CC1.4) не переживают приложение.
  disposeBackground();
  // Фоновые субагенты (CC8.6) — тоже.
  for (const tasks of backgroundAgents.values()) for (const t of tasks.values()) t.abort?.();
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

// Голосовой ввод (F18, ADR 0092): движок — MAS или провайдер (audio/transcriptions).
ipcMain.handle('voice:status', async () => {
  const settings = loadSettings();
  const config = voiceConfig(settings);
  if (config.engine === 'provider') return providerVoiceStatus(config, (key) => resolveModel(settings, key));
  return { ...(await masStatus()), engine: 'mas' };
});
ipcMain.handle('voice:transcribe', async (_e, payload) => {
  const wav = payload?.wav;
  if (!wav || !wav.byteLength) throw new Error('Пустая запись');
  const settings = loadSettings();
  const config = voiceConfig(settings);
  if (config.engine === 'provider') return providerTranscribe({ wav, config, resolve: (key) => resolveModel(settings, key) });
  return { ...(await masTranscribe({ wav: Buffer.from(wav) })), engine: 'mas' };
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
  // Настройки, которые расширяют права агента или меняют изоляцию, — только admin.
  if (patch.projectDir || patch.providers || patch.infra || patch.repowise || patch.runtimes || patch.auth || patch.guardrails || patch.telemetry || patch.marketplaces || patch.webSearch || 'protectedBranches' in (patch || {})) {
    requireAdmin();
  }
  const current = loadSettings();
  if ('allowOutsideProject' in (patch || {}) && Boolean(patch.allowOutsideProject) !== Boolean(current.allowOutsideProject)) requireAdmin();
  // Ослабить фильтр секретов (N3) — только admin.
  if ('secretFilter' in (patch || {}) && String(patch.secretFilter || 'mask') !== String(current.secretFilter || 'mask')) requireAdmin();
  // Оболочка команд агента (F26) меняет, как исполняются команды, — только admin.
  if ('shell' in (patch || {}) && String(patch.shell || 'auto') !== String(current.shell || 'auto')) requireAdmin();
  // Webhook уведомлений (CW5.4) отправляет данные наружу — только admin.
  if (patch?.notifications && patch.notifications.webhookUrl !== undefined && patch.notifications.webhookUrl !== '***' && String(patch.notifications.webhookUrl || '') !== String(current.notifications?.webhookUrl || '')) requireAdmin();
  // Каналы мессенджеров (CW5.4) отправляют данные наружу: любое изменение, кроме маски «***», — только admin.
  if (Array.isArray(patch?.notifications?.channels)) {
    const strip = (list) => JSON.stringify((list || []).map(({ token: _t, url: _u, ...rest }) => rest));
    const secretsChanged = patch.notifications.channels.some((c) => (c.token && c.token !== '***') || (c.url && c.url !== '***'));
    if (secretsChanged || strip(patch.notifications.channels) !== strip(current.notifications?.channels)) requireAdmin();
  }
  // Сайты без вопросов для браузера агента (CW4.2) расширяют права — только admin.
  if (patch?.browserSites && JSON.stringify(patch.browserSites.allow || []) !== JSON.stringify(current.browserSites?.allow || [])) requireAdmin();
  if (patch?.shellSandbox && JSON.stringify(normalizeShellSandbox({ ...current.shellSandbox, ...patch.shellSandbox })) !== JSON.stringify(normalizeShellSandbox(current.shellSandbox))) {
    requireAdmin();
  }
  const clean = { ...patch };
  delete clean.apiKey;
  delete clean.baseURL;
  delete clean.model;
  const next = saveSettings(clean);
  if ('theme' in (patch || {})) applyTheme(next.theme);
  if (patch.mcpServers) await mcp.sync(mcpConfigs(next.projectDir));
  return publicSettings();
});

// ---------- роли и доступ ----------

ipcMain.handle('auth:status', () => ensureSession().catch(() => authStatus()));

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

// Локальные модели (N4, ADR 0100): найти сервер на этой машине и добавить в один клик.
ipcMain.handle('localModels:detect', () => detectLocalModels({ providers: loadSettings().providers }));
ipcMain.handle('localModels:add', async (_e, payload = {}) => {
  requireAdmin();
  const found = (await detectLocalModels({ providers: loadSettings().providers })).find((f) => f.id === payload.id);
  if (!found) return { ok: false, error: 'Сервер больше не отвечает — запустите его и нажмите «Найти» ещё раз' };
  if (!found.models.length) return { ok: false, error: `${found.name} запущен, но моделей нет — загрузите модель` };
  const settings = loadSettings();
  const { id, provider } = providerFromLocal(found, settings.providers);
  const patch = { providers: { ...settings.providers, [id]: provider } };
  // Первая модель — активной, только если об этом попросили.
  if (payload.activate) patch.activeModel = `${id}/${provider.models[0].id}`;
  saveSettings(patch);
  return { ok: true, id, models: provider.models.length, activeModel: patch.activeModel || '', providers: publicSettings().providers };
});

// ---------- рантаймы ----------

ipcMain.handle('runtimes:list', () => loadSettings().runtimes || {});

ipcMain.handle('runtimes:save', (_e, runtimes) => {
  requireAdmin();
  saveSettings({ runtimes });
  return loadSettings().runtimes;
});

// Экспорт и импорт рантаймов (F7, ADR 0085): файл JSON, без значений env.
ipcMain.handle('runtimes:export', async (event) => {
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Сохранить рантаймы',
    defaultPath: 'mai-runtimes.json',
    filters: [{ name: 'Рантаймы MAI', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const data = exportRuntimes(loadSettings().runtimes || {});
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, path: filePath, count: Object.keys(data.runtimes).length };
});

ipcMain.handle('runtimes:import', async (event, payload = {}) => {
  requireAdmin();
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Открыть рантаймы',
    properties: ['openFile'],
    filters: [{ name: 'Рантаймы MAI', extensions: ['json'] }],
  });
  if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
  try {
    if (fs.statSync(filePaths[0]).size > 2 * 1024 * 1024) throw new Error('файл больше 2 МБ');
    const result = importRuntimes(JSON.parse(fs.readFileSync(filePaths[0], 'utf8')), loadSettings().runtimes || {}, { replace: payload.replace === true });
    if (result.added.length || result.replaced.length) saveSettings({ runtimes: result.runtimes });
    audit({ at: new Date().toISOString(), tool: 'runtimes:import', source: 'user', cls: 'exec', subject: `+${result.added.join(',')} ~${result.replaced.join(',')}`.slice(0, 300), decision: 'allow' });
    const { runtimes: _r, ...report } = result;
    return { ok: true, ...report };
  } catch (err) {
    return { ok: false, error: `Не удалось импортировать: ${err?.message || err}` };
  }
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
  // Просто папка — без проекта Cowork (ADR 0065).
  saveSettings({ projectDir: result.filePaths[0], activeProject: null });
  return result.filePaths[0];
});

// ---------- рабочие копии для чатов (CC11.5, ADR 0076) ----------

const worktreesDir = () => path.join(dataDir(), 'worktrees');

ipcMain.handle('worktree:list', (_e, projectDir) => {
  const repo = repoRoot(String(projectDir || loadSettings().projectDir || ''));
  if (!repo) return { ok: false, error: 'Папка проекта — не git-репозиторий с коммитами' };
  const ours = realPath(worktreesDir());
  return { ok: true, repo, items: listWorktrees(repo).map((w) => ({ ...w, ours: w.dir.startsWith(ours) })) };
});

/** Новая копия на ветке `mai/wt-<имя>` и переход в неё: новый чат работает там. */
ipcMain.handle('worktree:create', (_e, payload = {}) => {
  const source = String(payload.projectDir || loadSettings().projectDir || '');
  const repo = repoRoot(source);
  if (!repo) return { ok: false, error: 'Папка проекта — не git-репозиторий с коммитами' };
  const id = worktreeId(payload.name) || `wt-${crypto.randomBytes(3).toString('hex')}`;
  try {
    const wt = createWorktree({ repo, baseDir: path.join(worktreesDir(), path.basename(repo)), id, branchPrefix: 'mai/wt-' });
    // Копия доверенного репозитория — того же доверия: код в ней тот же.
    if (isTrusted(repo)) setTrust(dataDir(), wt.dir, 'trusted');
    const dir = path.join(wt.dir, path.relative(repo, realPath(source)));
    retirePluginHosts();
    saveSettings({ projectDir: dir, activeProject: null });
    audit({ at: new Date().toISOString(), tool: 'worktree:create', source: 'user', cls: 'write', subject: `${wt.branch} ← ${repo}`, decision: 'allow' });
    return { ok: true, dir, branch: wt.branch, repo };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('worktree:open', (_e, dir) => {
  const target = realPath(String(dir || ''));
  if (!fs.existsSync(target)) return { ok: false, error: 'Папки нет' };
  retirePluginHosts();
  saveSettings({ projectDir: target, activeProject: null });
  return { ok: true, dir: target };
});

/** Убрать копию: несохранённое коммитится в её ветку, ветка остаётся. Основную папку — нельзя. */
ipcMain.handle('worktree:remove', (_e, payload = {}) => {
  const repo = repoRoot(String(payload.repo || ''));
  const dir = realPath(String(payload.dir || ''));
  const item = repo ? listWorktrees(repo).find((w) => w.dir === dir) : null;
  if (!item || item.main) return { ok: false, error: 'Это не рабочая копия этого репозитория' };
  try {
    removeWorktree({ repo, dir, branch: item.branch }, { keepBranch: true });
    removeTrust(dataDir(), dir);
    if (realPath(loadSettings().projectDir || '') === dir) saveSettings({ projectDir: repo, activeProject: null });
    return { ok: true, branch: item.branch };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
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
  const customNames = new Set(custom.map((c) => c.name.toLowerCase()));
  // /commit и /review можно заменить своей командой (ADR 0059).
  const builtins = BUILTIN_COMMANDS.filter((c) => !(c.overridable && customNames.has(c.name)));
  // Промпты MCP-серверов (CC9.4, ADR 0071): /mcp__сервер__промпт.
  const prompts = mcp.listPrompts().map((p) => ({
    name: p.command,
    description: p.description || `промпт ${p.name} сервера ${p.server}`,
    argumentHint: p.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' '),
    source: 'mcp',
  }));
  return [...builtins.map((c) => ({ ...c, source: 'builtin' })), ...custom, ...skills, ...prompts];
});

/** Своя команда или навык → текст запроса агенту. */
ipcMain.handle('commands:expand', async (_e, payload = {}) => {
  const dir = payload.projectDir || loadSettings().projectDir;
  const name = String(payload.name || '').toLowerCase();
  // Промпт MCP (CC9.4): сервер собирает текст запроса из аргументов.
  const prompt = mcp.listPrompts().find((p) => p.command.toLowerCase() === name);
  if (prompt) {
    try {
      return { ok: true, source: 'mcp', prompt: await mcp.getPrompt(prompt.command, promptArgs(prompt.arguments, payload.args)) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
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

/** Ресурсы MCP для подсказки `@сервер:uri` (CC9.3). */
ipcMain.handle('mcp:resources', () => mcp.listResources().map(({ server, uri, name, description, mimeType }) => ({ server, uri, name, description, mimeType })));

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
    removeTree(full);
    fs.rmSync(`${full}.txt`, { force: true });
    fs.rmSync(`${full}.index.txt`, { force: true });
    removeTree(`${full}.extracted`);
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
/** Удаление чата вместе с вложениями и чекпоинтами. */
function removeSessionFully(id) {
  const session = getSession(id);
  if (session?.projectDir) removeSessionUploads(session.projectDir, id);
  removeCheckpoints(dataDir(), id);
  return deleteSession(id);
}
ipcMain.handle('sessions:delete', (_e, id) => removeSessionFully(id));

// Переименование и форк (CC6.8, CC6.5, ADR 0073).
ipcMain.handle('sessions:rename', (_e, payload = {}) => {
  const session = renameSession(payload.id, payload.title);
  return session ? { ok: true, title: session.title } : { ok: false, error: 'Нет такого чата или пустое имя' };
});
ipcMain.handle('sessions:fork', (_e, payload = {}) => {
  const session = forkSession(payload.id, { upTo: Number.isInteger(payload.upTo) ? payload.upTo : null });
  return session ? { ok: true, id: session.id, title: session.title } : { ok: false, error: 'Нет такого чата' };
});

// Ветка git для статусной строки (CC7.12).
ipcMain.handle('git:branch', (_e, projectDir) => {
  try {
    return currentBranch(String(projectDir || loadSettings().projectDir || '')) || '';
  } catch {
    return '';
  }
});

// `!команда` (CC7.10, ADR 0074): пользователь сам запускает команду в папке проекта,
// без модели; вывод — в историю чата, агент увидит его следующим ходом.
// Guardrails действуют и здесь. Только admin: это выполнение на машине.
ipcMain.handle('shell:direct', async (event, payload = {}) => {
  const command = String(payload.command || '').trim();
  const session = getSession(payload.sessionId);
  if (!command) return { ok: false, error: 'Пустая команда' };
  if (!session) return { ok: false, error: 'Нет такого чата' };
  const projectDir = session.projectDir || loadSettings().projectDir;
  if (!projectDir || !fs.existsSync(projectDir)) return { ok: false, error: 'Сначала выберите папку проекта' };
  const guard = checkCommand(command, { guardrails: loadSettings().guardrails });
  if (!guard.allowed) return { ok: false, error: `Guardrails заблокировали команду: ${guard.reason}` };
  const output = await executeShell(command, projectDir, {});
  audit({ at: new Date().toISOString(), tool: 'shell:direct', source: 'user', cls: 'exec', subject: command.slice(0, 300), decision: 'allow' });
  const fresh = getSession(session.id);
  fresh.messages.push({
    role: 'user',
    content: `Я сам выполнил команду в папке проекта (без тебя), вот вывод — учти его:\n\n${output}`,
    display: `!${command}\n\n${output.length > 4000 ? `${output.slice(0, 4000)}\n…` : output}`,
    direct: true,
  });
  if (!fresh.title || fresh.title === 'Новый чат') fresh.title = `!${command}`.slice(0, 60);
  saveSession(fresh);
  return { ok: true, output };
});

// Экспорт и импорт чата файлом (CC6.9): JSON с историей, без чекпоинтов и вложений.
ipcMain.handle('sessions:exportFile', async (event, id) => {
  const session = getSession(id);
  if (!session) return { ok: false, error: 'Нет такого чата' };
  const safe = String(session.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Сохранить чат',
    defaultPath: `${safe}.mai-chat.json`,
    filters: [{ name: 'Чат MAI', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const { run: _run, permissionRules: _rules, ...rest } = session;
  fs.writeFileSync(filePath, JSON.stringify({ format: 'mai-chat', version: 1, exportedAt: new Date().toISOString(), session: rest }, null, 2), 'utf8');
  return { ok: true, path: filePath };
});
ipcMain.handle('sessions:importFile', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Открыть чат',
    properties: ['openFile'],
    filters: [{ name: 'Чат MAI', extensions: ['json'] }],
  });
  if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
  try {
    if (fs.statSync(filePaths[0]).size > 50 * 1024 * 1024) throw new Error('Файл больше 50 МБ');
    const session = importSession(JSON.parse(fs.readFileSync(filePaths[0], 'utf8')));
    return { ok: true, id: session.id, title: session.title };
  } catch (err) {
    return { ok: false, error: `Не удалось импортировать: ${err?.message || err}` };
  }
});

// ---------- чат ----------

/* ---------- уведомления (CW5.4, ADR 0081) ---------- */

// Рабочий стол — когда окно не в фокусе; webhook — по настройке. Клик открывает чат.
const notify = createNotifier({
  Notification,
  getSettings: loadSettings,
  isFocused: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
  onClick: ({ sessionId }) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : anyWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (sessionId) send(win, { type: 'scheduled:open', sessionId });
  },
  log: (text) => logError({ source: 'notify', message: text }),
});

/** Короткое имя чата для уведомления. */
const chatTitle = (sessionId) => {
  try {
    return getSession(sessionId)?.title || 'чат';
  } catch {
    return 'чат';
  }
};

/** Проверка уведомлений из настроек: на рабочем столе — даже при окне в фокусе. */
ipcMain.handle('notify:test', async (_e, channelId) => {
  const errors = [];
  const test = createNotifier({ Notification, getSettings: loadSettings, isFocused: () => false, log: (t) => errors.push(t) });
  const r = await test('done', { title: 'Проверка уведомлений MAI Code', body: 'Так будет выглядеть уведомление, когда агент закончит работу.' }, { channelId: channelId ? String(channelId) : '', force: true });
  for (const e of errors) logError({ source: 'notify', message: e });
  return { ok: true, ...r, errors };
});

/* ---------- фоновые субагенты (CC8.6, ADR 0075) ---------- */

// sessionId → Map(id → задача). Живут дольше прогона родителя, до выхода из приложения.
const backgroundAgents = new Map();

function backgroundFor(window, sessionId) {
  if (!backgroundAgents.has(sessionId)) backgroundAgents.set(sessionId, new Map());
  const tasks = backgroundAgents.get(sessionId);
  const view = (t) => ({ id: t.id, type: t.type, description: t.description, status: t.status, result: t.result || '' });
  return {
    start({ type, description, run, abort }) {
      const id = `bg-${crypto.randomBytes(3).toString('hex')}`;
      const task = { id, type, description, status: 'работает', result: '', abort, startedAt: new Date().toISOString() };
      tasks.set(id, task);
      send(window, { type: 'agent:background', sessionId, task: view(task) });
      Promise.resolve()
        .then(run)
        .then(
          (result) => {
            task.status = 'готово';
            task.result = String(result || '').slice(0, 20000);
          },
          (err) => {
            task.status = 'ошибка';
            task.result = err?.message || String(err);
          },
        )
        .finally(() => {
          task.abort = null;
          // Итог — в историю чата: агент увидит его следующим ходом, пользователь — в ленте.
          try {
            const session = getSession(sessionId);
            if (session) {
              session.messages.push({
                role: 'user',
                content: `[Фоновый субагент ${task.type} «${task.description}» (${task.id}) завершил работу: ${task.status}]\n\n${task.result}`,
                display: `⟳ Фоновый субагент «${task.description}»: ${task.status}`,
                background: task.id,
              });
              saveSession(session);
            }
          } catch {
            /* чат удалён */
          }
          send(window, { type: 'agent:background', sessionId, task: view(task), done: true });
          notify('background', { title: `Субагент «${task.description}»: ${task.status}`, body: task.result.slice(0, 180), sessionId }).catch(() => {});
        });
      return view(task);
    },
    get: (id) => (tasks.has(id) ? view(tasks.get(id)) : null),
    list: () => [...tasks.values()].map(view),
  };
}

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
          // Ревизор сам читает изменённые файлы (F5, ADR 0064); false — проверяет только текст ответа.
          verify: settings.reviewer.verify !== false,
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
      // Вид чата из переключателя «Код / Задача» (CW1.1) — до первого сообщения.
      kind: payload.kind === 'task' ? 'task' : loadSettings().defaultKind === 'task' ? 'task' : 'code',
    });
  }
  session.model = model;
  session.projectDir = projectDir;
  // Проект Cowork (CW1.5): чат помнит проект, если папка — его основная.
  const project = activeProjectFor(projectDir);
  if (project && !session.projectId) session.projectId = project.id;
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
  // Ресурсы MCP `@сервер:uri` (CC9.3): содержимое — в запрос, в рамке данных.
  const resources = payload.text ? resolveResourceMentions(payload.text, mcp.listResources()).slice(0, 5) : [];
  // В чате показываем запрос как написан, без содержимого ресурсов.
  if (resources.length && !payload.displayText) payload.displayText = payload.text;
  for (const res of resources) {
    let body;
    try {
      body = await mcp.readResource(res.server, res.uri);
    } catch (err) {
      body = `(не прочитан: ${err?.message || err})`;
    }
    payload.text = `${payload.text}\n\n[Ресурс MCP ${res.server}:${res.uri}]\n${wrapData(`mcp:${res.server}`, body)}`;
  }
  // Пути изображений из вложений: в сессии храним путь, base64 собирается на запрос (F1).
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .map((p) => String(p || ''))
    .map((p) => (adopted ? p.split(adopted.from).join(adopted.to) : p))
    .filter((p) => isImageFile(p))
    .slice(0, 20);
  // Начало этого прогона в истории — для «Запомнить?» (F4).
  let runStart = session.messages.length;
  if (payload.text) {
    const display = payload.displayText || payload.text;
    session.messages.push({ role: 'user', content: payload.text, display, ...(images.length ? { images } : {}) });
    runStart = session.messages.length - 1;
    if (!session.title || session.title === 'Новый чат') {
      session.title = display.trim().slice(0, 60) || 'Новый чат';
    }
  }
  saveSession(session);
  // Прогон идёт (CW5.2): если приложение закроют посреди работы, чат это покажет.
  setSessionRun(session.id, { status: 'running', startedAt: new Date().toISOString() });
  let runStatus = 'done';

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
        settings: agentSettings(settings),
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
        // Трассировка прогона в OTLP (F22, ADR 0063), если телеметрия включена.
        tracer: agentTracer(),
        // Запасная модель при сбое основной (ADR 0057).
        fallback: fallbackFor(settings, activeKey),
        // Модель для «Плана» (CC13.5, ADR 0078).
        planner: plannerFor(settings, activeKey),
        // Глубина рассуждений из поля ввода (CC7.11).
        effort: ['low', 'medium', 'high'].includes(payload.effort) ? payload.effort : '',
        // Чекпоинты правок для отката (CC6.1).
        checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
        hooks,
        // Типы субагентов: встроенные и свои (проекта — только доверенная папка, ADR 0036).
        agentDefs: listAgentDefs(projectDir, dataDir(), { includeProject: trusted, extraDirs: packageDirs(packagesFor(projectDir), 'agents') }),
        skillDirs: packageDirs(packagesFor(projectDir), 'skills'),
        extraDirs: [...new Set([...(project?.extraDirs || []), ...(getSession(session.id)?.extraDirs || [])])].filter((d) => fs.existsSync(d)),
        kind: getSession(session.id)?.kind || 'code',
        project,
        background: backgroundFor(window, session.id),
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
      {
        const answer = [...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
        notify('done', { title: `Готово: ${chatTitle(session.id)}`, body: String(answer).slice(0, 200), sessionId: session.id }).catch(() => {});
      }
      // «Запомнить?» (F4): прогон с правками — модель предлагает урок для памяти проекта.
      {
        const fresh = history.slice(runStart);
        const edits = fresh.filter((m) => m.role === 'assistant' && m.tool_calls?.length).flatMap((m) => m.tool_calls).filter((c) => ['write', 'delete'].includes(classifyTool(c.function?.name)));
        if (settings.suggestMemory !== false && edits.length && trusted) {
          const actions = fresh
            .filter((m) => m.role === 'assistant' && m.tool_calls?.length)
            .flatMap((m) => m.tool_calls.map((c) => `${c.function?.name} ${String(c.function?.arguments || '').slice(0, 160)}`))
            .join('\n');
          const answer = [...fresh].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
          suggestLesson({ provider: resolved.provider, model: resolved.modelId, request: payload.displayText || payload.text, actions, answer })
            .then((text) => {
              if (text) send(window, { type: 'memory:suggest', sessionId: session.id, text });
            })
            .catch(() => {});
        }
      }
      // Автозаголовок (CC6.8): после первого ответа, если чат не назван вручную.
      const users = history.filter((m) => m.role === 'user');
      if (settings.autoTitle !== false && users.length === 1 && !getSession(session.id)?.titleManual) {
        const answer = [...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
        suggestTitle({ provider: resolved.provider, model: resolved.modelId, request: users[0].display || users[0].content, answer })
          .then((title) => {
            const renamed = title ? renameSession(session.id, title, { auto: true }) : null;
            if (renamed && !renamed.titleManual) send(window, { type: 'title', sessionId: session.id, title: renamed.title });
          })
          .catch(() => {});
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      runStatus = aborted ? 'stopped' : 'error';
      const message = aborted ? 'Остановлено пользователем' : err?.message || String(err);
      if (!aborted) logError({ source: 'agent', model, message, cause: err?.cause?.message || '' });
      if (!aborted) notify('error', { title: `Ошибка: ${chatTitle(session.id)}`, body: message, sessionId: session.id }).catch(() => {});
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
      setSessionRun(session.id, { status: runStatus, endedAt: new Date().toISOString() });
      lock.release();
    }
  })();

  return { ok: true, sessionId: session.id, title: session.title };
});

/* ---------- плановые задачи (CW5.1, ADR 0050) ---------- */

let scheduleStoreInstance = null;
const scheduleStore = () => (scheduleStoreInstance ||= createScheduleStore(dataDir()));
const scheduledRunning = new Set();

/** Трассировщик прогона (F22): спаны agent.run/step/tool в OTLP; телеметрия выключена — пустой. */
function agentTracer() {
  return telemetryStatus().enabled ? createTracer(emitSpan) : NO_TRACER;
}

/** Запасная модель (ADR 0057): settings.fallbackModel = «провайдер/модель», с ключом и не та же, что основная. */
function fallbackFor(settings, primaryKey) {
  const key = String(settings.fallbackModel || '').trim();
  if (!key || key === primaryKey) return null;
  try {
    const resolved = resolveModel(settings, key);
    if (!resolved.provider?.apiKey || !resolved.provider?.baseURL) return null;
    return { provider: resolved.provider, model: resolved.modelId, label: key };
  } catch {
    return null;
  }
}

function anyWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
}

/**
 * Запуск плановой задачи без окна: новый чат «⏰ …», режим «Только
 * разрешённое» (вопросов задать некому), результат — уведомление и журнал.
 */
async function runScheduled(task, { reason = 'schedule' } = {}) {
  const store = scheduleStore();
  if (scheduledRunning.has(task.id)) return { ok: false, error: 'Задача уже выполняется' };
  const settings = loadSettings();
  const projectDir = task.projectDir || settings.projectDir;
  const finish = (status, extra = {}) => {
    store.markRun(task.id, { lastRun: new Date().toISOString(), lastStatus: status, ...(extra.sessionId ? { lastSessionId: extra.sessionId } : {}) });
    store.log({ taskId: task.id, title: task.title, reason, status, ...extra });
    return { ok: status === 'ok', status, ...extra };
  };
  if (!projectDir || !fs.existsSync(projectDir)) return finish('error', { error: 'папка задачи не найдена' });
  if (!isTrusted(projectDir)) return finish('error', { error: 'папка не доверена — плановая задача не запускается' });
  let resolved;
  try {
    resolved = resolveModel(settings, task.model || settings.activeModel);
    if (!resolved.provider.apiKey) throw new Error(`не задан ключ провайдера «${resolved.provider.name}»`);
  } catch (err) {
    return finish('error', { error: err.message });
  }
  const lock = acquireProject(projectDir, { label: `плановая задача «${task.title}»` });
  if (!lock.ok) {
    store.log({ taskId: task.id, title: task.title, reason, status: 'busy', error: lock.error });
    return { ok: false, busy: true, error: lock.error };
  }
  scheduledRunning.add(task.id);
  const stamp = new Date().toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  const session = createSession({ title: `⏰ ${task.title} — ${stamp}`, model: task.model || settings.activeModel, projectDir, permissionMode: 'dontAsk', kind: task.kind });
  session.messages.push({ role: 'user', content: task.prompt, display: task.prompt });
  session.scheduledTaskId = task.id;
  saveSession(session);
  setSessionRun(session.id, { status: 'running', startedAt: new Date().toISOString(), scheduled: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);
  try {
    const plugins = await loadPluginsFor(projectDir);
    const history = await runAgent({
      settings: agentSettings(settings),
      provider: resolved.provider,
      projectDir,
      model: resolved.modelId,
      messages: session.messages,
      signal: controller.signal,
      mcp,
      pluginTools: plugins.tools,
      transforms: plugins.transforms,
      reviewer: null,
      permissionMode: 'dontAsk',
      policy: { ...policyFor(session.id, projectDir), getMode: () => 'dontAsk' },
      audit,
      trusted: true,
      contextWindow: modelContext(resolved.providerId, resolved.modelId, resolved.provider) || DEFAULT_CONTEXT,
      // Трассировка прогона в OTLP (F22, ADR 0063), если телеметрия включена.
      tracer: agentTracer(),
      // Запасная модель при сбое основной (ADR 0057).
      fallback: fallbackFor(settings, task.model || settings.activeModel),
      checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
      hooks: hookRunnerFor(null, { projectDir, sessionId: session.id, trusted: true }),
      agentDefs: listAgentDefs(projectDir, dataDir(), { includeProject: true, extraDirs: packageDirs(packagesFor(projectDir), 'agents') }),
      skillDirs: packageDirs(packagesFor(projectDir), 'skills'),
      kind: task.kind,
      onHistory: (h) => {
        session.messages = h;
        saveSession(session);
      },
      emit: () => {},
      approve: async () => ({ allow: false, message: 'Плановая задача: спросить некого' }),
      ask: null,
    });
    session.messages = history;
    saveSession(session);
    if (controller.signal.aborted) throw new Error('превышено время выполнения (30 мин)');
    const answer = [...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
    notifyScheduled(task, answer.slice(0, 200) || 'готово', session.id);
    setSessionRun(session.id, { status: 'done', endedAt: new Date().toISOString(), scheduled: true });
    return finish('ok', { sessionId: session.id, summary: answer.slice(0, 500) });
  } catch (err) {
    saveSession(session);
    setSessionRun(session.id, { status: 'error', endedAt: new Date().toISOString(), scheduled: true });
    notifyScheduled(task, `Ошибка: ${err?.message || err}`, session.id);
    return finish('error', { sessionId: session.id, error: err?.message || String(err) });
  } finally {
    clearTimeout(timeout);
    scheduledRunning.delete(task.id);
    lock.release();
    send(anyWindow(), { type: 'scheduled:run', taskId: task.id });
  }
}

/* ---------- безголовый запуск (CC12.1, CC12.2, ADR 0077) ---------- */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/** Прогон агента без окна: те же runAgent, политика, хуки и сессии, что у чата. */
async function runCli(opts) {
  const out = (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  const err = (text) => process.stderr.write(`${text}\n`);
  if (opts.help) {
    out(CLI_HELP);
    return 0;
  }
  if (opts.error) {
    err(`mai: ${opts.error}\n\n${CLI_HELP}`);
    return 2;
  }
  const started = Date.now();
  // stdin: лаунчер `mai` кладёт его в файл (Electron на Windows stdin не читает).
  const fromFile = process.env.MAI_CLI_PROMPT_FILE && fs.existsSync(process.env.MAI_CLI_PROMPT_FILE) ? fs.readFileSync(process.env.MAI_CLI_PROMPT_FILE, 'utf8') : null;
  const prompt = opts.fromStdin ? (fromFile ?? (await readStdin())).trim() : opts.prompt;
  if (!prompt) {
    err('mai: пустая задача');
    return 2;
  }
  const settings = loadSettings();
  const projectDir = path.resolve(opts.cwd);
  const finish = (data) => {
    const result = resultObject({ ...data, durationMs: Date.now() - started, mode: opts.mode });
    if (opts.output === 'text') {
      if (result.ok) out(result.result || '');
      else err(`mai: ${result.error}`);
    } else out(JSON.stringify(result));
    return result.ok ? 0 : 1;
  };
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return finish({ ok: false, error: `нет папки ${projectDir}` });
  let resolved;
  try {
    resolved = resolveModel(settings, opts.model || settings.activeModel);
    if (!resolved.provider.apiKey) throw new Error(`не задан ключ провайдера «${resolved.provider.name}»`);
  } catch (e) {
    return finish({ ok: false, error: e.message });
  }
  const trusted = isTrusted(projectDir);
  if (!trusted) err(`mai: папка не доверена — плагины, MCP и инструкции проекта не загружаются (доверить — в приложении)`);
  // «Без вопросов» — только там, где он разрешён и в окне (ADR 0028, 0038).
  let mode = opts.mode;
  if (mode === 'bypass' && bypassBlocked(projectDir)) {
    err('mai: «Без вопросов» недоступен для этой папки — работаю «только по правилам» (dontAsk)');
    mode = 'dontAsk';
  }
  // Спросить некого: «Вручную» и «Правки» без вопросов превращаются в отказ.
  const lock = acquireProject(projectDir, { label: 'mai CLI' });
  if (!lock.ok) return finish({ ok: false, error: lock.error });
  const session = createSession({ title: `CLI: ${prompt.replace(/\s+/g, ' ').slice(0, 50)}`, model: opts.model || settings.activeModel, projectDir, permissionMode: mode, kind: opts.kind });
  if (opts.allow.length) addSessionRules(session.id, 'allow', opts.allow.filter((r) => parseRule(r)));
  session.messages.push({ role: 'user', content: prompt, display: prompt });
  saveSession(session);
  setSessionRun(session.id, { status: 'running', startedAt: new Date().toISOString(), cli: true });
  const denied = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const plugins = trusted ? await loadPluginsFor(projectDir) : { tools: [], transforms: [] };
    if (trusted) await mcp.sync(mcpConfigs(projectDir)).catch(() => {});
    const history = await runAgent({
      settings: { ...agentSettings(settings), ...(opts.maxTurns ? { maxIterations: opts.maxTurns } : {}), browser: null },
      provider: resolved.provider,
      projectDir,
      model: resolved.modelId,
      messages: session.messages,
      signal: controller.signal,
      mcp,
      pluginTools: plugins.tools,
      transforms: plugins.transforms,
      reviewer: null,
      permissionMode: mode,
      policy: { ...policyFor(session.id, projectDir), getMode: () => mode },
      audit,
      trusted,
      contextWindow: modelContext(resolved.providerId, resolved.modelId, resolved.provider) || DEFAULT_CONTEXT,
      tracer: agentTracer(),
      fallback: fallbackFor(settings, opts.model || settings.activeModel),
      checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
      hooks: hookRunnerFor(null, { projectDir, sessionId: session.id, trusted }),
      agentDefs: listAgentDefs(projectDir, dataDir(), { includeProject: trusted, extraDirs: packageDirs(packagesFor(projectDir), 'agents') }),
      skillDirs: packageDirs(packagesFor(projectDir), 'skills'),
      kind: opts.kind,
      onHistory: (h) => {
        session.messages = h;
        saveSession(session);
      },
      // stream-json (CC12.2): те же события, что получает окно.
      emit: (event) => {
        if (opts.output === 'stream-json') out(streamLine({ ...event, session_id: session.id }));
      },
      approve: async (request) => {
        denied.push({ tool: request?.tool || '', summary: String(request?.summary || '').slice(0, 300) });
        return { allow: false, message: 'CLI: спросить некого — разрешите правилом --allow или выберите режим' };
      },
      ask: null,
    });
    session.messages = history;
    saveSession(session);
    if (controller.signal.aborted) throw new Error('остановлено');
    const answer = [...history].reverse().find((m) => m.role === 'assistant' && m.content)?.content || '';
    const usage = history.filter((m) => m.role === 'assistant' && m.usage).reduce((sum, m) => ({ input: (sum.input || 0) + (m.usage.input || 0), output: (sum.output || 0) + (m.usage.output || 0) }), {});
    setSessionRun(session.id, { status: 'done', endedAt: new Date().toISOString(), cli: true });
    return finish({ ok: true, answer, sessionId: session.id, model: `${resolved.providerId}/${resolved.modelId}`, usage: usage.input || usage.output ? usage : null, denied });
  } catch (e) {
    saveSession(session);
    setSessionRun(session.id, { status: controller.signal.aborted ? 'stopped' : 'error', endedAt: new Date().toISOString(), cli: true });
    return finish({ ok: false, error: e?.message || String(e), sessionId: session.id, denied });
  } finally {
    lock.release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    disposePluginHosts();
    disposeBackground();
  }
}

function notifyScheduled(task, body, sessionId) {
  notify('scheduled', { title: `⏰ ${task.title}`, body, sessionId }).catch(() => {});
}

let schedulerTimer = null;
function startScheduler() {
  if (schedulerTimer) return;
  const tick = () => {
    const now = new Date();
    for (const task of scheduleStore().list()) {
      if (isDue(task, now) && !scheduledRunning.has(task.id)) runScheduled(task).catch(() => {});
    }
  };
  // Пропущенные запуски (приложение было закрыто) — через минуту после старта.
  setTimeout(tick, Number(process.env.MAI_SCHEDULER_DELAY_MS) || 60_000);
  schedulerTimer = setInterval(tick, 30_000);
}

function scheduleView() {
  const now = new Date();
  return {
    tasks: scheduleStore()
      .list()
      .map((t) => ({ ...t, description: describeSchedule(t.schedule), nextRun: t.enabled ? nextRunAt(t.schedule, now, t.lastRun)?.toISOString() || null : null, running: scheduledRunning.has(t.id) })),
  };
}

ipcMain.handle('schedule:list', () => scheduleView());
ipcMain.handle('schedule:runs', (_e, id) => scheduleStore().runs(id || null, 30));
/** Создать или изменить задачу. Задача работает без пользователя — только admin. */
ipcMain.handle('schedule:save', (_e, payload = {}) => {
  try {
    const projectDir = payload.projectDir || loadSettings().projectDir;
    if (!projectDir || !isTrusted(projectDir)) throw new Error('Плановая задача — только в доверенной папке');
    const task = scheduleStore().save({ ...payload, projectDir });
    audit({ at: new Date().toISOString(), tool: 'schedule:save', source: 'user', cls: 'external', subject: `${task.title} · ${describeSchedule(task.schedule)}`, decision: 'allow' });
    return { ok: true, task, ...scheduleView() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('schedule:remove', (_e, id) => {
  scheduleStore().remove(String(id));
  return { ok: true, ...scheduleView() };
});
ipcMain.handle('schedule:runNow', async (_e, id) => {
  const task = scheduleStore().get(String(id));
  if (!task) return { ok: false, error: 'Задача не найдена' };
  return runScheduled(task, { reason: 'manual' });
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
      notify('approval', { title: `Нужно подтверждение: ${chatTitle(sessionId)}`, body: String(payload.summary || payload.tool || '').slice(0, 200), sessionId }).catch(() => {});
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
      notify('question', { title: `Агент спрашивает: ${chatTitle(sessionId)}`, body: String(request.question || request.title || '').slice(0, 200), sessionId }).catch(() => {});
    });
}

/** Закрывает висящие подтверждения отказом, иначе инструмент ждёт клика вечно. */
function denyApprovals(state) {
  for (const resolve of state.approvals.values()) resolve({ allow: false, message: 'Остановлено пользователем.' });
  state.approvals.clear();
  for (const resolve of state.questions.values()) resolve({ cancelled: true });
  state.questions.clear();
}

/** Сколько ждём штатного завершения прогона после «Стоп», прежде чем освободить состояние силой. */
const STOP_GRACE_MS = 5000;

ipcMain.handle('chat:stop', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const state = runState(window);
  denyApprovals(state);
  const controller = state.controller;
  controller?.abort();
  // Если прогон не завершился за STOP_GRACE_MS (зависший инструмент, MCP,
  // сеть), освобождаем состояние принудительно: иначе следующий запрос
  // навсегда получает «Уже выполняется другой запрос».
  if (controller) {
    setTimeout(() => {
      if (state.controller !== controller) return;
      state.controller = null;
      state.approvals.clear();
      send(window, { type: 'error', message: 'Остановлено пользователем', aborted: true });
    }, STOP_GRACE_MS);
  }
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

// Наборы по ролям и онбординг (CW6.1, CW6.2, ADR 0070).
const rolesDir = () => path.join(app.getAppPath(), 'roles');
ipcMain.handle('roles:list', () => {
  const settings = loadSettings();
  const installed = new Set(listPackages('', dataDir(), { includeProject: false }).map((p) => p.name));
  return {
    roles: listRoles(rolesDir()).map(({ dir: _dir, ...role }) => ({ ...role, installed: installed.has(role.package) })),
    onboarding: settings.onboarding || null,
  };
});

/**
 * Каталоги команды для навыков роли (E1.7, ADR 0115): подключённые в /packages, у которых
 * в индексе есть роли, и корень MAI, если приложение запущено из исходников.
 */
function teamCatalogs() {
  const own = path.join(__dirname, '..');
  const list = marketplaces().filter((m) => Object.keys(catalogRoles(catalogDir(m, dataDir()))).length);
  if (!list.length && fs.existsSync(path.join(own, CATALOG))) list.push({ name: 'mai-team', url: own });
  return list;
}

ipcMain.handle('roles:install', async (_e, id) => {
  try {
    const { role, package: pkg } = installRole({ id, rolesDir: rolesDir(), dataDir: dataDir() });
    // Набор включён, даже если раньше его выключали; роль запоминается.
    const settings = loadSettings();
    saveSettings({ packages: { ...(settings.packages || {}), [pkg.name]: { ...(settings.packages?.[pkg.name] || {}), enabled: true } }, onboarding: { ...(settings.onboarding || {}), role: role.id } });
    audit({ at: new Date().toISOString(), tool: 'role:install', source: 'user', cls: 'external', subject: `${role.id} → ${pkg.name} ${role.version}`, decision: 'allow' });
    // Навыки роли из каталога команды: новые ставятся, более новые версии обновляются.
    const catalogSkills = { installed: [], updated: [], skipped: [], errors: [] };
    for (const market of teamCatalogs()) {
      const r = installRoleSkills({ market, role: role.id, dataDir: dataDir() });
      for (const key of Object.keys(catalogSkills)) catalogSkills[key].push(...r[key]);
    }
    if (catalogSkills.installed.length || catalogSkills.updated.length) {
      audit({ at: new Date().toISOString(), tool: 'role:catalog-skills', source: 'user', cls: 'external', subject: `${role.id}: +${catalogSkills.installed.join(',')} ↑${catalogSkills.updated.join(',')}`, decision: 'allow' });
    }
    const { dir: _dir, ...clean } = role;
    return { ok: true, role: clean, package: { name: pkg.name, parts: pkg.parts }, catalogSkills, warnings: [...packageSkillWarnings(pkg.name), ...catalogSkills.errors] };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/** Навыки только что установленного пакета против уже стоящих (CC10.5). */
function packageSkillWarnings(pkgName) {
  try {
    const dir = loadSettings().projectDir;
    const all = listSkills(dir, { includeProject: isTrusted(dir), extraDirs: packageDirs(packagesFor(dir), 'skills') });
    const mine = all.filter((s) => s.scope === `package:${pkgName}`).map((s) => s.name);
    return skillConflicts(all, mine, `package:${pkgName}`);
  } catch {
    return [];
  }
}

/** Установка из папки или git-URL в глобальные пакеты. Код пакета исполняется — только admin. */
ipcMain.handle('packages:install', async (_e, payload = {}) => {
  try {
    const pkg = installPackage({ from: payload.from, dataDir: dataDir(), replace: payload.replace === true });
    retirePluginHosts();
    await mcp.sync(mcpConfigs(loadSettings().projectDir)).catch(() => {});
    audit({ at: new Date().toISOString(), tool: 'package:install', source: 'user', cls: 'external', subject: `${pkg.name} ← ${String(payload.from).slice(0, 300)}`, decision: 'allow' });
    return { ok: true, package: pkg, warnings: packageSkillWarnings(pkg.name) };
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

/* ---------- проекты (CW1.5, ADR 0065) ---------- */

let projectStoreInstance = null;
const projectStore = () => (projectStoreInstance ||= createProjectStore(dataDir()));

/** Активный проект, если выбранная папка — его основная. */
function activeProjectFor(projectDir) {
  const id = loadSettings().activeProject;
  const project = id ? projectStore().get(id) : null;
  return project && projectDir && path.resolve(project.primaryDir) === path.resolve(projectDir) ? project : null;
}

ipcMain.handle('projects:list', () => ({ projects: projectStore().list(), active: loadSettings().activeProject || null }));
/** Выбор папки для проекта в системном диалоге: путь из окна только из этого диалога. */
ipcMain.handle('projects:pickDir', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openDirectory'] });
  return picked.canceled ? null : picked.filePaths[0] || null;
});
ipcMain.handle('projects:save', (_e, payload = {}) => {
  try {
    const project = projectStore().save(payload);
    audit({ at: new Date().toISOString(), tool: 'projects:save', source: 'user', cls: 'write', subject: `${project.name} · ${project.primaryDir}`, decision: 'allow' });
    return { ok: true, project };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('projects:remove', (_e, id) => {
  projectStore().remove(String(id));
  if (loadSettings().activeProject === id) saveSettings({ activeProject: null });
  return { ok: true };
});
/** Открыть проект: основная папка становится текущей, новые чаты — с его папками, видом и инструкциями. */
ipcMain.handle('projects:activate', (_e, id) => {
  const project = id ? projectStore().get(String(id)) : null;
  if (id && !project) return { ok: false, error: 'Проект не найден' };
  retirePluginHosts();
  saveSettings(project ? { projectDir: project.primaryDir, activeProject: project.id } : { activeProject: null });
  return { ok: true, project };
});

/* ---------- рабочие папки чата (CW1.2, ADR 0045) ---------- */

function sessionDirsView(sessionId) {
  const session = sessionId ? getSession(sessionId) : null;
  const projectDir = session?.projectDir || loadSettings().projectDir;
  return {
    ok: true,
    roots: normalizeRoots(projectDir, (session?.extraDirs || []).filter((d) => fs.existsSync(d))),
    missing: (session?.extraDirs || []).filter((d) => !fs.existsSync(d)),
  };
}

ipcMain.handle('session:dirs', (_e, sessionId) => sessionDirsView(sessionId));

/** Возможности модели для окна (CC13.1): показывать ли переключатель глубины, зрение и т. п. */
ipcMain.handle('models:caps', (_e, key) => {
  try {
    const settings = loadSettings();
    const resolved = resolveModel(settings, key || settings.activeModel);
    return modelCapabilities(resolved.modelId, resolved.provider);
  } catch {
    return null;
  }
});

/** «Код / Задача» (CW1.1, ADR 0046). Без чата — значение по умолчанию для новых. */
ipcMain.handle('session:setKind', (_e, payload = {}) => {
  const kind = payload.kind === 'task' ? 'task' : 'code';
  if (payload.sessionId && getSession(payload.sessionId)) {
    setSessionKind(payload.sessionId, kind);
    return { ok: true, kind, scope: 'session' };
  }
  saveSettings({ defaultKind: kind });
  return { ok: true, kind, scope: 'default' };
});
ipcMain.handle('session:kind', (_e, sessionId) => {
  const session = sessionId ? getSession(sessionId) : null;
  return { kind: session?.kind || (loadSettings().defaultKind === 'task' ? 'task' : 'code'), sessionId: session?.id || null };
});

/** Добавить папку к чату: выбор в системном диалоге — путь из окна не принимается. Расширяет доступ агента — admin. */
ipcMain.handle('session:addDir', async (event, sessionId) => {
  const session = sessionId ? getSession(sessionId) : null;
  if (!session) return { ok: false, error: 'Сначала начните чат' };
  const window = BrowserWindow.fromWebContents(event.sender);
  const picked = await dialog.showOpenDialog(window, { title: 'Папка для этого чата', properties: ['openDirectory', 'multiSelections'] });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
  const home = os.homedir();
  const bad = picked.filePaths.find((d) => path.resolve(d) === path.parse(path.resolve(d)).root || path.resolve(d) === home);
  if (bad) return { ok: false, error: `Нельзя дать доступ ко всему диску или домашней папке: ${bad}` };
  setSessionDirs(session.id, [...(session.extraDirs || []), ...picked.filePaths]);
  audit({ at: new Date().toISOString(), tool: 'session:addDir', source: 'user', cls: 'read', subject: picked.filePaths.join(', '), decision: 'allow' });
  return sessionDirsView(session.id);
});

ipcMain.handle('session:removeDir', (_e, payload = {}) => {
  const session = payload.sessionId ? getSession(payload.sessionId) : null;
  if (!session) return { ok: false, error: 'Нет чата' };
  setSessionDirs(session.id, (session.extraDirs || []).filter((d) => path.resolve(d) !== path.resolve(String(payload.dir || ''))));
  return sessionDirsView(session.id);
});

/* ---------- результаты задачи (CW2.6, ADR 0047) ---------- */

ipcMain.handle('results:list', (_e, sessionId) => (sessionId ? sessionResults(dataDir(), sessionId) : []));
ipcMain.handle('results:preview', (_e, payload = {}) => {
  try {
    return { ok: true, ...previewResult(dataDir(), payload.sessionId, payload.file) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
/** Открыть программой по умолчанию — только документ или картинку из результатов этого чата. */
ipcMain.handle('results:open', async (_e, payload = {}) => {
  try {
    const item = resultFile(dataDir(), payload.sessionId, payload.file);
    if (!item.openable) return { ok: false, error: 'Такой файл не открывается из приложения — «Показать в папке»' };
    const error = await shell.openPath(item.file);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('results:show', (_e, payload = {}) => {
  try {
    const item = resultFile(dataDir(), payload.sessionId, payload.file);
    shell.showItemInFolder(item.status === 'deleted' ? path.dirname(item.file) : item.file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/* ---------- корзина (CW1.4, ADR 0044) ---------- */

const trashDir = () => path.join(dataDir(), 'trash');
ipcMain.handle('trash:list', () => ({ items: listTrash(trashDir()), dir: trashDir() }));
ipcMain.handle('trash:restore', (_e, payload = {}) => {
  try {
    // Восстановить своё может любой; заменить то, что уже лежит на месте, — только admin.
    if (payload.overwrite === true) requireAdmin();
    const meta = restoreFromTrash(trashDir(), payload.id, { overwrite: payload.overwrite === true });
    audit({ at: new Date().toISOString(), tool: 'trash:restore', source: 'user', cls: 'write', subject: meta.original, decision: 'allow' });
    return { ok: true, item: meta };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('trash:purge', (_e, payload = {}) => ({ ok: true, removed: purgeTrash(trashDir(), { id: payload.id || null, all: payload.all === true }) }));

/* ---------- маркетплейс пакетов (CC10.2, ADR 0042) ---------- */

function marketplaces() {
  const list = loadSettings().marketplaces;
  return Array.isArray(list) ? list.filter((m) => m && m.name && m.url) : [];
}

function marketplaceView() {
  const settings = loadSettings();
  const installed = listPackages(settings.projectDir, dataDir(), { includeProject: false, settings: settings.packages || {} });
  return { marketplaces: listMarketplaces(marketplaces(), dataDir(), installed) };
}

ipcMain.handle('marketplace:list', () => marketplaceView());

ipcMain.handle('marketplace:add', (_e, payload = {}) => {
  try {
    const market = normalizeMarketplace(payload);
    const list = marketplaces().filter((m) => m.name !== market.name);
    refreshMarketplace(market, dataDir());
    saveSettings({ marketplaces: [...list, market] });
    audit({ at: new Date().toISOString(), tool: 'marketplace:add', source: 'user', cls: 'external', subject: `${market.name} ← ${market.url.slice(0, 300)}`, decision: 'allow' });
    return { ok: true, ...marketplaceView() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('marketplace:remove', (_e, name) => {
  saveSettings({ marketplaces: marketplaces().filter((m) => m.name !== name) });
  removeTree(path.join(dataDir(), 'marketplaces', String(name).replace(/[^a-z0-9._-]/gi, '')));
  return { ok: true, ...marketplaceView() };
});

ipcMain.handle('marketplace:refresh', () => {
  const errors = [];
  for (const market of marketplaces()) {
    try {
      refreshMarketplace(market, dataDir());
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }
  return { ok: !errors.length, errors, ...marketplaceView() };
});

/** Установка и обновление из каталога. Пакет — исполняемый код: только admin, в журнал. */
ipcMain.handle('marketplace:install', async (_e, payload = {}) => {
  try {
    const market = marketplaces().find((m) => m.name === payload.marketplace);
    if (!market) throw new Error(`Каталог «${payload.marketplace}» не подключён`);
    const { package: pkg, origin } = installFromMarketplace({ market, name: String(payload.name || ''), dataDir: dataDir(), replace: payload.replace === true });
    const settings = loadSettings();
    const packages = { ...(settings.packages || {}) };
    packages[pkg.name] = { ...(packages[pkg.name] || {}), origin };
    saveSettings({ packages });
    retirePluginHosts();
    await mcp.sync(mcpConfigs(settings.projectDir)).catch(() => {});
    audit({ at: new Date().toISOString(), tool: 'package:install', source: 'user', cls: 'external', subject: `${pkg.name} ${pkg.version} ← каталог ${market.name}`, decision: 'allow' });
    return { ok: true, package: pkg, warnings: packageSkillWarnings(pkg.name), ...marketplaceView() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
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
    kind: session?.kind || 'code',
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

// Дубли (CC10.5): у второго и дальше с тем же именем — кто его перекрывает.
ipcMain.handle('skills:list', (_e, projectDir) => {
  const seen = new Map();
  return listSkills(projectDir).map(({ name, description, scope, file }) => {
    const key = String(name).toLowerCase();
    const overriddenBy = seen.get(key) || '';
    if (!overriddenBy) seen.set(key, scope);
    return { name, description, scope, file, ...(overriddenBy ? { overriddenBy } : {}) };
  });
});
ipcMain.handle('skills:create', (_e, { projectDir, ...data }) => {
  requireAdmin();
  return createSkill(projectDir, data);
});
ipcMain.handle('skills:delete', (_e, file) => {
  requireAdmin();
  return deleteSkill(file);
});

// ---------- Сканер обновлений (N6, ADR 0102) ----------

const updateReportFile = () => path.join(dataDir(), 'update-scan.json');
const readUpdateReport = () => {
  try {
    return JSON.parse(fs.readFileSync(updateReportFile(), 'utf8'));
  } catch {
    return null;
  }
};
let updateScanRunning = null;

/** Скан: npm (только доверенный проект с package.json), навыки, CLI, MAI Code. */
function runUpdateScan(projectDir) {
  if (updateScanRunning) return updateScanRunning;
  const settings = loadSettings();
  const run = (cmd, args, cwd) => {
    // npm на Windows — .cmd-обёртка; аргументы фиксированные, оболочка безопасна.
    const r = spawnSync(cmd, args, { cwd: cwd || process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 120_000, shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });
    return { code: r.status ?? -1, stdout: r.stdout || '' };
  };
  const fetchJson = async (url) => {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'mai-code-update-scan' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const bundledDir = path.join(app.getAppPath(), 'skills');
  const installedDir = path.join(dataDir(), 'skills');
  let skills = [];
  try {
    skills = fs.readdirSync(bundledDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name, bundled: skillVersion(path.join(bundledDir, e.name)), installed: skillVersion(path.join(installedDir, e.name)) }));
  } catch {
    /* нет встроенных навыков */
  }
  const hasPackageJson = Boolean(projectDir) && isTrusted(projectDir) && fs.existsSync(path.join(projectDir, 'package.json'));
  updateScanRunning = scanUpdates({ projectDir, hasPackageJson, appVersion: app.getVersion(), skills, releasesRepo: settings.updateScan?.releasesRepo ?? 'crruton/MAI', run, fetchJson })
    .then((report) => {
      const full = { ...report, projectDir, npmChecked: hasPackageJson };
      fs.writeFileSync(updateReportFile(), JSON.stringify(full, null, 2), 'utf8');
      return full;
    })
    .finally(() => {
      updateScanRunning = null;
    });
  return updateScanRunning;
}

ipcMain.handle('updates:last', () => readUpdateReport());
ipcMain.handle('updates:scan', async (_e, payload = {}) => {
  try {
    return { ok: true, report: await runUpdateScan(projectOf(payload)) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

/**
 * Обновить на ветке (N6): отдельная рабочая копия mai/update-…, npm install
 * выбранных, тесты проекта. В проект ничего не попадает до слияния вручную.
 */
ipcMain.handle('updates:apply', async (_e, payload = {}) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const settings = loadSettings();
  const repo = repoRoot(projectDir);
  if (!repo) return { ok: false, error: 'Папка проекта — не git-репозиторий: обновлять негде, кроме самого проекта' };
  let args;
  try {
    args = installArgs(payload.packages);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  let wt;
  try {
    wt = createWorktree({ repo, baseDir: path.join(worktreesDir(), path.basename(repo)), id: `deps-${stamp}`, branchPrefix: 'mai/update-' });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
  if (isTrusted(repo)) setTrust(dataDir(), wt.dir, 'trusted');
  const dir = path.join(wt.dir, path.relative(repo, realPath(projectDir)));
  const install = await signoffExec(dir, `npm ${args.join(' ')}`, { ...settings, signoff: { timeoutMin: 15 } });
  const command = testCommandFor(dir, settings);
  const tests = install.code === 0 && command ? await signoffExec(dir, command, settings) : null;
  audit({ at: new Date().toISOString(), tool: 'updates:apply', source: 'user', cls: 'exec', subject: `${wt.branch}: ${args.slice(1).join(' ')}`.slice(0, 300), decision: 'allow' });
  return {
    ok: install.code === 0 && (!tests || tests.code === 0),
    branch: wt.branch,
    dir,
    installOk: install.code === 0,
    testsRun: Boolean(tests),
    testsOk: tests ? tests.code === 0 : null,
    command,
    output: String((tests || install).output || '').slice(-4000),
  };
});

/** Раз в сутки после запуска — тихий скан; уязвимости высокого риска — уведомлением. */
function scheduleUpdateScan() {
  const settings = loadSettings();
  if (settings.updateScan?.enabled === false) return;
  const timer = setTimeout(async () => {
    if (!scanDue(readUpdateReport()?.at, { intervalHours: Number(settings.updateScan?.intervalHours) || 24 })) return;
    try {
      const report = await runUpdateScan(loadSettings().projectDir);
      const urgent = report.items.filter((i) => i.risk === 'high');
      if (urgent.length) notify('background', { title: `Обновления: ${urgent.length} высокого риска`, body: urgent.slice(0, 3).map((i) => `${i.name}: ${i.note || i.latest}`).join('; ').slice(0, 200) }).catch(() => {});
      // Чистильщик (N7): версия стабильна и есть что освободить (от 100 МБ) — подсказка.
      const plan = cleanupPlan();
      if (plan.stable && plan.bytes >= 100 * 1024 * 1024) notify('background', { title: `Можно освободить ${formatBytes(plan.bytes)}`, body: 'Старые копии, временные файлы и кеши — /cleanup' }).catch(() => {});
    } catch {
      /* сеть или npm недоступны — попробуем при следующем запуске */
    }
  }, Number(process.env.MAI_UPDATE_SCAN_DELAY_MS || 90_000));
  timer.unref?.();
}

// ---------- Чистильщик старых версий (N7, ADR 0103) ----------

const versionFile = () => path.join(dataDir(), 'version-history.json');
/** С какого момента работает текущая версия: запись при каждой смене версии. */
function versionHistory() {
  let history = null;
  try {
    history = JSON.parse(fs.readFileSync(versionFile(), 'utf8'));
  } catch {
    /* первый запуск */
  }
  const next = trackVersion(history, app.getVersion());
  if (next !== history) {
    try {
      fs.writeFileSync(versionFile(), JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* только чтение — план всё равно строится */
    }
  }
  return next;
}

function cleanupPlan() {
  const settings = loadSettings();
  const c = settings.cleaner || {};
  let worktrees = [];
  try {
    const base = worktreesDir();
    worktrees = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((repo) => fs.readdirSync(path.join(base, repo.name), { withFileTypes: true }).filter((w) => w.isDirectory()).map((w) => ({ dir: path.join(base, repo.name, w.name), branch: w.name })));
  } catch {
    /* рабочих копий нет */
  }
  return planCleanup({ dataDir: dataDir(), tmpDir: os.tmpdir(), history: versionHistory(), marketplaces: settings.marketplaces || [], worktrees, stableDays: c.stableDays ?? 3, previousDays: c.previousDays ?? 14, outputDays: c.outputDays ?? 7 });
}

ipcMain.handle('cleanup:plan', () => cleanupPlan());
ipcMain.handle('cleanup:apply', (_e, payload = {}) => {
  requireAdmin();
  // План строится заново: удаляется только то, что в нём есть сейчас.
  const result = applyCleanup(cleanupPlan(), Array.isArray(payload.ids) ? payload.ids : [], { dataDir: dataDir(), tmpDir: os.tmpdir() });
  audit({ at: new Date().toISOString(), tool: 'cleanup', source: 'user', cls: 'delete', subject: `удалено ${result.removed.length}, ${formatBytes(result.bytes)}`, decision: 'allow' });
  return { ok: true, ...result, freed: formatBytes(result.bytes) };
});

// ---------- Границы данных (N2, ADR 0098) ----------

ipcMain.handle('privacy:report', (_e, payload = {}) => {
  const settings = loadSettings();
  const servers = mcpConfigs(projectOf(payload));
  const mcpList = Object.entries(servers)
    .filter(([, c]) => c && !c.disabled)
    .map(([name, c]) => ({ name, url: c.url || '', transport: c.url ? 'http' : 'stdio', connector: c.connector || '' }));
  const connectors = mcpList.filter((m) => m.connector).map((m) => ({ name: m.name, connected: true }));
  const schedules = scheduleStore().list().map((t) => ({ title: t.title, model: t.model, enabled: t.enabled }));
  return dataBoundaryReport(settings, { mcp: mcpList.filter((m) => !m.connector), connectors, schedules });
});

// ---------- Signoff (N1, ADR 0097) ----------

/** Тесты проекта для signoff: оболочка из настроек, таймаут signoff.timeoutMin (20 мин). */
function signoffExec(projectDir, command, settings) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let child;
    try {
      child = spawnShell(command, { shell: settings.shell, cwd: projectDir, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    } catch (err) {
      resolve({ code: -1, output: err.message, ms: 0 });
      return;
    }
    const push = (d) => {
      output = `${output}${d}`.slice(-200_000);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    const minutes = Math.max(1, Math.min(120, Number(settings.signoff?.timeoutMin) || 20));
    const timer = setTimeout(() => {
      push(`\n[таймаут ${minutes} мин — тесты остановлены]`);
      killProcessTree(child);
    }, minutes * 60_000);
    child.on('error', (err) => push(`\n${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output, ms: Date.now() - started });
    });
  });
}

ipcMain.handle('signoff:run', async (_e, payload = {}) => {
  requireAdmin();
  const projectDir = projectOf(payload);
  const settings = loadSettings();
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return { code: r.status ?? -1, stdout: r.stdout || '' };
  };
  const post = ({ owner, repo, sha, state, context, description, targetUrl }) => {
    const args = ['api', '-X', 'POST', `repos/${owner}/${repo}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`];
    if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
    const r = spawnSync('gh', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.error) return { ok: false, error: /ENOENT/.test(r.error.message) ? 'нет GitHub CLI (gh) — установите и выполните gh auth login' : r.error.message };
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout || `код ${r.status}`).trim().slice(0, 400) };
  };
  const result = await runSignoff({ projectDir, context: payload.context, fail: payload.fail === true, settings, git, exec: (command) => signoffExec(projectDir, command, settings), post });
  audit({ at: new Date().toISOString(), tool: 'signoff', source: 'user', cls: 'external', subject: `${result.context || payload.context || 'signoff'} ${result.state || 'не поставлен'} ${String(result.sha || '').slice(0, 7)}`, decision: result.ok ? 'allow' : 'deny' });
  return result;
});

// ---------- Multica ----------

ipcMain.handle('multica:status', () => multica.status());
ipcMain.handle('multica:install', () => {
  requireAdmin();
  return multica.installCli();
});
/** Workspace и проект Multica для папки: личное → проект (git) → настройки MAI (E2.3, ADR 0112). */
function multicaTarget(projectDir) {
  const dir = projectDir || loadSettings().projectDir;
  return multica.resolveTarget({ projectDir: dir, trusted: Boolean(dir) && isTrusted(dir), user: loadSettings().multica || {} });
}
ipcMain.handle('multica:auth', () => multica.authStatus(multicaTarget()));
ipcMain.handle('multica:issues', (_e, limit) => multica.listIssues(limit || 30, multicaTarget()));
ipcMain.handle('multica:target', (_e, projectDir) => multicaTarget(projectDir));
ipcMain.handle('multica:workspaces', () => multica.listWorkspaces());
ipcMain.handle('multica:projects', (_e, workspaceId) => multica.listProjects({ workspaceId: workspaceId || multicaTarget().workspaceId }));
ipcMain.handle('multica:setTarget', (_e, payload) => {
  requireAdmin();
  const dir = payload?.projectDir || loadSettings().projectDir;
  if (!dir) throw new Error('Не выбрана папка проекта');
  if (!isTrusted(dir)) return needTrust(dir) || { ok: false, error: 'Папка проекта не доверена: настройки Multica в неё не записываются' };
  return multica.saveProjectTarget(dir, { workspaceId: payload?.workspaceId, projectId: payload?.projectId }, { scope: payload?.scope || 'project' });
});
/** Каталог для отдачи навыков: подключённый в /packages по имени или корень MAI из исходников. */
function skillCatalogRoot(name) {
  if (name) {
    const market = marketplaces().find((m) => m.name === name);
    if (!market) throw new Error(`Каталог «${name}» не подключён в /packages`);
    return catalogDir(market, dataDir());
  }
  const own = path.join(__dirname, '..');
  if (fs.existsSync(path.join(own, CATALOG))) return own;
  const first = marketplaces()[0];
  if (!first) throw new Error('Нет каталога: подключите его в /packages → «Каталоги»');
  return catalogDir(first, dataDir());
}
// Навыки каталога → Multica MAI (E1.8, ADR 0113).
ipcMain.handle('multica:pushSkills', (_e, payload) => {
  requireAdmin();
  const names = Array.isArray(payload?.names) ? payload.names.map(String) : [];
  return multica.pushCatalogSkills(skillCatalogRoot(payload?.market), multicaTarget(payload?.projectDir), { names, prune: Boolean(payload?.prune), dryRun: Boolean(payload?.dryRun) });
});
ipcMain.handle('multica:syncDocs', (_e, projectDir) => {
  requireAdmin();
  const dir = projectDir || loadSettings().projectDir;
  return multica.syncOpenSpec(dir, multicaTarget(dir));
});
// Статусы Multica → галочки в openspec/changes/*/tasks.md (F14, ADR 0089).
ipcMain.handle('multica:pullStatuses', (_e, projectDir) => {
  requireAdmin();
  const dir = projectDir || loadSettings().projectDir;
  return multica.pullStatuses(dir, { target: multicaTarget(dir) });
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
ipcMain.handle('mcp:scopes', (_e, projectDir) => Object.fromEntries(mcpSources(projectDir).map(({ name, scope }) => [name, scope])));
/** Личный MCP-сервер проекта (CC9.5): .mai-code/mcp.local.json, только доверенная папка. */
ipcMain.handle('mcp:saveLocal', async (_e, payload = {}) => {
  const dir = payload.projectDir || loadSettings().projectDir;
  const name = String(payload.name || '').trim();
  if (!dir || !isTrusted(dir)) return { ok: false, error: 'Папка не доверена — локальные MCP-серверы не сохраняются' };
  if (!/^[\w.-]{1,64}$/.test(name)) return { ok: false, error: 'Неверное имя сервера' };
  updateLocalMcp(dir, name, payload.config || null);
  const result = payload.config ? await mcp.connect(name, payload.config) : (await mcp.disconnect(name), { ok: true });
  return { ok: true, connect: result };
});
ipcMain.handle('mcp:sync', async (_e, projectDir) => {
  const settings = loadSettings();
  return mcp.sync(mcpConfigs(projectDir || settings.projectDir));
});
ipcMain.handle('mcp:connect', async (_e, name, projectDir) => {
  const config = mcpConfigs(projectDir)[name];
  if (!config) return { ok: false, error: 'Сервер не найден в настройках' };
  return mcp.connect(name, config);
});
ipcMain.handle('mcp:login', async (_e, name, projectDir) => {
  const config = mcpConfigs(projectDir)[name];
  if (!config) return { ok: false, error: 'Сервер не найден в настройках' };
  const result = await mcp.login(name, config);
  audit({ at: new Date().toISOString(), type: 'mcp_login', server: name, ok: result.ok });
  return result;
});
ipcMain.handle('mcp:logout', (_e, name) => mcp.logout(name));

/* ---------- каталог коннекторов (CW3.1, ADR 0052) ---------- */

function connectorCatalog() {
  const org = managed();
  return listConnectors({ managed: org.connectors, onlyManaged: org.onlyManagedConnectors });
}

ipcMain.handle('connectors:list', () => {
  const servers = loadSettings().mcpServers || {};
  const status = mcp.status();
  return connectorCatalog().map((c) => {
    const name = Object.keys(servers).find((n) => servers[n]?.connector === c.id);
    const st = name ? status.find((s) => s.name === name) : null;
    return { ...c, installed: Boolean(name), server: name || null, status: st?.status || (name ? 'не подключён' : ''), loggedIn: Boolean(st?.loggedIn) };
  });
});

/** Локальные коннекторы (CW3.3, ADR 0072): проверки параллельно, у каждой свой предел. */
const settle = (fn, ms) => Promise.race([Promise.resolve().then(fn).catch((err) => ({ error: err?.message || String(err) })), new Promise((r) => setTimeout(() => r(null), ms))]);
ipcMain.handle('connectors:local', async () => {
  const settings = loadSettings();
  const [rw, mc, inf] = await Promise.all([settle(() => repowise.detect(), 8000), settle(() => multica.status(), 8000), settle(() => infra.probe(), 8000)]);
  return localConnectors({ repowise: rw, repowiseEnabled: Boolean(settings.repowise?.enabled), multica: mc, infra: inf, config: settings.infra || {} });
});

/** Включить/выключить локальный коннектор здесь же. Только admin. */
ipcMain.handle('connectors:localToggle', (_e, payload = {}) => {
  if (payload.id !== 'repowise') return { ok: false, error: 'Этот сервис включается в своей настройке' };
  const settings = loadSettings();
  saveSettings({ repowise: { ...(settings.repowise || {}), enabled: payload.enabled === true } });
  audit({ at: new Date().toISOString(), tool: 'connectors:localToggle', source: 'user', cls: 'external', subject: `repowise → ${payload.enabled === true ? 'on' : 'off'}`, decision: 'allow' });
  return { ok: true };
});

/** Подключить из каталога: запись в mcpServers, для OAuth — сразу вход в браузере. Только admin. */
ipcMain.handle('connectors:add', async (_e, payload = {}) => {
  const connector = connectorCatalog().find((c) => c.id === payload.id);
  if (!connector) return { ok: false, error: 'Нет такого коннектора в каталоге' };
  let config;
  try {
    config = connectorServerConfig(connector, { token: payload.token });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const settings = loadSettings();
  saveSettings({ mcpServers: { ...(settings.mcpServers || {}), [connector.id]: config } });
  audit({ at: new Date().toISOString(), tool: 'connectors:add', source: 'user', cls: 'external', subject: `${connector.id} ← ${connector.url}`, decision: 'allow' });
  const fresh = mcpConfigs(settings.projectDir)[connector.id] || config;
  let result = await mcp.connect(connector.id, fresh);
  if (!result.ok && result.needsAuth && connector.auth === 'oauth') result = await mcp.login(connector.id, fresh);
  return result.ok ? { ok: true, tools: result.tools } : { ok: false, error: result.error, saved: true };
});

ipcMain.handle('connectors:remove', async (_e, id) => {
  const settings = loadSettings();
  const servers = { ...(settings.mcpServers || {}) };
  const name = Object.keys(servers).find((n) => servers[n]?.connector === id);
  if (!name) return { ok: false, error: 'Коннектор не подключён' };
  delete servers[name];
  saveSettings({ mcpServers: servers });
  await mcp.logout(name);
  return { ok: true };
});
ipcMain.handle('mcp:remove', async (_e, name, projectDir) => {
  const settings = loadSettings();
  const dir = projectDir || settings.projectDir;
  if (dir && isTrusted(dir) && projectMcpConfig(dir, 'mcp.local.json')[name]) updateLocalMcp(dir, name, null);
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
  // Версия секции (F9, ADR 0062): правка поверх чужого сохранения — конфликт, а не потеря.
  return saveBoardSection(projectOf(payload), payload.section, payload.data, payload.rev);
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
  // Самокоррекция работает в проекте папки, если он открыт (CW1.5).
  const project = activeProjectFor(projectDir);
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
        settings: agentSettings(settings),
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
        // Трассировка прогона в OTLP (F22, ADR 0063), если телеметрия включена.
        tracer: agentTracer(),
        // Запасная модель при сбое основной (ADR 0057).
        fallback: fallbackFor(settings, payload.model || settings.activeModel),
        // Чекпоинты правок для отката (CC6.1).
        checkpoint: createRecorder({ dataDir: dataDir(), sessionId: session.id, projectDir }),
        extraDirs: [...new Set([...(project?.extraDirs || []), ...(getSession(session.id)?.extraDirs || [])])].filter((d) => fs.existsSync(d)),
        kind: getSession(session.id)?.kind || 'code',
        project,
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

/** Вход калибратора (F15): PRD, модель и C1–C3, ADR (доска и docs/adr), OpenSpec. */
function gatherCalibration(projectDir) {
  const readSafe = (file, n = 20_000) => {
    try {
      return fs.readFileSync(file, 'utf8').slice(0, n);
    } catch {
      return '';
    }
  };
  const data = loadBoards(projectDir);
  const { views } = generateViews(projectDir, '');
  const adrs = (data.architecture?.adrs || []).map((a) => {
    let content = '';
    try {
      content = a.artifactId ? readArtifact(projectDir, a.artifactId)?.content || '' : '';
    } catch {
      /* артефакт удалён */
    }
    return { title: a.title, status: a.status, content };
  });
  const adrDir = path.join(projectDir, 'docs', 'adr');
  try {
    for (const name of fs.readdirSync(adrDir).filter((n) => /^\d{3,4}-.*\.md$/.test(n)).sort().slice(-40)) {
      const text = readSafe(path.join(adrDir, name), 4000);
      adrs.push({ title: /^#\s+(.+)$/m.exec(text)?.[1] || name, status: /Статус:\*{0,2}\s*([^\s,]+)/i.exec(text)?.[1] || '', content: text });
    }
  } catch {
    /* нет docs/adr */
  }
  const openspec = openspecChanges(projectDir).map((c) => ({ name: c.name, title: c.title, summary: c.summary, open: c.tasks.filter((t) => !t.done).map((t) => t.text) }));
  return calibrationContext({ prd: readSafe(path.join(projectDir, 'docs', 'PRD.md')) || readSafe(path.join(projectDir, 'PRD.md')), model: data.architecture?.model || {}, views, adrs, openspec });
}

const CALIBRATION_ID = 'calibration:architecture';

/** Калибровка архитектуры и PRD (F15, ADR 0090): отчёт → артефакт note с версиями. */
ipcMain.handle('boards:calibrate', async (_e, payload = {}) => {
  requireAdmin();
  const log = [];
  const settings = loadSettings();
  try {
    const resolved = resolveModel(settings, payload.model || settings.activeModel);
    const projectDir = projectOf(payload);
    const context = gatherCalibration(projectDir);
    log.push(`Контекст собран: ${context.length} симв.`);
    let prev = null;
    try {
      prev = readArtifact(projectDir, CALIBRATION_ID);
    } catch {
      /* первый запуск */
    }
    const result = await calibrate({
      provider: resolved.provider,
      model: resolved.modelId,
      context,
      prev: prev?.meta?.report || null,
      prevBaseline: prev?.meta?.baseline || '',
      onLog: (line) => log.push(line),
    });
    const at = new Date().toISOString();
    const artifact = writeArtifact(projectDir, {
      id: CALIBRATION_ID,
      kind: 'note',
      name: 'Калибровка архитектуры',
      title: 'Калибровка архитектуры и PRD',
      content: calibrationMarkdown(result.report, { at, model: resolved.modelId, baseline: result.baseline }),
      meta: { report: result.report, baseline: result.baseline, model: resolved.modelId, at },
      note: result.diff ? `калибровка: +${result.diff.added.length} −${result.diff.resolved.length}` : 'первая калибровка',
    });
    log.push(`Сохранено: ${CALIBRATION_ID} v${artifact.current}`);
    return { ok: true, ...result, at, artifact: { id: artifact.id, current: artifact.current }, log };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), log };
  }
});

/** Применить предложение агента схем (F10, ADR 0086). Только admin. */
ipcMain.handle('boards:diagramApply', (_e, payload = {}) => {
  requireAdmin();
  try {
    return applyDiagram({ projectDir: projectOf(payload), proposal: payload.proposal, baseHash: String(payload.baseHash || '') });
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

// Автосинхронизация хранилища (F12, ADR 0087): правки артефактов → фоновая очередь.
const autoSyncEnabled = () => {
  const cfg = loadSettings().infra || {};
  return Boolean(cfg.autoSync && (cfg.postgresUrl || cfg.seaweedUrl));
};
const syncQueue = createSyncQueue({
  run: (projectDir) => infra.autoSync(projectDir, { embed: loadSettings().infra?.autoSyncEmbed !== false }),
  debounceMs: Number(process.env.MAI_SYNC_DEBOUNCE_MS || 5000),
});
onArtifactWrite((projectDir, artifact) => {
  if (autoSyncEnabled()) syncQueue.schedule(projectDir, artifact?.id || '');
});
app.on('before-quit', () => syncQueue.stop());
// Метрики агента (F23): последнюю порцию — при выходе, без ожидания.
app.on('before-quit', () => void flushMetrics());
ipcMain.handle('infra:syncStatus', (_e, payload) => ({ enabled: autoSyncEnabled(), ...syncQueue.status(projectOf(payload)) }));
ipcMain.handle('infra:syncNow', async (_e, payload) => {
  requireAdmin();
  return { enabled: autoSyncEnabled(), ...(await syncQueue.flush(projectOf(payload))) };
});
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

ipcMain.handle('repowise:status', async (_e, payload) => {
  const base = await repowise.status(projectOf(payload));
  // Состояние MCP-сервера `serve --no-ui` (F13): проверка ping, перезапуски.
  const settings = loadSettings();
  const saved = settings.mcpServers?.repowise;
  const configured = Boolean(saved);
  // Конфиг, сохранённый до F13, — без таймаута и перезапуска: дополняем.
  if (saved && saved.callTimeoutMs === undefined) {
    const { callTimeoutMs, restartOnTimeout, retryOnTimeout } = repowise.mcpConfig(saved.cwd || projectOf(payload));
    const upgraded = { ...saved, callTimeoutMs, restartOnTimeout, retryOnTimeout };
    saveSettings({ mcpServers: { ...settings.mcpServers, repowise: upgraded } });
    const live = mcp.servers.get('repowise');
    if (live) live.config = upgraded;
  }
  if (configured && mcp.servers.has('repowise')) await mcp.checkHealth('repowise').catch(() => {});
  return { ...base, mcp: configured ? mcp.status().find((s) => s.name === 'repowise') || { name: 'repowise', status: 'disconnected', restarts: 0 } : null };
});
ipcMain.handle('repowise:restartMcp', async () => {
  requireAdmin();
  const config = loadSettings().mcpServers?.repowise;
  if (!config) return { ok: false, error: 'MCP repowise не подключён — нажмите «Подключить MCP»' };
  const res = mcp.servers.has('repowise') ? await mcp.restart('repowise') : await mcp.connect('repowise', config);
  return { ...res, mcp: mcp.status().find((s) => s.name === 'repowise') || null };
});
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
