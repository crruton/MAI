/**
 * removeTree (ADR 0104): папка с файлами «только для чтения» (как .git/objects)
 * удаляется и на Windows, где rmSync Node 24 такие файлы не берёт.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTree } from '../electron/lib/remove-tree.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-rmtree-'));
  const obj = path.join(dir, '.git', 'objects', 'ab');
  fs.mkdirSync(obj, { recursive: true });
  const file = path.join(obj, 'cdef');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o444);
  return { dir, file };
};
let t = make();
removeTree(t.dir, { platform: 'win32' });
check('путь Windows: снятие «только чтение» и удаление', !fs.existsSync(t.dir));
t = make();
removeTree(t.dir);
check('на этой ОС — тоже удалено', !fs.existsSync(t.dir));
let ok = true;
try {
  removeTree(path.join(os.tmpdir(), 'mai-rmtree-нет-такой'));
  removeTree('');
} catch {
  ok = false;
}
check('нет папки или пустой путь — без ошибки', ok);
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
