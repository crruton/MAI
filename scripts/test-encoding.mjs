/**
 * Вывод консоли Windows: UTF-8, cp866 (OEM), cp1251 (ANSI).
 */
import { createOutputDecoder, withUtf8Console } from '../electron/lib/encoding.js';

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

// «живой текст» в разных кодировках.
const cp866 = Buffer.from([0xa6, 0xa8, 0xa2, 0xae, 0xa9, 0x20, 0xe2, 0xa5, 0xaa, 0xe1, 0xe2]);
const cp1251 = Buffer.from([0xe6, 0xe8, 0xe2, 0xee, 0xe9, 0x20, 0xf2, 0xe5, 0xea, 0xf1, 0xf2]);
const utf8 = Buffer.from('живой текст', 'utf8');

const win = () => createOutputDecoder({ platform: 'win32' });
check('UTF-8 читается как есть', win()(utf8) === 'живой текст');
check('cp866 (cmd, русская Windows) → кириллица', win()(cp866) === 'живой текст', win()(cp866));
check('cp1251 (ANSI-программы) → кириллица', win()(cp1251) === 'живой текст', win()(cp1251));
const split = win();
const cut = Buffer.from('привет', 'utf8');
check('UTF-8, разрезанный посреди буквы, собирается', split(cut.subarray(0, 3)) + split(cut.subarray(3)) === 'привет');
check('ASCII не меняется', win()(Buffer.from('npm test: ok')) === 'npm test: ok');
check('на Linux — обычный UTF-8', createOutputDecoder({ platform: 'linux' })(utf8) === 'живой текст');
check('Windows: chcp, затем вложенный cmd', withUtf8Console('dir & echo "x"', 'win32') === 'chcp 65001 >nul & cmd /d /s /c "dir & echo "x""');
check('на Linux команда не меняется', withUtf8Console('ls', 'linux') === 'ls');

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
