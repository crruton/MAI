/**
 * Multica: workspace и проект для папки проекта (E2.3, ADR 0112).
 * Без CLI и сервера: порядок уровней, доверие, аргументы CLI, запись настроек.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTarget, targetArgs, issueListArgs, issueCreateArgs, issueUpdateArgs,
  saveProjectTarget, normalizeWorkspaces, normalizeProjects, ID_RE,
} from '../electron/lib/multica-target.js';

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
function throws(fn, re) {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-multica-'));
const writeJson = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
};

console.log('[1] уровни настроек');
let t = resolveTarget({ projectDir: dir, trusted: true, user: { workspaceId: 'ws-user' } });
check('нет файлов проекта — настройки MAI', t.workspaceId === 'ws-user' && t.source.workspaceId === 'user' && t.projectId === '');
writeJson('.mai-code/settings.json', { permissions: { allow: ['read_file'] }, multica: { workspaceId: 'ws-team', projectId: 'pr-team' } });
t = resolveTarget({ projectDir: dir, trusted: true, user: { workspaceId: 'ws-user' } });
check('settings.json проекта сильнее настроек MAI', t.workspaceId === 'ws-team' && t.projectId === 'pr-team' && t.source.workspaceId === 'project');
writeJson('.mai-code/settings.local.json', { multica: { projectId: 'pr-mine' } });
t = resolveTarget({ projectDir: dir, trusted: true, user: {} });
check('личный файл перекрывает по ключу', t.workspaceId === 'ws-team' && t.projectId === 'pr-mine' && t.source.projectId === 'local' && t.source.workspaceId === 'project');
t = resolveTarget({ projectDir: dir, trusted: false, user: { workspaceId: 'ws-user' } });
check('недоверенная папка: файлы проекта не читаются (ADR 0028)', t.workspaceId === 'ws-user' && t.projectId === '');
writeJson('.mai-code/settings.json', { multica: { workspaceId: '--server-url=http://evil' } });
check('id-флаг в файле проекта — ошибка, не аргумент CLI', throws(() => resolveTarget({ projectDir: dir, trusted: true }), /workspaceId: ожидается id/));
fs.rmSync(path.join(dir, '.mai-code'), { recursive: true, force: true });

console.log('[2] аргументы CLI');
const target = { workspaceId: '8a4f83ea-fec0-4af5-b6ec-6e3755dfd9de', projectId: 'pr-1' };
check('глобальный --workspace-id первым', JSON.stringify(targetArgs(target)) === '["--workspace-id","8a4f83ea-fec0-4af5-b6ec-6e3755dfd9de"]');
check('без workspace — без флага', targetArgs({}).length === 0);
check('issue list с проектом', JSON.stringify(issueListArgs(50, target)) === JSON.stringify(['--workspace-id', target.workspaceId, 'issue', 'list', '--output', 'json', '--limit', '50', '--project', 'pr-1']));
check('issue list без цели — как раньше', JSON.stringify(issueListArgs(30)) === '["issue","list","--output","json","--limit","30"]');
const create = issueCreateArgs({ title: 'T', description: 'Описание\nс маркером' }, target);
check('issue create: проект и кириллица одним аргументом', create.at(-1) === 'pr-1' && create.includes('Описание\nс маркером') && create[0] === '--workspace-id');
const update = issueUpdateArgs('MAI-7', { title: 'T', description: 'D' }, target);
check('issue update: workspace, без --project', update[0] === '--workspace-id' && !update.includes('--project') && update.includes('MAI-7'));
check('slug и UUID проходят, флаг и пробел — нет', ID_RE.test('team-ws') && ID_RE.test(target.workspaceId) && !ID_RE.test('-x') && !ID_RE.test('a b'));
check('плохой projectId в create — ошибка', throws(() => issueCreateArgs({ title: 'T', description: 'D' }, { projectId: '--status=done' }), /projectId/));

console.log('[3] запись настроек проекта');
writeJson('.mai-code/settings.json', { permissions: { deny: ['run_shell(rm *)'] } });
let res = saveProjectTarget(dir, { workspaceId: 'ws-team', projectId: 'pr-1' });
let saved = JSON.parse(fs.readFileSync(path.join(dir, '.mai-code', 'settings.json'), 'utf8'));
check('scope project → settings.json, прочие ключи целы', res.ok && saved.multica.workspaceId === 'ws-team' && saved.multica.projectId === 'pr-1' && saved.permissions.deny[0] === 'run_shell(rm *)');
saveProjectTarget(dir, { workspaceId: 'ws-own' }, { scope: 'local' });
const local = JSON.parse(fs.readFileSync(path.join(dir, '.mai-code', 'settings.local.json'), 'utf8'));
check('scope local → settings.local.json', local.multica.workspaceId === 'ws-own' && !local.multica.projectId);
check('settings.local.json добавлен в .mai-code/.gitignore', fs.readFileSync(path.join(dir, '.mai-code', '.gitignore'), 'utf8').includes('settings.local.json'));
check('после записи уровни читаются', resolveTarget({ projectDir: dir, trusted: true }).workspaceId === 'ws-own');
saveProjectTarget(dir, { workspaceId: '', projectId: '' });
saved = JSON.parse(fs.readFileSync(path.join(dir, '.mai-code', 'settings.json'), 'utf8'));
check('пустые значения убирают блок multica', !('multica' in saved) && saved.permissions);
check('неверный scope — ошибка', throws(() => saveProjectTarget(dir, {}, { scope: 'user' }), /scope/));
check('без папки — ошибка', throws(() => saveProjectTarget('', {}), /папка/));
check('флаг вместо id — ошибка', throws(() => saveProjectTarget(dir, { workspaceId: '--x' }), /workspaceId/));

console.log('[4] разбор ответов CLI');
check('workspace: массив', normalizeWorkspaces([{ id: 'w1', name: 'A', slug: 'a' }])[0].name === 'A');
check('workspace: объект со списком, без id отбрасывается', normalizeWorkspaces({ workspaces: [{ id: 'w1', slug: 's' }, { name: 'x' }] }).length === 1);
check('проекты: title → name', normalizeProjects({ projects: [{ id: 'p1', title: 'MAI', status: 'planned' }] })[0].name === 'MAI');
check('мусор — пустой список', normalizeProjects('oops').length === 0 && normalizeWorkspaces(null).length === 0);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nmultica-target: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
