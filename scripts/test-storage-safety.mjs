/**
 * Доски и артефакты: атомарная запись, версии, блокировка, GC (F9, F11, ADR 0062).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBoards, saveBoards, saveBoardSection } from '../electron/lib/boards.js';
import { applyDiagram, modelHash } from '../electron/lib/diagram-agent.js';
import { onArtifactWrite, writeArtifact, deleteArtifact, listArtifacts, gcBlobs, withIndexLock, artifactsRoot } from '../electron/lib/artifacts.js';

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
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-storage-'));

console.log('[1] доски');
const first = loadBoards(project);
first.delivery.tasks = [{ id: 't1', title: 'Задача' }];
saveBoards(project, first);
const second = loadBoards(project);
second.delivery.tasks[0].title = 'Задача (правка)';
const saved = saveBoards(project, second);
check('версия изменённой секции выросла, остальные — нет', saved.revs.delivery === 2 && saved.revs.runners === 1, JSON.stringify(saved.revs));
const winA = loadBoards(project);
const winB = loadBoards(project);
winA.delivery.tasks.push({ id: 't2', title: 'из окна A' });
const a = saveBoardSection(project, 'delivery', winA.delivery, winA.revs.delivery);
check('окно A сохранило', !a.conflict && a.revs.delivery === 3);
winB.delivery.tasks.push({ id: 't3', title: 'из окна B' });
const b = saveBoardSection(project, 'delivery', winB.delivery, winB.revs.delivery);
check('окно B со старой версией — конфликт и свежие данные', b.conflict === true && b.boards.delivery.tasks.some((t) => t.id === 't2') && !loadBoards(project).delivery.tasks.some((t) => t.id === 't3'));
const other = saveBoardSection(project, 'runners', { ...winB.runners, note: 'B' }, winB.revs.runners ?? 0);
check('другую секцию окно B сохраняет без конфликта', !other.conflict && other.runners.note === 'B' && other.delivery.tasks.some((t) => t.id === 't2'));
check('без rev (старое окно) — как раньше', !saveBoardSection(project, 'quality', { issues: [] }).conflict);
check('неизвестная секция — ошибка', (() => { try { saveBoardSection(project, 'evil', {}); return false; } catch { return true; } })());
check('временных файлов не осталось', !fs.readdirSync(path.join(project, '.mai-code')).some((f) => f.endsWith('.tmp')));

console.log('[2] артефакты: GC и блокировка');
const one = writeArtifact(project, { kind: 'note', name: 'Заметка', content: 'версия 1' });
writeArtifact(project, { id: one.id, kind: 'note', name: 'Заметка', content: 'версия 2' });
const keep = writeArtifact(project, { kind: 'note', name: 'Другая', content: 'оставить' });
const blobs = () => fs.readdirSync(path.join(artifactsRoot(project), 'blobs')).length;
check('три блоба', blobs() === 3);
fs.writeFileSync(path.join(artifactsRoot(project), 'blobs', 'deadbeef'), 'сирота');
check('GC удаляет только недостижимые', gcBlobs(project).removed === 1 && blobs() === 3);
deleteArtifact(project, one.id);
check('удаление артефакта убирает его блобы', blobs() === 1 && listArtifacts(project).length === 1 && listArtifacts(project)[0].id === keep.id);
const lock = path.join(artifactsRoot(project), 'index.lock');
fs.writeFileSync(lock, 'старая');
fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
check('зависшая блокировка снимается', writeArtifact(project, { kind: 'note', name: 'После', content: 'x' }).created === true && !fs.existsSync(lock));
check('вложенная блокировка не ждёт сама себя', withIndexLock(project, () => withIndexLock(project, () => 'ok')) === 'ok');

console.log('[3] два процесса под одной блокировкой');
const lockModule = fileURLToPath(new URL('../electron/lib/file-lock.js', import.meta.url)).replace(/\\/g, '/');
const counter = path.join(project, 'counter.json');
fs.writeFileSync(counter, JSON.stringify({ n: 0 }));
const worker = () =>
  new Promise((resolve) => {
    // Чтение-изменение-запись без блокировки потеряло бы обновления; с ней — 2 × 100.
    const code = `import('file:///${lockModule.replace(/^\//, '')}').then(({ withFileLock }) => { const fs = require('node:fs'); for (let i = 0; i < 100; i += 1) withFileLock(${JSON.stringify(counter + '.lock')}, () => { const d = JSON.parse(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); d.n += 1; fs.writeFileSync(${JSON.stringify(counter)}, JSON.stringify(d)); }); });`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (c) => resolve({ code: c, err }));
  });
const [r1, r2] = await Promise.all([worker(), worker()]);
check('оба процесса без ошибок', r1.code === 0 && r2.code === 0, r1.err + r2.err);
check('ни одно обновление не потеряно (200)', JSON.parse(fs.readFileSync(counter, 'utf8')).n === 200, fs.readFileSync(counter, 'utf8'));

console.log('[4] агент схем: изменения только по «Применить» (F10, ADR 0086)');
{
  const data = loadBoards(project);
  const before = JSON.parse(JSON.stringify(data.architecture?.model || {}));
  const base = modelHash(before);
  const sectionKey = Object.keys(before).find((k) => typeof before[k] === 'object') || 'containers';
  const proposal = { ...before, [sectionKey]: Array.isArray(before[sectionKey]) ? [...before[sectionKey], { id: 'redis', name: 'Redis' }] : { ...(before[sectionKey] || {}), redis: { name: 'Redis' } } };
  const res = applyDiagram({ projectDir: project, proposal, baseHash: base });
  check('применение с верным отпечатком — модель записана, схемы пересобраны', res.ok && JSON.stringify(loadBoards(project).architecture.model[sectionKey]).includes('Redis') && res.views?.views, JSON.stringify(Object.keys(res)));
  let err = '';
  try {
    applyDiagram({ projectDir: project, proposal: before, baseHash: base });
  } catch (e) {
    err = e.message;
  }
  check('модель изменилась после предложения — отказ', /Модель изменилась/.test(err), err);
  err = '';
  try {
    applyDiagram({ projectDir: project, proposal: { nope: 1 }, baseHash: modelHash(loadBoards(project).architecture.model) });
  } catch (e) {
    err = e.message;
  }
  check('пустая модель не применяется', /ни одного раздела/.test(err), err);
}

console.log('[5] запись артефакта → автосинхронизация (F12, ADR 0087)');
{
  const seen = [];
  const off = onArtifactWrite((projectDir, a) => seen.push(`${projectDir === project}:${a.id}`));
  writeArtifact(project, { kind: 'note', name: 'Синк', content: 'v1' });
  writeArtifact(project, { kind: 'note', name: 'Синк', content: 'v1' });
  writeArtifact(project, { kind: 'note', name: 'Синк', content: 'v2' });
  check('уведомление на новые версии, не на повтор', seen.length === 2 && seen.every((x) => x.startsWith('true:note:')), seen.join());
  off();
  writeArtifact(project, { kind: 'note', name: 'Синк', content: 'v3' });
  check('отписка работает', seen.length === 2);
  const off2 = onArtifactWrite(() => {
    throw new Error('слушатель упал');
  });
  let ok = true;
  try {
    writeArtifact(project, { kind: 'note', name: 'Синк', content: 'v4' });
  } catch {
    ok = false;
  }
  off2();
  check('упавший слушатель не ломает запись', ok);
}

fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
// Под Electron (boards/artifacts тянут config.js → electron).
if (globalThis.process?.versions?.electron) {
  const { app } = await import('electron');
  app.exit(fail ? 1 : 0);
} else process.exit(fail ? 1 : 0);
