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
  providers: [],
  models: [],
}));
ipcMain.handle('runtimes:list', () => ({}));
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
ipcMain.handle('sessions:list', () => [TEST_SESSION]);
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
ipcMain.handle('permissions:modes', () => ({ current: 'manual', fallback: 'manual', sessionId: null, modes: MODES }));
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

    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 300));
    const a1 = approvals.find((a) => a.id === 'appr-1');
    check('клавиша 2: разрешено с правилом на чат', a1?.allow === true && a1?.remember === 'session' && a1?.rules?.[0] === 'run_shell(git push*)', JSON.stringify(a1));

    win.webContents.send('chat:event', {
      type: 'approval',
      id: 'appr-2',
      tool: 'write_file',
      cls: 'write',
      summary: 'Записать файл src/a.js',
      risk: 'medium',
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
