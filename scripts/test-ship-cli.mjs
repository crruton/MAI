/**
 * MAI Ship: `mai ship <роль>` без Electron и образ (E3.A5, ADR 0126) — ссылка на MR, лаунчер,
 * CI-шаблон с образом, Dockerfile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseMrUrl } from '../electron/lib/ship/gitlab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('[1] ссылка на MR');
let u = parseMrUrl('https://gitlab.example/group/sub/app/-/merge_requests/7');
check('сервер, проект с подгруппами, номер', u?.server === 'https://gitlab.example' && u.project === 'group/sub/app' && u.iid === 7, JSON.stringify(u));
u = parseMrUrl('http://10.0.0.5:8080/g/app/-/merge_requests/12/diffs?commit_id=abc#note_1');
check('порт, вкладка diffs, якорь', u?.server === 'http://10.0.0.5:8080' && u.project === 'g/app' && u.iid === 12, JSON.stringify(u));
check('номер MR — не ссылка', parseMrUrl('7') === null);
check('ссылка не на MR', parseMrUrl('https://gitlab.example/g/app/-/issues/3') === null && parseMrUrl('ftp://x/g/-/merge_requests/1') === null);

console.log('[2] лаунчер');
const run = (args, env = {}) => spawnSync(process.execPath, [path.join(root, 'bin', 'mai.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60_000 });
let r = run(['ship', '--help']);
check('mai ship --help — без Electron, код 0', r.status === 0 && /mai ship <review\|approve\|steward\|report>/.test(r.stdout), r.stderr);
r = run(['ship', 'deploy']);
check('неизвестная роль — код 1 и понятная ошибка', r.status === 1 && /роль: review, approve, steward или report/.test(r.stderr + r.stdout));
r = run(['ship', 'review', '--mr', 'https://127.0.0.1:9/g/app/-/merge_requests/7', '--dry-run'], { GITLAB_TOKEN: 'x', GITLAB_URL: '', CI_SERVER_URL: '', CI_PROJECT_ID: '', CI_MERGE_REQUEST_IID: '' });
check('--mr <ссылка>: идёт в GitLab из ссылки (а не «нужны --project и --mr»)', r.status === 1 && !/нужны --project/.test(r.stderr + r.stdout) && /fetch failed|ECONNREFUSED/.test(r.stderr + r.stdout), r.stderr + r.stdout);

console.log('[3] CI-шаблон и образ');
const ci = parseYaml(fs.readFileSync(path.join(root, 'ci', 'mai-ship.gitlab-ci.yml'), 'utf8'));
check('образ джоб — переменная MAI_SHIP_IMAGE, по умолчанию node:24-slim', ci['.mai-ship'].image === '$MAI_SHIP_IMAGE' && ci.variables.MAI_SHIP_IMAGE === 'node:24-slim');
const before = ci['.mai-ship'].before_script.join('\n');
check('с образом клон не нужен: /opt/mai → /tmp/mai', /\/opt\/mai\/scripts\/mai-ship\.mjs/.test(before) && /ln -sfn \/opt\/mai \/tmp\/mai/.test(before) && /git clone/.test(before));
const dockerfile = fs.readFileSync(path.join(root, 'ci', 'ship.Dockerfile'), 'utf8');
check('Dockerfile: базовый образ аргументом, без Electron, git, обёртка mai', /ARG NODE_IMAGE=node:24-slim/.test(dockerfile) && /--omit=dev/.test(dockerfile) && /install[^\n]*git/.test(dockerfile) && /exec node \/opt\/mai\/bin\/mai\.mjs/.test(dockerfile) && !/ENTRYPOINT \[/.test(dockerfile));
const ignore = fs.readFileSync(path.join(root, 'ci', 'ship.Dockerfile.dockerignore'), 'utf8');
for (const need of ['electron/', 'bin/', 'scripts/mai-ship.mjs', 'package-lock.json']) check(`контекст образа включает ${need}`, ignore.includes(`!${need}`));
const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'ship-image.yml'), 'utf8');
check('публикация в GHCR — только из main', /if: github\.ref == 'refs\/heads\/main'[\s\S]*docker push/.test(wf) && (wf.match(/if: github\.ref == 'refs\/heads\/main'/g) || []).length === 2);

console.log(`\nship-cli: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
