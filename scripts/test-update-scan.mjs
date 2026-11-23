/**
 * Сканер обновлений (N6, ADR 0102): прыжки версий, разбор npm outdated / audit /
 * ls, навыки, CLI и приложение, полный скан, расписание, аргументы установки.
 */
import { bumpKind, parseOutdated, parseAudit, parseLsProblems, skillUpdates, toolUpdates, scanUpdates, scanDue, installArgs } from '../electron/lib/update-scan.js';

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

console.log('[1] версии');
check('major / minor / patch / same / unknown', bumpKind('1.2.3', '2.0.0') === 'major' && bumpKind('1.2.3', '1.3.0') === 'minor' && bumpKind('1.2.3', '1.2.4') === 'patch' && bumpKind('1.2.3', '1.2.3') === 'same' && bumpKind('', '1.0.0') === 'unknown' && bumpKind('v4.8.1', '4.10.0') === 'minor');

console.log('[2] npm');
const outdated = parseOutdated({ electron: { current: '38.8.6', wanted: '38.9.0', latest: '39.1.0' }, openai: { current: '5.1.0', wanted: '5.3.0', latest: '5.3.0' }, 'pdf-lib': { current: '1.17.1', wanted: '1.17.1', latest: '1.17.2' }, ghost: { wanted: '1.0.0', latest: '1.0.0' } });
const by = Object.fromEntries(outdated.map((i) => [i.name, i]));
check('риск: major — high, minor — medium, patch — low, не установлен — info', by.electron.risk === 'high' && by.openai.risk === 'medium' && by['pdf-lib'].risk === 'low' && by.ghost.risk === 'info', JSON.stringify(outdated.map((i) => `${i.name}:${i.risk}`)));
check('пояснения', /мажорная/.test(by.electron.note) && /не установлен/.test(by.ghost.note));
const audit = parseAudit({ vulnerabilities: { tar: { severity: 'high', via: [{ title: 'Arbitrary file overwrite' }], fixAvailable: true }, glob: { severity: 'moderate', via: ['minimatch'], fixAvailable: { name: 'glob', version: '10.0.0', isSemVerMajor: true } }, x: { severity: 'low', via: [], fixAvailable: false } } });
check('уязвимости: риск по серьёзности и исправление', audit.find((a) => a.name === 'tar').risk === 'high' && /npm audit fix/.test(audit.find((a) => a.name === 'tar').note) && /мажорное/.test(audit.find((a) => a.name === 'glob').note) && /исправления нет/.test(audit.find((a) => a.name === 'x').note));
const conflicts = parseLsProblems({ problems: ['invalid: react@17.0.2 /app/node_modules/react', 'peer dep missing: react@^18, required by react-dom@18.2.0', 'extraneous: left-pad@1.3.0'] });
check('конфликты: invalid и peer — high, extraneous — medium', conflicts.length === 3 && conflicts[0].risk === 'high' && conflicts[1].risk === 'high' && conflicts[2].risk === 'medium' && conflicts[0].name === 'react@17.0.2', JSON.stringify(conflicts));

console.log('[3] навыки, CLI, приложение');
const sk = skillUpdates([{ name: 'impeccable', bundled: '4.10.0', installed: '4.8.1' }, { name: 'handoff', bundled: '', installed: '' }, { name: 'x', bundled: '1.0', installed: '1.0' }]);
check('навык новее — обновление low; без версии и равные — нет', sk.length === 1 && sk[0].name === 'impeccable' && sk[0].risk === 'low');
const tools = toolUpdates([{ name: 'repowise', current: '0.60.0', latest: '0.62.1' }, { name: 'gh', current: '2.60.0', latest: '2.60.0' }, { source: 'приложение', name: 'MAI Code', current: '0.2.0', latest: '1.0.0' }]);
check('CLI minor — medium; равные — нет; приложение major — high', tools.length === 2 && tools[0].risk === 'medium' && tools[1].risk === 'high' && tools[1].source === 'приложение');

console.log('[4] полный скан');
const calls = [];
const run = (cmd, args) => {
  calls.push(`${cmd} ${args.join(' ')}`);
  if (cmd === 'npm' && args[0] === 'outdated') return { code: 1, stdout: JSON.stringify({ electron: { current: '38.0.0', wanted: '38.0.0', latest: '39.0.0' } }) };
  if (cmd === 'npm' && args[0] === 'audit') return { code: 1, stdout: JSON.stringify({ vulnerabilities: { tar: { severity: 'critical', via: [], fixAvailable: true } } }) };
  if (cmd === 'npm' && args[0] === 'ls') return { code: 0, stdout: '{}' };
  if (cmd === 'repowise') return { code: 0, stdout: 'repowise 0.60.0' };
  if (cmd === 'gh') return { code: 1, stdout: '' };
  return { code: 1, stdout: '' };
};
const fetchJson = async (url) => {
  if (url.includes('pypi')) return { info: { version: '0.61.0' } };
  if (url.includes('crruton/MAI')) throw new Error('HTTP 404');
  return {};
};
const report = await scanUpdates({ projectDir: '/p', hasPackageJson: true, appVersion: '0.2.0', skills: [{ name: 'impeccable', bundled: '4.10.0', installed: '4.8.1' }], run, fetchJson, now: () => new Date('2026-11-23T10:00:00Z') });
check('npm outdated, audit, ls; repowise; gh не установлен — без сети', calls.join('|') === 'npm outdated --json --long|npm audit --json|npm ls --json --all|repowise --version|gh --version', calls.join('|'));
check('сначала высокий риск, счётчики', report.items[0].risk === 'high' && report.counts.high === 2 && report.counts.medium === 1 && report.counts.low === 1, JSON.stringify(report.counts));
check('сетевая ошибка — в errors, скан не падает', report.errors.some((e) => /релизы MAI Code: HTTP 404/.test(e)) && report.at === '2026-11-23T10:00:00.000Z');
const noNpm = await scanUpdates({ projectDir: '/p', hasPackageJson: false, run: (c, a) => (calls.push(`x ${c}`), { code: 1, stdout: '' }), fetchJson });
check('без package.json — npm не вызывается', noNpm.items.length === 0 && !calls.slice(5).some((c) => /npm/.test(c)));

console.log('[5] расписание и установка');
check('раз в сутки', scanDue('', {}) && scanDue('2026-11-22T09:00:00Z', { now: Date.parse('2026-11-23T10:00:00Z') }) && !scanDue('2026-11-23T09:00:00Z', { now: Date.parse('2026-11-23T10:00:00Z') }));
check('npm install: имя@версия, scoped', installArgs([{ name: 'electron', version: '39.0.0' }, { name: '@modelcontextprotocol/sdk', version: '1.20.0' }]).join(' ') === 'install electron@39.0.0 @modelcontextprotocol/sdk@1.20.0');
let err = '';
try {
  installArgs([{ name: 'x; rm -rf /', version: '1' }, { name: 'ok', version: '1.0.0 && echo' }]);
} catch (e) {
  err = e.message;
}
check('опасные имена и версии отбрасываются', /Нечего обновлять/.test(err), err);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
