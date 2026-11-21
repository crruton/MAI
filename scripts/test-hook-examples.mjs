/**
 * Хуки-примеры для правил проекта (CC3.4): examples/hooks/*.mjs через настоящий
 * исполнитель хуков, в настоящем git-репозитории.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHookRunner, normalizeHooks } from '../electron/lib/hooks.js';

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-hookex-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
git('init', '-q', '-b', 'main');
write('README.md', 'x');
git('add', '.');
git('commit', '-qm', 'init');

const script = (name) => JSON.stringify(path.join(root, 'examples', 'hooks', name));
const runner = createHookRunner({
  hooks: normalizeHooks({
    PreToolUse: [{ matcher: 'run_shell', hooks: [{ type: 'command', command: `node ${script('no-push-main.mjs')} main release`, timeout: 15 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `node ${script('require-docs.mjs')} electron renderer`, timeout: 30 }] }],
  }),
  projectDir: repo,
});
const push = (command) => runner.run('PreToolUse', { tool_name: 'run_shell', tool_input: { command } });

console.log('[1] no-push-main');
check('git push origin main — запрет', (await push('git push origin main')).decision === 'deny');
check('HEAD:main — запрет', (await push('git push -u origin HEAD:main')).decision === 'deny');
check('принудительно +main — запрет', (await push('git push --force origin +main')).decision === 'deny');
check('вторая защищённая ветка — запрет', (await push('npm test && git push origin release')).decision === 'deny');
const reason = (await push('git push origin main')).reason;
check('причина объясняет, что делать', /pull request/.test(reason), reason);
check('git push без ветки с main — запрет', (await push('git push')).decision === 'deny');
git('checkout', '-qb', 'dev');
check('git push без ветки с dev — можно', (await push('git push')).decision === null);
check('git push origin dev — можно', (await push('git push -u origin dev')).decision === null);
check('ветка с main в имени — можно', (await push('git push origin feature/main-menu')).decision === null);
check('git push в тексте команды — тоже запрет (с запасом)', (await push('echo git push origin main > note.txt')).decision === 'deny');
check('хук не срабатывает на другие инструменты', !runner.has('PreToolUse', 'write_file'));

console.log('[2] require-docs');
const stop = () => runner.run('Stop', { last_assistant_message: 'готово' });
check('нет изменений — принято', (await stop()).decision === null);
write('docs/notes.md', 'заметка');
check('только документы — принято', (await stop()).decision === null);
write('electron/lib/new.js', 'export {}');
const blocked = await stop();
check('код без CHANGELOG и ADR — не принято', blocked.decision === 'block' && /CHANGELOG/.test(blocked.reason) && /ADR/.test(blocked.reason), JSON.stringify(blocked));
check('в причине — изменённый файл', /electron\/lib\/new\.js/.test(blocked.reason), blocked.reason);
write('CHANGELOG.md', '## [Unreleased]');
const onlyChangelog = await stop();
check('есть CHANGELOG, нет ADR — не принято', onlyChangelog.decision === 'block' && !/CHANGELOG/.test(onlyChangelog.reason) && /ADR/.test(onlyChangelog.reason), JSON.stringify(onlyChangelog));
write('docs/adr/0099-test.md', '# 0099');
check('CHANGELOG и ADR — принято', (await stop()).decision === null);
git('add', '.');
git('commit', '-qm', 'all');
write('scripts/x.mjs', '1');
check('папки кода задаются аргументами (scripts не в списке)', (await stop()).decision === null);

console.log('[3] пример подключения');
const example = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'hooks', 'hooks.json'), 'utf8'));
const normalized = normalizeHooks(example);
check('hooks.json примера читается', normalized.PreToolUse?.[0]?.matcher === 'run_shell' && normalized.Stop?.length === 1);
const own = JSON.parse(fs.readFileSync(path.join(root, '.mai-code', 'hooks.json'), 'utf8'));
check('репозиторий MAI сам использует примеры', JSON.stringify(own) === JSON.stringify(example));

fs.rmSync(repo, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
