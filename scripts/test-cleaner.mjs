/**
 * Чистильщик старых версий (N7, ADR 0103): стабильность версии, план, удаление
 * только из папки данных и временной папки.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackVersion, isStable, planCleanup, applyCleanup, formatBytes } from '../electron/lib/cleaner.js';

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
const DAY = 86_400_000;
const now = Date.parse('2026-11-23T12:00:00Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-cleaner-'));
const data = path.join(root, 'data');
const tmp = path.join(root, 'tmp');
const make = (p, days, content = 'x'.repeat(1000)) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = new Date(now - days * DAY);
  fs.utimesSync(p, t, t);
  return p;
};
const dir = (p, days) => {
  fs.mkdirSync(p, { recursive: true });
  const t = new Date(now - days * DAY);
  fs.utimesSync(p, t, t);
  return p;
};

console.log('[1] версия и стабильность');
let h = trackVersion(null, '0.2.0', now - 10 * DAY);
check('первая запись', h.current === '0.2.0' && h.previous === '');
check('та же версия — без изменений', trackVersion(h, '0.2.0', now) === h);
const h2 = trackVersion(h, '0.3.0', now - DAY);
check('новая версия — с момента смены, прежняя запомнена', h2.current === '0.3.0' && h2.previous === '0.2.0' && h2.since === new Date(now - DAY).toISOString());
check('стабильна через 3 дня', isStable(h, { now }) && !isStable(h2, { now }) && !isStable(null, { now }));

console.log('[2] план');
make(path.join(data, 'skills', '.previous', 'impeccable-4.8.1', 'SKILL.md'), 20);
dir(path.join(data, 'skills', '.previous', 'impeccable-4.8.1'), 20);
make(path.join(data, 'skills', '.previous', 'fresh-1.0', 'SKILL.md'), 2);
dir(path.join(data, 'skills', '.previous', 'fresh-1.0'), 2);
make(path.join(data, 'tool-output', 'old.txt'), 10);
make(path.join(data, 'tool-output', 'new.txt'), 1);
make(path.join(tmp, 'mai-previews', 'a.png'), 3);
dir(path.join(tmp, 'mai-previews'), 3);
make(path.join(tmp, 'mai-ocr-abc', 'x.json'), 2);
dir(path.join(tmp, 'mai-ocr-abc'), 2);
make(path.join(tmp, 'other-app', 'x'), 30);
dir(path.join(data, 'marketplaces', 'old-catalog'), 5);
dir(path.join(data, 'marketplaces', 'kept'), 5);
const wt = dir(path.join(data, 'worktrees', 'repo', 'wt-old'), 30);
let plan = planCleanup({ dataDir: data, tmpDir: tmp, history: h, marketplaces: [{ name: 'kept' }], worktrees: [{ dir: wt, branch: 'mai/wt-old' }], now });
const kinds = plan.items.map((i) => `${i.kind}:${path.basename(i.path)}`).sort();
check('в плане: старая копия навыка, старый вывод, временное MAI, чужой кеш, worktree', JSON.stringify(kinds) === JSON.stringify(['временное:mai-ocr-abc', 'временное:mai-previews', 'вывод:old.txt', 'кеш:old-catalog', 'навык:impeccable-4.8.1', 'рабочая копия:wt-old']), JSON.stringify(kinds));
check('не в плане: свежие копии и вывод, чужая временная папка, каталог из настроек', !plan.items.some((i) => /fresh-1.0|new.txt|other-app|kept/.test(i.path)));
check('worktree только показан', plan.items.find((i) => i.kind === 'рабочая копия').removable === false && /\/worktree/.test(plan.items.find((i) => i.kind === 'рабочая копия').reason));
check('размер и итог', plan.bytes >= 4000 && plan.items.find((i) => i.kind === 'навык').bytes === 1000, plan.bytes);
const unstable = planCleanup({ dataDir: data, tmpDir: tmp, history: h2, now });
check('версия не стабильна — старые копии навыков не трогаются, временное — да', !unstable.items.some((i) => i.kind === 'навык') && unstable.items.some((i) => i.kind === 'временное') && !unstable.stable);

console.log('[3] удаление');
const ids = plan.items.map((i) => i.id);
const forged = { items: [...plan.items, { id: 'evil', path: path.join(root, 'outside'), removable: true, bytes: 1 }] };
fs.mkdirSync(path.join(root, 'outside'));
const res = applyCleanup(forged, [...ids, 'evil'], { dataDir: data, tmpDir: tmp });
check('удалено пять, worktree и путь вне папок — пропущены', res.removed.length === 5 && res.skipped.length === 2 && fs.existsSync(path.join(root, 'outside')) && fs.existsSync(wt), JSON.stringify(res));
check('файлов больше нет, свежее на месте', !fs.existsSync(path.join(data, 'skills', '.previous', 'impeccable-4.8.1')) && fs.existsSync(path.join(data, 'skills', '.previous', 'fresh-1.0')) && fs.existsSync(path.join(data, 'tool-output', 'new.txt')) && fs.existsSync(path.join(tmp, 'other-app')));
check('только выбранное', applyCleanup(planCleanup({ dataDir: data, tmpDir: tmp, history: h, now }), [], { dataDir: data, tmpDir: tmp }).removed.length === 0);
check('размеры по-русски', formatBytes(512) === '512 Б' && formatBytes(1536) === '1,5 КБ' && formatBytes(150 * 1024 * 1024) === '150 МБ');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
