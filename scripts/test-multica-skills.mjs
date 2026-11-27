/**
 * Навыки каталога → Multica (E1.8, ADR 0113): поддельный CLI с состоянием в памяти.
 * Проверяется план, идемпотентность, чужие навыки, prune, dry-run и файлы навыков.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushSkills, collectCatalogSkills, planSkillPush, normalizeRemoteSkills, parseCliJson, MANAGED_BY } from '../electron/lib/multica-skills.js';

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
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOTAL = JSON.parse(fs.readFileSync(path.join(repo, 'mai-marketplace.json'), 'utf8')).packages.length;
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

/** Поддельный `multica`: skill list/get/create/update/delete, skill files upsert. */
function fakeServer({ listWithoutConfig = false, prefix = '' } = {}) {
  const skills = new Map();
  const calls = [];
  let seq = 0;
  const opt = (args, name) => args[args.indexOf(name) + 1];
  const run = (args, { cwd } = {}) => {
    const fileArg = args.includes('--content-file') ? args[args.indexOf('--content-file') + 1] : '';
    calls.push({ args, cwd, fileExists: fileArg ? fs.existsSync(path.join(cwd, fileArg)) : null, lf: fileArg ? !fs.readFileSync(path.join(cwd, fileArg), 'utf8').includes(CR) : null });
    let a = args;
    if (a[0] === '--workspace-id') a = a.slice(2);
    const [, cmd] = a;
    const read = (file) => fs.readFileSync(path.join(cwd, file), 'utf8');
    if (cmd === 'list') return prefix + JSON.stringify([...skills.values()].map((s) => (listWithoutConfig ? { id: s.id, name: s.name } : s)));
    if (cmd === 'get') return JSON.stringify(skills.get(a[2]));
    if (cmd === 'create') {
      const id = `sk-${++seq}`;
      skills.set(id, { id, name: opt(a, '--name'), description: opt(a, '--description'), content: read(opt(a, '--content-file')), config: JSON.parse(opt(a, '--config')), files: {} });
      return prefix + JSON.stringify({ id });
    }
    if (cmd === 'update') {
      const s = skills.get(a[2]);
      Object.assign(s, { description: opt(a, '--description'), content: read(opt(a, '--content-file')), config: JSON.parse(opt(a, '--config')) });
      return JSON.stringify({ id: s.id });
    }
    if (cmd === 'delete') {
      skills.delete(a[2]);
      return '';
    }
    if (cmd === 'files' && a[2] === 'upsert') {
      skills.get(a[3]).files[opt(a, '--path')] = read(opt(a, '--content-file'));
      return '{}';
    }
    throw new Error(`неизвестная команда ${a.join(' ')}`);
  };
  return { run, skills, calls, writes: () => calls.filter((c) => !/ (list|get) /.test(` ${c.args.join(' ')} `)).length };
}

console.log('[1] навыки каталога');
const all = collectCatalogSkills(repo);
check('все навыки каталога с версией и хэшем', all.length === TOTAL && all.every((s) => /^[0-9]+[.][0-9]+[.][0-9]+$/.test(s.version) && /^[0-9a-f]{16}$/.test(s.hash)));
const stop = all.find((s) => s.name === 'stop-slop');
check('файлы навыка с путями через /', stop.files.some((f) => f.path === 'references/phrases.md') && stop.files.some((f) => f.path === 'LICENSE'));
check('выбор по именам', collectCatalogSkills(repo, ['tdd', 'grilling']).map((s) => s.name).sort().join() === 'grilling,tdd');
let err = '';
try {
  collectCatalogSkills(repo, ['nope']);
} catch (e) {
  err = e.message;
}
check('неизвестное имя — ошибка', /Нет в каталоге: nope/.test(err));

console.log('[2] первая отдача и повтор');
let srv = fakeServer();
let r = pushSkills({ root: repo, run: srv.run, target: { workspaceId: 'ws-team' } });
check('создано столько, сколько в каталоге', r.created === TOTAL && srv.skills.size === TOTAL, r.message);
const tdd = [...srv.skills.values()].find((s) => s.name === 'tdd');
check('содержимое, описание и config с меткой', tdd.content.startsWith('---\nname: tdd') && tdd.description && tdd.config.managed_by === MANAGED_BY && tdd.config.version === '1.0.0' && tdd.config.hash);
check('файлы навыка загружены', Object.keys(tdd.files).sort().join() === ['LICENSE', 'UPSTREAM.md', 'mocking.md', 'tests.md'].sort().join(), Object.keys(tdd.files).join());
check('workspace в каждом вызове', srv.calls.every((c) => c.args[0] === '--workspace-id' && c.args[1] === 'ws-team'));
const uploads = srv.calls.filter((c) => c.fileExists !== null);
check('файлы читаются из временной копии (cwd) и только с LF', uploads.length > TOTAL && uploads.every((c) => c.fileExists && c.lf));
check('временные копии удалены', uploads.every((c) => !fs.existsSync(c.cwd)));
const before = srv.writes();
r = pushSkills({ root: repo, run: srv.run });
check('повтор: без изменений, ни одной записи', r.unchanged === TOTAL && r.created === 0 && srv.writes() === before, r.message);

