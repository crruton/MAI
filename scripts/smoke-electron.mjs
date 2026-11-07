/**
 * Smoke-тест в настоящем Electron: проверяет, что main-процессные модули
 * загружаются и режимы разрешений работают внутри Electron, а не только в Node.
 *
 * Запуск: npx electron scripts/smoke-electron.mjs
 * Окно не создаётся, приложение выходит сразу после проверок.
 */
import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    console.log('\n[1] Загрузка модулей main-процесса');
    const config = await import('../electron/lib/config.js');
    check('config.js загружен', typeof config.loadSettings === 'function');
    const permissions = await import('../electron/lib/permissions.js');
    check('permissions.js загружен', typeof permissions.decide === 'function');
    const attachments = await import('../electron/lib/attachments.js');
    check('attachments.js загружен', typeof attachments.saveFromPaths === 'function');
    const agent = await import('../electron/lib/agent.js');
    check('agent.js загружен', typeof agent.runAgent === 'function');
    const fsTools = await import('../electron/lib/tools/fs.js');
    check('tools/fs.js загружен', Array.isArray(fsTools.fsTools));
    const shellTools = await import('../electron/lib/tools/shell.js');
    check('tools/shell.js загружен', Array.isArray(shellTools.shellTools));

    console.log('\n[2] Настройки: режим по умолчанию');
    const settings = config.loadSettings();
    check('permissionMode задан', Boolean(settings.permissionMode), String(settings.permissionMode));
    check(
      'permissionMode — допустимое значение',
      permissions.PERMISSION_MODES.includes(settings.permissionMode),
      settings.permissionMode,
    );
    check('autoApproveShell удалён', !('autoApproveShell' in settings));

    console.log('\n[3] Решение по режимам внутри Electron');
    check('plan + write_file → deny', permissions.decide({ mode: 'plan', tool: 'write_file' }).action === 'deny');
    check('auto + write_file → allow', permissions.decide({ mode: 'auto', tool: 'write_file' }).action === 'allow');
    check('manual + run_shell → ask', permissions.decide({ mode: 'manual', tool: 'run_shell' }).action === 'ask');

    console.log('\n[4] Вложения внутри Electron');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-smoke-'));
    const source = path.join(project, 'hello.txt');
    fs.writeFileSync(source, 'привет', 'utf8');
    const saved = attachments.saveFromPaths({ projectDir: project, sessionId: 'smoke', paths: [source] });
    check('файл скопирован', saved.entries.length === 1, JSON.stringify(saved.errors));
    check('тип определён как текст', saved.entries[0]?.kind === 'text', saved.entries[0]?.kind);
    check('путь относительный', !path.isAbsolute(saved.entries[0]?.path || ''), saved.entries[0]?.path);
    fs.rmSync(project, { recursive: true, force: true });
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.message || err}`);
    console.log(err?.stack || '');
  }

  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
