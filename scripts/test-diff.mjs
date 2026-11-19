/**
 * Unified diff для запроса разрешения и карточки правки (CC7.3).
 */
import { unifiedDiff } from '../electron/lib/diff.js';

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
const types = (d) => d.lines.map((l) => l.type + l.text).join('|');

console.log('\n[1] Простые правки');
const one = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
check('замена строки: −1 +1', one.added === 1 && one.removed === 1);
check('удаление перед вставкой', types(one).includes('-b|+B'), types(one));
check('контекст вокруг правки', types(one).startsWith('@'), types(one));
check('без изменений — пусто', unifiedDiff('x\n', 'x\n').lines.length === 0);
check('новый файл помечен', unifiedDiff('', 'a\nb').created === true && unifiedDiff('', 'a\nb').added === 2);
check('CRLF и LF — одинаковые строки', unifiedDiff('a\r\nb\r\n', 'a\nb\n').lines.length === 0);

console.log('\n[2] Ханки и контекст');
const lines = Array.from({ length: 40 }, (_, i) => `l${i}`);
const changed = [...lines];
changed[5] = 'X';
changed[30] = 'Y';
const two = unifiedDiff(lines.join('\n'), changed.join('\n'), { context: 2 });
check('два ханка', two.lines.filter((l) => l.type === '@').length === 2, types(two));
check('лишний контекст не показан', !two.lines.some((l) => l.text === 'l15'));
check('номер строки в заголовке ханка', /строка 4/.test(two.lines[0].text), two.lines[0].text);

console.log('\n[3] Большие файлы');
const big = Array.from({ length: 20000 }, (_, i) => `строка ${i}`).join('\n');
const started = Date.now();
const d = unifiedDiff(big, big.replace('строка 10000', 'правка'));
check('маленькая правка в большом файле — быстро', Date.now() - started < 500 && d.added === 1 && d.removed === 1, `${Date.now() - started} мс`);
const replaced = unifiedDiff(Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n'));
check('полная замена большого блока не виснет', replaced.added === 3000 && replaced.removed === 3000);
check('вывод ограничен', replaced.lines.length <= 400 && replaced.truncated === true);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
