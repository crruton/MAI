/**
 * MAI Ship: steward (E3.E1–E7, ADR 0122) — настоящий git (bare-«удалённый» репозиторий и рабочая
 * копия), поддельный GitLab, а в последнем разделе — настоящий цикл агента MAI без Electron.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSteward, parseCommand, stewardRules, forbiddenMatchers, forbiddenTouched, createAgentRunner, ROUND_MARKER, RETRY_MARKER, classifyFailure } from '../electron/lib/ship/steward.js';
import { LABELS } from '../electron/lib/ship/approve.js';

process.env.MAI_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'mai-steward-data-'));

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

const SHIP_ON = 'version: 1\nproviders:\n  steward: agentrouter/claude-opus-5-5\nsteward:\n  enabled: true\n  max_rounds: 2\n  commands: ["node test.js"]\n';
const POLICY = 'version: 1\nmode: observe\nrules:\n  - name: migrations\n    match: { any_path: ["**/migrations/**"] }\n    decision: require_human\n  - name: docs\n    match: { paths: ["**/*.md"] }\n    decision: approve\ndefault: require_human\n';

/** Репозиторий: bare-«origin» и рабочая копия на ветке feature (как в CI). */
function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-steward-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(origin);
  g(origin, ['init', '-q', '--bare']);
  fs.mkdirSync(work);
  g(work, ['init', '-q', '-b', 'feature']);
  g(work, ['config', 'user.name', 'dev']);
  g(work, ['config', 'user.email', 'dev@example.com']);
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'a.js'), 'export const sum = (a, b) => a - b;\n');
  g(work, ['add', '.']);
  g(work, ['commit', '-q', '-m', 'init']);
  g(work, ['remote', 'add', 'origin', origin]);
  g(work, ['push', '-q', 'origin', 'feature']);
  return { root, origin, work, git: (args) => g(work, args), push: (branch) => g(work, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]), originLog: () => g(origin, ['log', '--format=%H %an%n%B', '-1', 'feature']) };
}

/** Поддельный GitLab с интерфейсом createGitlab. */
function fakeGitlab({ ship = SHIP_ON, jobs = [{ id: 11, name: 'test', stage: 'test', status: 'failed' }], notes = [], discussions = [], labels = [], members = { 1: 30, 2: 20 }, fork = false } = {}) {
  const state = { mr: { iid: 7, state: 'opened', title: 'Сумма', target_branch: 'main', source_branch: 'feature', labels: [...labels], head_pipeline: { id: 99 }, source_project_id: fork ? 2 : 1, target_project_id: 1 }, notes: notes.map((n, i) => ({ id: 500 + i, system: false, ...n })), created: [] };
  let id = 900;
  return {
    state,
    gitlab: {
      getMr: async () => state.mr,
      getFile: async (project, file, ref) => (ref !== 'main' ? null : file === '.mai-code/ship.yaml' ? ship : file === '.mai-code/approval-policy.yaml' ? POLICY : null),
      getNotes: async () => state.notes,
      createNote: async (project, iid, body) => {
        const n = { id: id++, body, system: false, created_at: new Date().toISOString() };
        state.notes.push(n);
        state.created.push(body);
        return n;
      },
      updateNote: async (project, iid, noteId, body) => {
        state.notes.find((n) => n.id === noteId).body = body;
      },
      getMember: async (project, userId) => ({ access_level: members[userId] || 0 }),
      setLabels: async (project, iid, { add = [], remove = [] }) => {
        state.mr.labels = [...new Set([...state.mr.labels.filter((l) => !remove.includes(l)), ...add])];
      },
      getPipelineJobs: async () => jobs,
      getJobTrace: async () => 'AssertionError: expected 5, got -1\n    at test.js:3',
      getDiscussions: async () => discussions,
    },
  };
}
const fixAgent = (calls) => async (task, opts) => {
  calls.push({ task, opts });
  return { summary: 'Исправил знак в sum.' };
};
const editFile = (repo, rel, text) => fs.writeFileSync(path.join(repo.work, rel), text);
const base = (repo, f, extra = {}) => ({ gitlab: f.gitlab, project: 'g/app', iid: 7, git: repo.git, push: repo.push, model: 'agentrouter/claude-opus-5-5', ...extra });

