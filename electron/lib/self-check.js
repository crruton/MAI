import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Самопроверка установленного приложения (F25, ADR 0095): `MAI Code.exe --self-check`.
 * Запускается в CI после тихой установки на чистом Windows-раннере без Node.js
 * в PATH: ресурсы внутри asar, модули main-процесса, запись в папку данных,
 * командная оболочка, хранилище ключей ОС и системные корневые сертификаты.
 *
 * Модуль не зависит от Electron: пути и safeStorage передаёт вызывающий.
 */

export const isSelfCheck = (argv = process.argv) => argv.some((a) => a === '--self-check' || a.startsWith('--self-check='));

/** Куда писать отчёт: --self-check=<файл> или MAI_SELF_CHECK_OUT; '' — только stdout. */
export function selfCheckOut(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a.startsWith('--self-check='));
  return arg ? arg.slice('--self-check='.length) : env.MAI_SELF_CHECK_OUT || '';
}

const REQUIRED_FILES = ['renderer/index.html', 'renderer/app.js', 'renderer/board.html', 'electron/preload.cjs', 'electron/main.js', 'docs/USER-GUIDE.md', 'package.json'];
const REQUIRED_MODULES = ['openai', 'pdf-lib', '@modelcontextprotocol/sdk/client/index.js', 'mermaid/package.json'];

export async function runSelfCheck({ appPath, userData, version = '', platform = process.platform, safeStorage = null, systemCa = 0, env = process.env, versions = process.versions, importer = (m) => import(m) }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });

  for (const rel of REQUIRED_FILES) {
    const file = path.join(appPath, rel);
    add(`файл ${rel}`, fs.existsSync(file), file);
  }
  let skills = [];
  try {
    skills = fs.readdirSync(path.join(appPath, 'skills'));
  } catch {
    /* нет каталога */
  }
  add('встроенные навыки', skills.length > 0, `${skills.length} шт.`);

  for (const mod of REQUIRED_MODULES) {
    try {
      // mermaid — модуль окна: проверяем, что он упакован, а не грузим в main.
      if (mod.endsWith('package.json')) {
        const { createRequire } = await import('node:module');
        createRequire(path.join(appPath, 'package.json')).resolve(mod);
      } else {
        await importer(mod);
      }
      add(`модуль ${mod}`, true);
    } catch (err) {
      add(`модуль ${mod}`, false, err?.message || err);
    }
  }

  try {
    fs.mkdirSync(userData, { recursive: true });
    const probe = path.join(userData, `.self-check-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    const back = fs.readFileSync(probe, 'utf8');
    fs.rmSync(probe, { force: true });
    add('запись в папку данных', back === 'ok', userData);
  } catch (err) {
    add('запись в папку данных', false, err?.message || err);
  }

  const shell = platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'echo mai-ok'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }) : spawnSync('sh', ['-c', 'echo mai-ok'], { encoding: 'utf8', timeout: 15_000 });
  add(platform === 'win32' ? 'оболочка cmd.exe' : 'оболочка sh', shell.status === 0 && /mai-ok/.test(shell.stdout || ''), shell.error?.message || (shell.stdout || shell.stderr || '').trim());

  // Node.js на машине не нужен: main работает на встроенном в Electron.
  add('встроенный Node.js', Boolean(versions.node && versions.electron), `node ${versions.node}, electron ${versions.electron || '—'}`);

  if (safeStorage) {
    const available = safeStorage.isEncryptionAvailable();
    // На Windows это DPAPI — должно быть всегда; на Linux без keyring — нет, и это не ошибка.
    add('хранилище ключей ОС', platform === 'win32' ? available : true, available ? 'доступно' : 'недоступно');
  }

  // Корпоративный корневой сертификат: системные корни в процессе или запасной перезапуск.
  const viaFlag = String(env.NODE_OPTIONS || '').includes('--use-system-ca');
  add('системные корневые сертификаты', systemCa > 0 || viaFlag, systemCa > 0 ? `${systemCa} корней (tls.setDefaultCACertificates)` : viaFlag ? 'NODE_OPTIONS --use-system-ca' : 'не подключены');

  const ok = checks.every((c) => c.ok);
  return { ok, version, platform, appPath, at: new Date().toISOString(), checks };
}
