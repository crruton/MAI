/**
 * UI-тест: загружает настоящий renderer/index.html в окно Electron и проверяет,
 * что селектор режимов отрисован и заполнен.
 *
 * IPC-каналы подменены заглушками: тест проверяет фронтенд, а не бэкенд.
 * Запуск: npx electron scripts/test-ui.mjs
 */
import { app, BrowserWindow, ipcMain } from 'electron';
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
]);
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
const savedSettings = [];
ipcMain.handle('settings:save', (_e, patch) => {
  savedSettings.push(patch);
  return { projectDir: root, activeModel: 'test-model', permissionMode: 'manual', providers: {}, models: [], ...patch };
});
ipcMain.handle('auth:status', () => ({ authenticated: false, role: 'admin', mode: 'local' }));
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
ipcMain.handle('sessions:get', (_e, id) => (id === TEST_SESSION.id ? TEST_SESSION : null));

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
ipcMain.handle('boards:load', () => ({
  boards: craftedBoards || loadBoards(root),
  projectDir: root,
  settings: { projectDir: root, activeModel: 'test-model' },
}));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
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

    console.log('\n[1] Селектор режимов в DOM');
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
      const text = body.innerText;
      const raw = body.textContent;
      const inputs = [...body.querySelectorAll('input')].map((i) => i.value);
      const buttons = [...body.querySelectorAll('button')].map((b) => b.innerText.trim());
      return {
        open: true,
        hasGroup: raw.includes('MAS — распознавание речи'),
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
      };
    })()`);
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
    check('четыре варианта в меню чата', chatMenu.items.length === 4, JSON.stringify(chatMenu.items));

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
    await win.webContents.executeJavaScript(`document.querySelector('#project-btn').click()`);
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
    await win.webContents.executeJavaScript(`(() => { const m = document.querySelector('.modal'); const i = m.querySelector('input.sessions-search'); i.value = 'https://example.com/git-kit.git'; [...m.querySelectorAll('button')].find((b) => b.textContent === 'Установить').click(); })()`);
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
      const d = document.querySelector('.shell-sandbox-docker');
      if (!d) return { found: false };
      const before = { docker: d.checked, network: document.querySelector('.shell-sandbox-network').value };
      d.checked = true;
      document.querySelector('.shell-sandbox-image').value = 'python:3.12-slim';
      document.querySelector('.shell-sandbox-network').value = 'bridge';
      document.querySelector('.shell-sandbox-host').value = 'git *\\n\\n  gh *  ';
      [...document.querySelectorAll('.modal button')].find((b) => b.textContent === 'Сохранить').click();
      return { found: true, before };
    })()`);
    check('раздел «Команды агента» в настройках', box.found === true, JSON.stringify(box));
    check('по умолчанию выключено, сеть выключена', box.before?.docker === false && box.before?.network === 'none', JSON.stringify(box));
    await new Promise((r) => setTimeout(r, 400));
    const sb = savedSettings.at(-1)?.shellSandbox;
    check('сохраняется mode/image/network/hostCommands', sb?.mode === 'docker' && sb?.image === 'python:3.12-slim' && sb?.network === 'bridge' && sb?.hostCommands?.join('|') === 'git *|gh *', JSON.stringify(sb));
    await win.webContents.executeJavaScript(`document.querySelector('.modal-backdrop .x')?.click()`);
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
