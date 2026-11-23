import fs from 'node:fs';
import path from 'node:path';

/**
 * Удалить папку целиком (ADR 0104). В Node 24 (Electron 45) `fs.rmSync` на
 * Windows не удаляет файлы «только для чтения» — а такие у git все объекты в
 * `.git/objects`: клон пакета, кеш каталога, рабочая копия. Перед удалением
 * снимаем атрибут, затем `rmSync` с повторами (антивирус держит файл).
 */
export function removeTree(target, { platform = process.platform } = {}) {
  if (!target || !fs.existsSync(target)) return;
  if (platform === 'win32') {
    const walk = (p) => {
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        return;
      }
      if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      else if (!(st.mode & 0o200)) {
        try {
          fs.chmodSync(p, 0o666);
        } catch {
          /* rmSync скажет, если не вышло */
        }
      }
    };
    walk(target);
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
