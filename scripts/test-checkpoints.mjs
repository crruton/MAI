/**
 * Чекпоинты правок и откат (CC6.1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecorder, rewindPlan, rewindFiles, checkpointTurns, removeCheckpoints } from '../electron/lib/checkpoints.js';

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

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cp-data-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cp-proj-'));
const a = path.join(project, 'a.txt');
const b = path.join(project, 'src', 'b.txt');
fs.writeFileSync(a, 'v0', 'utf8');
const rec = createRecorder({ dataDir: data, sessionId: 's1', projectDir: project });
const write = (file, text, turn) => {
  rec.record(file, turn);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};

console.log('\n[1] Запись чекпоинтов');
write(a, 'v1', 0);
write(a, 'v2', 0); // второй раз в том же ходе — исходное v0 не перезаписывается
write(b, 'новый', 0); // файла не было
write(a, 'v3', 4);
check('два хода с правками', JSON.stringify(checkpointTurns(data, 's1').map((t) => t.turn)) === '[0,4]');
check('в ходе 0 два файла', checkpointTurns(data, 's1')[0].files === 2);

console.log('\n[2] План отката');
const plan4 = rewindPlan(data, 's1', 4);
check('к ходу 4: вернуть a.txt (v2)', plan4.length === 1 && plan4[0].action === 'restore' && plan4[0].file === a);
const plan0 = rewindPlan(data, 's1', 0);
check('к ходу 0: a — вернуть, b — удалить', plan0.find((p) => p.file === a)?.action === 'restore' && plan0.find((p) => p.file === b)?.action === 'delete');
check('изменения с тех пор видны', plan0.every((p) => p.changed));

console.log('\n[3] Откат к ходу 4');
const r4 = rewindFiles(data, 's1', 4);
check('a.txt вернулся к v2', fs.readFileSync(a, 'utf8') === 'v2', fs.readFileSync(a, 'utf8'));
check('b.txt не тронут', fs.readFileSync(b, 'utf8') === 'новый');
check('чекпоинт хода 4 забыт', JSON.stringify(checkpointTurns(data, 's1').map((t) => t.turn)) === '[0]');
check('отчёт о возвращённых', r4.restored.length === 1 && !r4.failed.length);

console.log('\n[4] Откат к ходу 0: самое раннее состояние');
const r0 = rewindFiles(data, 's1', 0);
check('a.txt — исходное v0', fs.readFileSync(a, 'utf8') === 'v0');
check('b.txt удалён — его не было', !fs.existsSync(b));
check('чекпоинтов не осталось', checkpointTurns(data, 's1').length === 0 && r0.restored.length === 2);
check('план после отката пуст', rewindPlan(data, 's1', 0).length === 0);

console.log('\n[5] Большие файлы и удаление');
const big = path.join(project, 'big.bin');
fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024));
const rec2 = createRecorder({ dataDir: data, sessionId: 's2', projectDir: project });
rec2.record(big, 0);
check('файл больше 5 МБ отмечен как пропущенный', rewindPlan(data, 's2', 0)[0]?.action === 'skip');
check('неверный ход не записывается', (rec2.record(a, -1), checkpointTurns(data, 's2').length === 1));
removeCheckpoints(data, 's2');
check('удаление чата удаляет чекпоинты', checkpointTurns(data, 's2').length === 0);
const blobs = fs.readdirSync(path.join(data, 'checkpoints', 'blobs'));
check('одинаковое содержимое хранится один раз', blobs.length <= 3, String(blobs.length));

fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