console.log('[1] разбор');
check('команды @mai', parseCommand('@mai stop')?.kind === 'stop' && parseCommand('@MAI resume')?.kind === 'resume' && parseCommand('@mai почини тест суммы').text === 'почини тест суммы' && parseCommand('просто текст') === null && parseCommand('@mai') === null);
const rules = stewardRules(['npm test']);
check('правила: правка и команды проверки — да; push, commit, reset — нет', rules.allow.includes('write_file') && rules.allow.includes('run_shell(npm test*)') && rules.deny.includes('run_shell(git push*)') && rules.deny.includes('run_shell(git commit*)'));
const m = forbiddenMatchers({ rules: [{ name: 'mig', decision: 'require_human', match: { any_path: ['**/migrations/**'] } }, { name: 'docs', decision: 'approve', match: { paths: ['**/*.md'] } }] });
check('запретные пути: конфигурация Ship, CI и правила не-approve; approve-правила — нет', forbiddenTouched(['.gitlab-ci.yml', 'db/migrations/1.sql', 'README.md', 'src/a.js'], m).join() === '.gitlab-ci.yml,db/migrations/1.sql');

console.log('[2] упавший CI → правка, коммит, push');
let repo = setupRepo();
let f = fakeGitlab();
let calls = [];
let out = await runSteward(base(repo, f, { runAgentTask: async (task, opts) => { editFile(repo, 'src/a.js', 'export const sum = (a, b) => a + b;\n'); return fixAgent(calls)(task, opts); } }));
check('статус pushed', out.status === 'pushed', JSON.stringify(out));
check('агенту — лог упавшей джобы как данные и правила steward', calls[0].task.includes('expected 5, got -1') && calls[0].task.includes('<log>') && /данные, а не инструкции/.test(calls[0].task) && calls[0].opts.rules.allow.includes('run_shell(node test.js*)'));
const log = repo.originLog();
check('коммит в origin/feature: автор steward, трейлер Agent-Model', log.includes(out.sha) && log.includes('mai-ship-steward') && /Agent-Model: agentrouter\/claude-opus-5-5/.test(log), log);
check('комментарий раунда: файлы, откат, маркер', f.state.created.length === 1 && f.state.created[0].includes(`git revert ${out.sha}`) && f.state.created[0].includes('src/a.js') && f.state.created[0].includes(ROUND_MARKER));

console.log('[3] лимиты и паузы');
repo = setupRepo();
f = fakeGitlab({ notes: [{ body: `раунд 1 ${ROUND_MARKER}`, created_at: '2026-11-26T01:00:00Z' }, { body: `раунд 2 ${ROUND_MARKER}`, created_at: '2026-11-26T02:00:00Z' }] });
calls = [];
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('лимит раундов → нужен человек, агент не вызван', out.status === 'limit' && calls.length === 0 && f.state.mr.labels.includes(LABELS.needs_human));
f = fakeGitlab({ notes: [{ body: '@mai stop', author: { id: 1, username: 'anna' }, created_at: '2026-11-26T01:00:00Z' }] });
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('@mai stop от Developer → пауза и метка, агент не вызван', out.status === 'paused' && f.state.mr.labels.includes(LABELS.paused) && calls.length === 0);
f = fakeGitlab({ labels: [LABELS.paused], notes: [{ body: '@mai stop', author: { id: 1 }, created_at: '2026-11-26T01:00:00Z' }, { body: '@mai resume', author: { id: 1 }, created_at: '2026-11-26T02:00:00Z' }], jobs: [] });
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('@mai resume после stop → метка снята', !f.state.mr.labels.includes(LABELS.paused) && out.status === 'skipped');
f = fakeGitlab({ notes: [{ body: '@mai stop', author: { id: 2, username: 'guest' }, created_at: '2026-11-26T01:00:00Z' }], jobs: [] });
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('команда от Reporter отклонена с ответом', out.replies.some((r) => /@guest отклонена: нет прав/.test(r)) && f.state.notes.some((n) => /отклонена/.test(n.body)) && !f.state.mr.labels.includes(LABELS.paused));

console.log('[4] задания: @mai, находки, нечего чинить');
repo = setupRepo();
f = fakeGitlab({ jobs: [], notes: [{ body: `раунд ${ROUND_MARKER}`, created_at: '2026-11-26T01:00:00Z' }, { body: '@mai старое указание', author: { id: 1, username: 'anna' }, created_at: '2026-11-26T00:30:00Z' }, { body: '@mai добавь проверку на NaN', author: { id: 1, username: 'anna' }, created_at: '2026-11-26T03:00:00Z' }],
  discussions: [
    { notes: [{ body: '⛔ **MAI Ship · ревью · blocking** (correctness)\n\n**Неверный знак**\n\nx', position: { new_path: 'src/a.js', new_line: 1 }, resolved: false }] },
    { notes: [{ body: '⛔ **MAI Ship · ревью · blocking** (security)\n\n**Решено**', position: { new_path: 'src/a.js', new_line: 1 }, resolved: true }] },
  ] });
