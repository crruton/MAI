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

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
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

    console.log('\n[2] API моста доступен');
    const bridge = await win.webContents.executeJavaScript(`(() => ({
      hasMai: typeof window.mai === 'object',
      hasPermissions: typeof window.mai?.permissions === 'object',
      hasModes: typeof window.mai?.permissions?.modes === 'function',
      hasSet: typeof window.mai?.permissions?.set === 'function',
    }))()`);
    check('window.mai есть', bridge.hasMai === true);
    check('window.mai.permissions есть', bridge.hasPermissions === true);
    check('permissions.modes — функция', bridge.hasModes === true);
    check('permissions.set — функция', bridge.hasSet === true);

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
