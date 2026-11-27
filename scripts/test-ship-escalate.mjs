/**
 * MAI Ship: эскалация к человеку (E3.F4, ADR 0123) — CODEOWNERS, ревьюеры, уведомления, без повторов.
 */
import { parseCodeowners, ownersFor, ownerPatternRe, shipChannel, escalate } from '../electron/lib/ship/escalate.js';

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

const CODEOWNERS = `# Владельцы
*                @lead
*.md             @writer
/src/            @backend @backend-two
src/payments/    @payments   # платежи
/infra/**/*.tf   @devops @org/devops-team

[Database]
**/migrations/** @dba

^[Docs review]
docs/            @docs-reviewer
`;

console.log('[1] шаблоны и разбор');
check('*.md — в любой папке', ownerPatternRe('*.md').test('a/b/README.md') && ownerPatternRe('*.md').test('README.md'));
check('/src/ — только корневая папка', ownerPatternRe('/src/').test('src/a.js') && !ownerPatternRe('/src/').test('lib/src/a.js'));
check('src/payments/ — папка от корня (есть «/» внутри)', ownerPatternRe('src/payments/').test('src/payments/pay.js') && !ownerPatternRe('src/payments/').test('x/src/payments/pay.js'));
check('имя без «*» и «/» — файл или папка где угодно', ownerPatternRe('Dockerfile').test('svc/Dockerfile') && ownerPatternRe('config').test('a/config/x.yml'));
const rules = parseCodeowners(CODEOWNERS);
check('секции, необязательная секция, комментарии', rules.length === 7 && rules.find((r) => r.section === 'Database') && rules.find((r) => r.section === 'Docs review').optional === true);

console.log('[2] владельцы файлов');
check('последнее совпадение в секции побеждает', ownersFor(rules, ['src/payments/pay.js']).join() === '@payments');
check('общая секция и секция Database объединяются', ownersFor(rules, ['src/db/migrations/1.sql']).sort().join() === '@backend,@backend-two,@dba');
check('необязательная секция не добавляет обязательных владельцев', ownersFor(rules, ['docs/guide.md']).join() === '@writer');
check('группы остаются в списке (отфильтрует escalate)', ownersFor(rules, ['infra/prod/main.tf']).includes('@org/devops-team'));

console.log('[3] эскалация');
function fakeGitlab({ reviewers = [], multiFails = false, codeowners = CODEOWNERS } = {}) {
  const calls = { setReviewers: [], findUser: [] };
  const users = { backend: 11, 'backend-two': 12, dba: 13, lead: 10, payments: 14 };
  return {
    calls,
    gitlab: {
      getFile: async (project, p) => (p === '.gitlab/CODEOWNERS' ? codeowners : null),
      findUser: async (name) => { calls.findUser.push(name); return users[name] ? { id: users[name] } : null; },
      setReviewers: async (project, iid, ids) => {
        calls.setReviewers.push(ids);
        if (multiFails && ids.length > 1) throw new Error('GitLab Free: один ревьюер');
      },
    },
    mr: { title: 'Миграция', target_branch: 'main', author: { username: 'backend' }, reviewers, web_url: 'https://gitlab.example/g/app/-/merge_requests/7' },
  };
}
const needs = { action: 'needs_human', decision: 'require_human', reason: 'Миграция данных' };
let f = fakeGitlab();
let out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S1', self: 'mai-ship-approver' });
check('ревьюеры по CODEOWNERS из .gitlab/CODEOWNERS, без автора MR', out.reviewers.sort().join() === 'backend-two,dba' && f.calls.setReviewers[0].sort().join() === '12,13', JSON.stringify(out));
f = fakeGitlab({ multiFails: true });
out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S1' });
check('GitLab Free: при отказе — один ревьюер', out.reviewers.length === 1 && f.calls.setReviewers.length === 2 && f.calls.setReviewers[1].length === 1);
f = fakeGitlab({ reviewers: [{ username: 'anna' }] });
out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S1' });
check('ревьюеры уже назначены — не трогаем', out.reviewers.length === 0 && f.calls.setReviewers.length === 0);
f = fakeGitlab();
out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['infra/prod/main.tf'], result: needs, sha: 'S1' });
check('группы и неизвестные пользователи пропускаются', !f.calls.findUser.includes('org/devops-team') && out.reviewers.join() === '', JSON.stringify(f.calls));
f = fakeGitlab();
out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['src/a.js'], result: { action: 'block', reason: 'красный pipeline' }, sha: 'S1' });
check('block: ревьюеры не назначаются', f.calls.setReviewers.length === 0);
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/a.js'], result: { action: 'comment', reason: '' }, sha: 'S1' });
check('observe-комментарий — не эскалация', out.skipped === 'не эскалация');
f = fakeGitlab();
out = await escalate({ ...f, project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S1', previous: { sha: 'S1', action: 'needs_human' } });
check('то же решение по тому же SHA — никого не дёргаем', out.skipped && f.calls.setReviewers.length === 0);
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S2', previous: { sha: 'S1', action: 'needs_human' } });
check('новый SHA — эскалация снова', !out.skipped && out.reviewers.length > 0);

console.log('[4] уведомления');
check('канал none / без секретов — нет', shipChannel({}) === null && shipChannel({ channel: 'telegram' }, {}) === null && shipChannel({ channel: 'webhook' }, { SHIP_NOTIFY_WEBHOOK_URL: 'http://plain' }) === null);
const sent = [];
const fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/db/migrations/1.sql'], result: needs, sha: 'S1', shipCfg: { notify: { channel: 'telegram' } }, env: { SHIP_NOTIFY_TELEGRAM_TOKEN: '123:abc', SHIP_NOTIFY_TELEGRAM_CHAT: '-100' }, fetch });
check('Telegram: sendMessage с текстом, ревьюерами и ссылкой', out.notified && /bot123%3Aabc\/sendMessage$/.test(sent[0].url) && sent[0].body.chat_id === '-100' && /нужен человек/.test(sent[0].body.text) && /@dba/.test(sent[0].body.text) && /merge_requests\/7/.test(sent[0].body.text), JSON.stringify(sent[0]));
sent.length = 0;
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/a.js'], result: { action: 'block', reason: 'красный pipeline' }, sha: 'S1', shipCfg: { notify: { channel: 'webhook', events: ['needs_human'] } }, env: { SHIP_NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' }, fetch });
check('событие не из notify.events — без уведомления', !out.notified && sent.length === 0);
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/a.js'], result: { action: 'block', reason: 'красный pipeline' }, sha: 'S1', shipCfg: { notify: { channel: 'rocketchat' } }, env: { SHIP_NOTIFY_WEBHOOK_URL: 'https://chat.example/hooks/x' }, fetch });
check('Rocket.Chat: blocked', out.notified && sent[0].url === 'https://chat.example/hooks/x' && /заблокирован/.test(sent[0].body.text));
out = await escalate({ ...fakeGitlab(), project: 'g/app', iid: 7, files: ['src/a.js'], result: needs, sha: 'S1', shipCfg: { notify: { channel: 'webhook' } }, env: { SHIP_NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' }, fetch: async () => { throw new Error('сеть'); } });
check('ошибка доставки — в errors, без исключения', !out.notified && out.errors.some((e) => /сеть/.test(e)));

console.log(`\nship-escalate: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
