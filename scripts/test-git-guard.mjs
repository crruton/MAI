/**
 * Защита веток (CC11.6, ADR 0059).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushViolation, currentBranch } from '../electron/lib/git-guard.js';
import { shellTools } from '../electron/lib/tools/shell.js';
import { toolEntry, runToolCall } from '../electron/lib/tool-runner.js';

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
const v = (cmd, branch = 'dev', list) => pushViolation(cmd, { branchOf: () => branch, ...(list ? { protectedBranches: list } : {}) });
console.log('[1] разбор');
check('git push origin main — запрет', /main/.test(v('git push origin main')));
check('HEAD:main, +main, refs/heads/master', Boolean(v('git push origin HEAD:main') && v('git push -f origin +main') && v('git push origin refs/heads/master')));
check('в составной команде', Boolean(v('npm test && git push origin main')));
check('удаление защищённой ветки', Boolean(v('git push origin --delete main')));
check('--all и --mirror', Boolean(v('git push --all origin') && v('git push --mirror')));
check('git push без ветки из main — запрет, из dev — можно', Boolean(v('git push', 'main')) && v('git push', 'dev') === null);
check('dev, feature/main-menu — можно', v('git push -u origin dev') === null && v('git push origin feature/main-menu') === null);
check('свой список веток', Boolean(v('git push origin release', 'dev', ['release'])) && v('git push origin main', 'dev', ['release']) === null);
check('пустой список — защита выключена', v('git push origin main', 'main', []) === null);
check('не git push — не трогает', v('git pull origin main') === null && v('echo push main') === null);

console.log('[2] в цикле решений: запрет даже в «Без вопросов»');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-gitguard-'));
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'a'), '1');
git('add', '.');
git('commit', '-qm', 'x');
check('текущая ветка', currentBranch(repo) === 'main');
const entry = toolEntry(shellTools[0].schema, { source: 'builtin', run: async () => 'ВЫПОЛНЕНО' });
const run = (command, rules = {}, ctx = {}) => runToolCall({ entry, args: { command }, ctx: { projectDir: repo, ...ctx }, policy: { getMode: () => 'bypass', getRules: () => rules } });
let out = await run('git push');
check('«Без вопросов»: git push из main — запрет с объяснением', out.ok === false && /защищённой ветки main/.test(out.content) && !/ВЫПОЛНЕНО/.test(out.content), out.content);
out = await run('git push origin main', { allow: ['run_shell(git push*)'] });
check('правило allow не снимает защиту', out.ok === false && /защищённую ветку main/.test(out.content));
git('checkout', '-qb', 'dev');
check('из dev — выполняется', /ВЫПОЛНЕНО/.test((await run('git push -u origin dev')).content));
check('выключенная защита — выполняется', /ВЫПОЛНЕНО/.test((await run('git push origin main', {}, { protectedBranches: [] })).content));
fs.rmSync(repo, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
