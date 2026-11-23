/**
 * Диагностика кода (CC1.11, ADR 0079): разбор вывода проверок и запуск без программ проекта.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTsc, parseEslint, parseRuff, parsePyright, parseNodeCheck, parsePyCompile, runDiagnostics, formatDiagnostics, detectCheckers } from '../electron/lib/diagnostics.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`);
  }
}
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-diag-')));

console.log('[1] разбор вывода');
const tsc = parseTsc("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(10,1): warning TS6133: 'x' is declared but never read.\n", dir);
check('tsc: файл, строка, колонка, код', tsc.length === 2 && tsc[0].file === path.join(dir, 'src', 'a.ts') && tsc[0].line === 3 && tsc[0].col === 7 && tsc[0].source === 'tsc TS2322' && tsc[1].severity === 'warning', JSON.stringify(tsc));
const es = parseEslint([{ filePath: '/p/a.js', messages: [{ line: 2, column: 5, severity: 2, ruleId: 'no-undef', message: "'x' is not defined." }, { line: 4, column: 1, severity: 1, ruleId: 'semi', message: 'Missing semicolon.' }] }]);
check('eslint: ошибка и предупреждение с правилом', es.length === 2 && es[0].severity === 'error' && es[0].source === 'eslint no-undef' && es[1].severity === 'warning');
const ruff = parseRuff([{ filename: '/p/a.py', code: 'F401', message: '`os` imported but unused', location: { row: 1, column: 8 } }]);
check('ruff', ruff[0].line === 1 && ruff[0].col === 8 && ruff[0].source === 'ruff F401');
const pr = parsePyright({ generalDiagnostics: [{ file: '/p/a.py', severity: 'error', message: 'x is not defined', rule: 'reportUndefinedVariable', range: { start: { line: 4, character: 2 } } }] });
check('pyright: строки с 1', pr[0].line === 5 && pr[0].col === 3 && pr[0].severity === 'error');
check('мусор на входе — пусто', parseEslint(null).length === 0 && parseRuff('x').length === 0 && parsePyright(null).length === 0);

console.log('[2] без программ проекта — синтаксис');
check('в пустой папке проверок проекта нет', detectCheckers(dir).filter((c) => c.id !== 'ruff' && c.id !== 'pyright').length === 0);
fs.writeFileSync(path.join(dir, 'bad.js'), 'const a = ;\n');
fs.writeFileSync(path.join(dir, 'good.js'), 'const a = 1;\n');
let r = await runDiagnostics(dir, { file: path.join(dir, 'bad.js') });
const viaRuff = detectCheckers(dir).some((c) => c.id === 'eslint');
check('JS с ошибкой: node --check, строка и SyntaxError', !viaRuff && r.checkers.includes('node --check') && r.items.length === 1 && r.items[0].line === 1 && /SyntaxError/.test(r.items[0].message), JSON.stringify(r));
r = await runDiagnostics(dir, { file: path.join(dir, 'good.js') });
check('JS без ошибок — «Ошибок нет»', /^Ошибок нет \(node --check\)/.test(formatDiagnostics(r, dir)), formatDiagnostics(r, dir));
const py = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['python3']).status === 0 || spawnSync(process.platform === 'win32' ? 'where' : 'which', ['python']).status === 0;
if (py && !detectCheckers(dir).some((c) => c.id === 'ruff' || c.id === 'pyright')) {
  fs.writeFileSync(path.join(dir, 'bad.py'), 'def f(:\n    pass\n');
  r = await runDiagnostics(dir, { file: path.join(dir, 'bad.py') });
  check('Python с ошибкой: py_compile', r.checkers.includes('py_compile') && r.items.length === 1 && /Error/.test(r.items[0].message), JSON.stringify(r));
} else {
  console.log('  —    python или ruff/pyright: проверка py_compile пропущена');
}
fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
r = await runDiagnostics(dir, { file: path.join(dir, 'notes.txt') });
check('неподдерживаемый файл — понятное «недоступна»', /Диагностика недоступна/.test(formatDiagnostics(r, dir)));
const text = formatDiagnostics({ checkers: ['tsc'], items: tsc }, dir);
check('формат: относительный путь, «ошибка/предупреждение», итог', /^Ошибок: 1, предупреждений: 1 \(tsc\)/.test(text) && /src\/a\.ts:3:7 ошибка \[tsc TS2322\]/.test(text), text);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
