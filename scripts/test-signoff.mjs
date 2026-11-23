/**
 * Signoff (N1, ADR 0097): контекст, аргументы, состояние git, тесты, статус.
 * Настоящий git-репозиторий; GitHub — поддельный post.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { statusContext, parseSignoffArgs, parseGithubRemote, testCommandFor, detailsUrl, runSignoff } from '../electron/lib/signoff.js';

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

console.log('[1] разбор');
check('контекст: пусто → signoff, ci → signoff/ci', statusContext('') === 'signoff' && statusContext('ci') === 'signoff/ci');
let err = '';
try {
  statusContext('a b/../x');
} catch (e) {
  err = e.message;
}
check('недопустимый контекст — ошибка', /латиница/.test(err));
check('аргументы: «fail lint», «ci», пусто', JSON.stringify(parseSignoffArgs('fail lint')) === '{"fail":true,"context":"lint"}' && JSON.stringify(parseSignoffArgs('ci')) === '{"fail":false,"context":"ci"}' && JSON.stringify(parseSignoffArgs('')) === '{"fail":false,"context":""}');
check('GitHub https и ssh; не GitHub — null', JSON.stringify(parseGithubRemote('https://github.com/acme/demo.git')) === '{"owner":"acme","repo":"demo"}' && parseGithubRemote('git@github.com:acme/demo.git')?.repo === 'demo' && parseGithubRemote('https://gitlab.com/a/b.git') === null);
check('Details: шаблон и только http(s)', detailsUrl('https://ci.example/{owner}/{repo}/{sha}?c={context}', { owner: 'a', repo: 'b', sha: 'f00', context: 'signoff/ci' }) === 'https://ci.example/a/b/f00?c=signoff%2Fci' && detailsUrl('javascript:alert(1)', {}) === '' && detailsUrl('', {}) === '');

console.log('[2] команда тестов');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-signoff-'));
check('нет package.json — пусто', testCommandFor(dir, {}) === '');
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
check('заглушка npm init — не тесты', testCommandFor(dir, {}) === '');
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node t.js' } }));
check('scripts.test → npm test; своя команда сильнее', testCommandFor(dir, {}) === 'npm test' && testCommandFor(dir, { signoff: { testCommand: 'make check' } }) === 'make check');

console.log('[3] прогон');
const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@example.com');
g('config', 'user.name', 'T');
g('add', '.');
g('commit', '-q', '-m', 'init');
const git = (args) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '' };
};
const posts = [];
const post = async (s) => (posts.push(s), { ok: true });
let execs = 0;
const exec = (code) => async (command) => (execs++, { code, output: code ? 'FAIL test 3' : 'ok', ms: 2100, command });

let r = await runSignoff({ projectDir: dir, git, exec: exec(0), post });
check('нет remote — не GitHub', !r.ok && /не GitHub/.test(r.error), r.error);
g('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
r = await runSignoff({ projectDir: dir, git, exec: exec(0), post });
check('не запушен — «сначала git push», тесты не запускались', !r.ok && /не запушен/.test(r.error) && execs === 0, r.error);
// «Запушено»: ветка origin/main указывает на HEAD.
g('update-ref', 'refs/remotes/origin/main', 'HEAD');
g('branch', '--set-upstream-to=origin/main');
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo2', scripts: { test: 'node t.js' } }));
r = await runSignoff({ projectDir: dir, git, exec: exec(0), post });
check('незакоммиченные правки — отказ', !r.ok && /незакоммиченные/.test(r.error), r.error);
g('checkout', '-q', '--', 'package.json');
r = await runSignoff({ projectDir: dir, git, exec: exec(1), post });
check('тесты упали — статус не ставится, вывод в результате', !r.ok && r.testsFailed && /FAIL test 3/.test(r.output) && posts.length === 0, JSON.stringify(r));
const sha = git(['rev-parse', 'HEAD']).stdout.trim();
r = await runSignoff({ projectDir: dir, context: 'ci', git, exec: exec(0), post, settings: { signoff: { detailsUrl: 'https://ci.example/{sha}' } } });
check('успех: success signoff/ci на acme/demo@HEAD', r.ok && posts[0]?.state === 'success' && posts[0].context === 'signoff/ci' && posts[0].owner === 'acme' && posts[0].repo === 'demo' && posts[0].sha === sha, JSON.stringify(posts[0]));
check('описание и Details', /Тесты прошли локально: npm test \(2 с\)/.test(posts[0].description) && posts[0].targetUrl === `https://ci.example/${sha}`);
check('журнал шагов', r.log.some((l) => /HEAD [0-9a-f]{7} \(origin\/main\)/.test(l)) && r.log.some((l) => /Тесты прошли за 2 с/.test(l)), r.log.join(' | '));
const before = execs;
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dirty', scripts: { test: 'node t.js' } }));
r = await runSignoff({ projectDir: dir, fail: true, git, exec: exec(0), post });
check('fail: failure без тестов, даже с правками', r.ok && posts.at(-1).state === 'failure' && posts.at(-1).context === 'signoff' && execs === before);
r = await runSignoff({ projectDir: dir, fail: true, git, exec: exec(0), post: async () => ({ ok: false, error: 'HTTP 403' }) });
check('GitHub отказал — понятная ошибка', !r.ok && /GitHub не принял статус: HTTP 403/.test(r.error));
fs.rmSync(dir, { recursive: true, force: true });
const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-signoff-none-'));
r = await runSignoff({ projectDir: notRepo, git: (args) => { const x = spawnSync('git', args, { cwd: notRepo, encoding: 'utf8' }); return { code: x.status, stdout: x.stdout || '' }; }, exec: exec(0), post });
check('не git-репозиторий', !r.ok && /не git-репозиторий/.test(r.error), r.error);
fs.rmSync(notRepo, { recursive: true, force: true });

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