console.log('[3] обновление, чужие навыки, prune');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skills-'));
fs.cpSync(path.join(repo, 'mai-marketplace.json'), path.join(tmp, 'mai-marketplace.json'));
fs.cpSync(path.join(repo, 'catalog'), path.join(tmp, 'catalog'), { recursive: true });
const tddFile = path.join(tmp, 'catalog', 'tdd', 'skills', 'tdd', 'SKILL.md');
fs.writeFileSync(tddFile, fs.readFileSync(tddFile, 'utf8').replace('version: 1.0.0', 'version: 1.1.0') + '\nНовый раздел.\n');
r = pushSkills({ root: tmp, run: srv.run });
check('правка навыка → update только его', r.updated === 1 && r.unchanged === TOTAL - 1 && r.actions.find((a) => a.action === 'update').name === 'tdd', r.message);
check('в Multica новая версия и текст', tdd.config.version === '1.1.0' && tdd.content.includes('Новый раздел.'));
srv.skills.set('manual-1', { id: 'manual-1', name: 'debug-copy', config: {} });
const own = [...srv.skills.values()].find((s) => s.name === 'debug');
own.config = { note: 'создан руками' };
r = pushSkills({ root: tmp, run: srv.run });
check('навык с тем же именем без метки — conflict, не перезаписан', r.conflicts === 1 && r.actions.find((a) => a.action === 'conflict').name === 'debug' && own.config.note === 'создан руками', r.message);
fs.rmSync(path.join(tmp, 'catalog', 'ub-mode'), { recursive: true });
const idx = JSON.parse(fs.readFileSync(path.join(tmp, 'mai-marketplace.json'), 'utf8'));
idx.packages = idx.packages.filter((p) => p.name !== 'ub-mode');
fs.writeFileSync(path.join(tmp, 'mai-marketplace.json'), JSON.stringify(idx));
r = pushSkills({ root: tmp, run: srv.run });
check('без prune пропавший навык остаётся', r.deleted === 0 && [...srv.skills.values()].some((s) => s.name === 'ub-mode'));
r = pushSkills({ root: tmp, run: srv.run, names: ['tdd'], prune: true });
check('prune с выбором имён ничего не удаляет', r.deleted === 0 && [...srv.skills.values()].some((s) => s.name === 'ub-mode'));
r = pushSkills({ root: tmp, run: srv.run, prune: true });
check('prune удаляет только свой пропавший навык', r.deleted === 1 && ![...srv.skills.values()].some((s) => s.name === 'ub-mode') && srv.skills.has('manual-1'), r.message);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('[3b] концы строк');
const crlf = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-skills-crlf-'));
fs.cpSync(path.join(repo, 'mai-marketplace.json'), path.join(crlf, 'mai-marketplace.json'));
fs.cpSync(path.join(repo, 'catalog'), path.join(crlf, 'catalog'), { recursive: true });
const lfFile = path.join(crlf, 'catalog', 'grilling', 'skills', 'grilling', 'SKILL.md');
const raw = fs.readFileSync(lfFile, 'utf8').split(CR + LF).join(LF);
fs.writeFileSync(lfFile, raw);
const hLf = collectCatalogSkills(crlf, ['grilling'])[0].hash;
fs.writeFileSync(lfFile, raw.split(LF).join(CR + LF));
const hCrlf = collectCatalogSkills(crlf, ['grilling'])[0].hash;
check('хэш не зависит от CRLF/LF (Windows и Linux дают одно и то же)', hLf === hCrlf);
fs.rmSync(crlf, { recursive: true, force: true });

console.log('[4] dry-run и форматы ответа');
srv = fakeServer();
r = pushSkills({ root: repo, run: srv.run, dryRun: true });
check('dry-run: план без записей', r.dryRun && r.created === TOTAL && srv.writes() === 0 && /^План/.test(r.message));
srv = fakeServer({ listWithoutConfig: true, prefix: 'Using workspace ws\n' });
pushSkills({ root: repo, run: srv.run, names: ['grilling'] });
r = pushSkills({ root: repo, run: srv.run, names: ['grilling'] });
check('list без config → config из skill get; текст до JSON отброшен', r.unchanged === 1 && srv.calls.some((c) => c.args.includes('get')), r.message);
check('parseCliJson: префикс и пусто', parseCliJson('warn\n[1]', []).length === 1 && parseCliJson('', 'x') === 'x');
check('config строкой JSON разбирается', normalizeRemoteSkills([{ id: '1', name: 'a', config: '{"managed_by":"mai-code"}' }])[0].config.managed_by === 'mai-code');
check('план: чужой навык без config — conflict', planSkillPush([{ name: 'a', hash: 'h', version: '1' }], [{ id: '1', name: 'a', config: {} }])[0].action === 'conflict');

console.log(`\nmultica-skills: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
