/**
 * Вывод консольных программ на Windows (найдено прогоном на windows-latest).
 *
 * cmd.exe и многие программы пишут в pipe не UTF-8, а кодировку консоли:
 * OEM (cp866 на русской Windows) или ANSI (cp1251). Чтение как UTF-8 давало
 * кракозябры вместо кириллицы — и модель получала мусор вместо текста ошибок.
 *
 * Декодер читает поток как UTF-8; если байты невалидны, перекодирует кусок из
 * cp866 или cp1251 — какой даёт больше осмысленной кириллицы.
 */
import { StringDecoder } from 'node:string_decoder';

const CYRILLIC = /[а-яёА-ЯЁ]/g;
const BOX = /[─-╿▀-▟]/g; // псевдографика: признак неверной кодировки

function score(text) {
  return (text.match(CYRILLIC) || []).length - 3 * (text.match(BOX) || []).length;
}

function legacyDecode(chunk) {
  const variants = ['ibm866', 'windows-1251'].map((name) => {
    try {
      return new TextDecoder(name).decode(chunk);
    } catch {
      return '';
    }
  });
  return score(variants[1]) > score(variants[0]) ? variants[1] : variants[0];
}

/** Потоковый декодер: (Buffer) → string. На не-Windows — обычный UTF-8. */
export function createOutputDecoder({ platform = process.platform } = {}) {
  if (platform !== 'win32') {
    const utf8 = new StringDecoder('utf8');
    return (chunk) => utf8.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  // Один потоковый декодер с fatal: помнит хвост буквы, разрезанной между кусками,
  // и бросает ошибку на невалидном UTF-8 — тогда это кодировка консоли.
  let utf8 = new TextDecoder('utf-8', { fatal: true });
  return (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    try {
      return utf8.decode(buffer, { stream: true });
    } catch {
      utf8 = new TextDecoder('utf-8', { fatal: true });
      return legacyDecode(buffer);
    }
  };
}

/** Команда для cmd.exe с консолью в UTF-8: chcp 65001 до самой команды. */
export function withUtf8Console(command, platform = process.platform) {
  return platform === 'win32' ? `chcp 65001 >nul & ${command}` : command;
}