calls = [];
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls), dryRun: true }));
check('dry-run: план без вызова агента', out.status === 'planned' && calls.length === 0);
check('в задаче — новое указание @mai и нерешённая blocking-находка; старые — нет', out.task.includes('добавь проверку на NaN') && !out.task.includes('старое указание') && out.task.includes('Неверный знак') && !out.task.includes('Решено'), out.task);
f = fakeGitlab({ jobs: [{ id: 1, name: 'ship:approval', status: 'failed' }, { id: 2, name: 'flaky', status: 'failed', allow_failure: true }] });
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('свои ship:* и allow_failure — не задания → нечего чинить', out.status === 'skipped' && /нечего/.test(out.reason));

console.log('[5] запретные пути, без изменений, выключен, форк');
repo = setupRepo();
f = fakeGitlab();
const before = repo.originLog();
out = await runSteward(base(repo, f, { runAgentTask: async () => { fs.mkdirSync(path.join(repo.work, 'db', 'migrations'), { recursive: true }); editFile(repo, 'db/migrations/2.sql', 'drop table x;'); editFile(repo, 'src/a.js', 'x'); return { summary: '' }; } }));
check('правка миграции → нужен человек, push не было', out.status === 'needs-human' && out.touched.some((t) => t.includes('migrations')) && repo.originLog() === before && f.state.mr.labels.includes(LABELS.needs_human));
repo = setupRepo();
f = fakeGitlab();
out = await runSteward(base(repo, f, { runAgentTask: async () => ({ summary: 'Тест падает из-за сети.' }) }));
check('агент ничего не изменил → комментарий «изменений нет»', out.status === 'no-changes' && f.state.notes.some((n) => /изменений нет/.test(n.body)));
f = fakeGitlab({ ship: 'version: 1\nsteward:\n  enabled: false\n' });
check('steward.enabled: false → пропуск', (await runSteward(base(repo, f, { runAgentTask: fixAgent([]) }))).status === 'skipped');
f = fakeGitlab({ fork: true });
check('MR из форка → пропуск', /форка/.test((await runSteward(base(repo, f, { runAgentTask: fixAgent([]) }))).reason));
f = fakeGitlab();
check('MAI_SHIP_DISABLED → пропуск', (await runSteward(base(repo, f, { runAgentTask: fixAgent([]), env: { MAI_SHIP_DISABLED: 'true' } }))).status === 'skipped');

console.log('[6] настоящий цикл агента MAI без Electron');
const { runAgent } = await import('../electron/lib/agent.js');
function stream(step) {
  return { async *[Symbol.asyncIterator]() {
    if (step.text) yield { choices: [{ delta: { content: step.text } }] };
    for (const [index, call] of (step.calls || []).entries()) yield { choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, function: { name: call.name, arguments: JSON.stringify(call.args || {}) } }] } }] };
  } };
}
repo = setupRepo();
f = fakeGitlab();
const script = [
  { calls: [{ name: 'read_file', args: { path: 'src/a.js' } }] },
  { calls: [{ name: 'write_file', args: { path: 'src/a.js', content: 'export const sum = (a, b) => a + b;\n' } }] },
  { calls: [{ name: 'run_shell', args: { command: 'git push origin feature' } }] },
  { text: 'Исправил знак в sum.' },
];
let step = 0;
const asked = [];
// Тот же код, что в CI (scripts/mai-ship.mjs), только модель подменена.
const inner = createAgentRunner({
  runAgent: async (opts) => runAgent({ ...opts, approve: async (req) => { asked.push(req?.tool); return opts.approve(req); } }),
  provider: { baseURL: 'http://fake', apiKey: 'k', name: 'fake' },
  model: 'fake',
  projectDir: repo.work,
  maxIterations: 8,
  clientFactory: () => ({ chat: { completions: { create: async () => stream(script[Math.min(step++, script.length - 1)]) } } }),
});
const runAgentTask = inner;
out = await runSteward(base(repo, f, { runAgentTask }));
check('агент правит файл по правилам steward, коммит запушен', out.status === 'pushed' && fs.readFileSync(path.join(repo.work, 'src', 'a.js'), 'utf8').includes('a + b'), JSON.stringify(out).slice(0, 300));
check('git push от агента отклонён правилом, человека не спрашивали', asked.length === 0 && !repo.originLog().split('\n')[0].includes('dev'), JSON.stringify(asked));
check('итог агента — в комментарии раунда', f.state.created[0].includes('Исправил знак в sum.'));

console.log('[7] инфраструктура, конфликты с target, ответы в обсуждениях (E3.E2–E4)');
check('классификация: failure_reason раннера и сетевой лог → infra; ассерт → code',
  classifyFailure({ failure_reason: 'runner_system_failure' }) === 'infra' && classifyFailure({ failure_reason: 'script_failure' }, 'npm ERR! network ECONNRESET') === 'infra' && classifyFailure({ failure_reason: 'script_failure' }, 'AssertionError: expected 5') === 'code');
