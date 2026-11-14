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
  { id: 'auto', label: 'Авто', description: 'Агент сам решает' },
  { id: 'manual', label: 'Вручную', description: 'Спрашивать всегда' },
  { id: 'acceptEdits', label: 'Принимать правки', description: 'Правки без вопросов' },
  { id: 'plan', label: 'План', description: 'Только чтение и план' },
];

ipcMain.handle('settings:get', () => ({
  projectDir: root,
  activeModel: 'test-model',
  permissionMode: 'manual',
  providers: [],
  models: [],
}));
ipcMain.handle('runtimes:list', () => ({}));
ipcMain.handle('auth:status', () => ({ authenticated: false }));
ipcMain.handle('models:list', () => []);
ipcMain.handle('sessions:list', () => []);
ipcMain.handle('permissions:modes', () => ({ current: 'manual', fallback: 'manual', sessionId: null, modes: MODES }));
ipcMain.handle('permissions:set', (_e, payload) => ({ ok: true, mode: payload?.mode, scope: 'default' }));
ipcMain.handle('attachments:list', () => []);
ipcMain.handle('chat:onEvent', () => {});
// Окно досок грузится в разделе [9]: без заглушки Electron пишет в лог
// «No handler registered for 'boards:load'», и это выглядит как дефект.
ipcMain.handle('boards:load', () => ({
  boards: loadBoards(root),
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
    check('опций 4', info.options?.length === 4, JSON.stringify(info.options));
    check(
      'подписи режимов на месте',
      info.options?.map((o) => o.text).join(',') === 'Авто,Вручную,Принимать правки,План',
      JSON.stringify(info.options),
    );
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