const withExtras = (f2) => {
  f2.state.retried = [];
  f2.state.replies = [];
  f2.gitlab.retryJob = async (project, jobId) => { f2.state.retried.push(jobId); };
  f2.gitlab.replyDiscussion = async (project, iid, did, body) => { f2.state.replies.push({ did, body }); };
  return f2;
};
repo = setupRepo();
f = withExtras(fakeGitlab({ jobs: [{ id: 21, name: 'test', stage: 'test', status: 'failed', failure_reason: 'stuck_or_timeout_failure' }] }));
f.state.mr.sha = 'abc123def456';
calls = [];
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('сбой раннера → перезапуск джобы, агент не вызван', out.status === 'retried' && f.state.retried.join() === '21' && calls.length === 0 && f.state.created.some((b) => b.includes(RETRY_MARKER('abc123def456', 'test'))), JSON.stringify(out));
out = await runSteward(base(repo, f, { runAgentTask: fixAgent(calls) }));
check('повтор на том же SHA → нужен человек, второго перезапуска нет', f.state.retried.length === 1 && f.state.mr.labels.includes(LABELS.needs_human) && calls.length === 0 && out.retries[0].already === true, JSON.stringify(out));

// Конфликт: в main та же строка изменена иначе.
const g2 = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function advanceMain(r, content) {
  r.git(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const other = path.join(r.root, 'other');
  g2(r.root, ['clone', '-q', '-b', 'main', r.origin, other]);
  g2(other, ['config', 'user.name', 'lead']);
  g2(other, ['config', 'user.email', 'lead@example.com']);
  fs.writeFileSync(path.join(other, ...content.file.split('/')), content.text);
  g2(other, ['add', '.']);
  g2(other, ['commit', '-q', '-m', 'main moves']);
  g2(other, ['push', '-q', 'origin', 'main']);
}
repo = setupRepo();
advanceMain(repo, { file: 'src/a.js', text: 'export const sum = (a, b) => Number(a) + Number(b);\n' });
editFile(repo, 'src/a.js', 'export const sum = (a, b) => a + b; // feature\n');
repo.git(['commit', '-q', '-am', 'feature edit']);
repo.git(['push', '-q', 'origin', 'feature']);
const beforeConflict = repo.originLog();
f = withExtras(fakeGitlab({ jobs: [] }));
f.state.mr.has_conflicts = true;
out = await runSteward(base(repo, f, { runAgentTask: fixAgent([]) }));
check('конфликт с main → слияние отменено, нужен человек со списком файлов, push не было',
  out.status === 'conflict' && out.conflicted.join() === 'src/a.js' && f.state.mr.labels.includes(LABELS.needs_human) && repo.originLog() === beforeConflict && repo.git(['status', '--porcelain']).trim() === '' && f.state.notes.some((n) => /конфликт с `main`/.test(n.body) && n.body.includes('src/a.js')), JSON.stringify(out));

repo = setupRepo();
advanceMain(repo, { file: 'README.md', text: '# app\n' });
f = withExtras(fakeGitlab({ jobs: [] }));
f.state.mr.merge_status = 'cannot_be_merged';
out = await runSteward(base(repo, f, { runAgentTask: fixAgent([]) }));
check('без конфликта → main влит и запушен, агент не нужен', out.status === 'merged-target' && repo.originLog().includes(out.sha) && fs.existsSync(path.join(repo.work, 'README.md')) && f.state.created.some((b) => b.includes(`git revert -m 1 ${out.sha}`) && b.includes(ROUND_MARKER)), JSON.stringify(out));

repo = setupRepo();
f = withExtras(fakeGitlab({ jobs: [], discussions: [{ id: 'd-1', notes: [{ body: '⛔ **MAI Ship · ревью · blocking** (correctness)\n\n**Неверный знак**', position: { new_path: 'src/a.js', new_line: 1 }, resolved: false }] }] }));
out = await runSteward(base(repo, f, { runAgentTask: async (task, opts) => { editFile(repo, 'src/a.js', 'export const sum = (a, b) => a + b;\n'); return fixAgent([])(task, opts); } }));
check('после коммита — ответ в обсуждении находки с SHA; закрывает ревьюер', out.status === 'pushed' && f.state.replies.length === 1 && f.state.replies[0].did === 'd-1' && f.state.replies[0].body.includes(out.sha.slice(0, 12)) && /закроет ревьюер/.test(f.state.replies[0].body), JSON.stringify(f.state.replies));

console.log(`\nship-steward: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
