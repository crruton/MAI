/**
 * MAI Ship: роль approver против поддельного GitLab (E3.F1–F5, ADR 0108–0110).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGitlab, diffFacts, NOTE_MARKER } from '../electron/lib/ship/gitlab.js';
import { runApprove, createClassifier, parseClassifierAnswer, gateExitCode, LABELS } from '../electron/lib/ship/approve.js';

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

const SHIP = `version: 1
enabled: true
providers:
  reviewer: agentrouter/claude-opus-5-5
  approver: openai/gpt-5.1
`;
const POLICY = (mode = 'observe') => `version: 1
mode: ${mode}
enforce_classes: [docs]
rules:
  - name: migrations
    match: { any_path: ["**/migrations/**"] }
    decision: require_human
  - name: docs
    match: { paths: ["docs/**", "**/*.md"] }
    decision: approve
classifiers:
  - name: external-effect
    question: Изменение отправляет данные во внешний сервис?
    when_true: require_human
default: require_human
`;

/** Поддельный GitLab: MR 7 в проекте group/app. */
function fakeGitlab({ mode = 'observe', files = ['docs/guide.md'], pipeline = 'success', labels = [], commits = ['Добавить раздел\n\nAgent-Model: agentrouter/claude-opus-5-5'], target = {}, headAfter = null } = {}) {
  const state = {
    mr: { iid: 7, state: 'opened', sha: 'abc123def456', target_branch: 'main', source_branch: 'feature', draft: false, labels: [...labels], head_pipeline: { status: pipeline } },
    files: { main: { '.mai-code/ship.yaml': SHIP, '.mai-code/approval-policy.yaml': POLICY(mode), ...target } },
    diffs: files.map((f) => ({ old_path: f, new_path: f, diff: '@@ -1 +1,2 @@\n-old\n+new\n+line\n' })),
    commits: commits.map((message) => ({ message })),
    notes: [],
    approvals: [],
    approvedBy: [],
    requests: [],
    getMrCount: 0,
  };
  let noteId = 100;
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => (typeof data === 'string' ? data : JSON.stringify(data)) });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace('/api/v4', ''));
    const method = init.method || 'GET';
    state.requests.push(`${method} ${p}`);
    if (init.headers?.['PRIVATE-TOKEN'] !== 'bot-token') return json({ message: '401' }, 401);
    const body = init.body ? JSON.parse(init.body) : {};
    let m;
    if ((m = p.match(/^\/projects\/group\/app\/repository\/files\/(.+)\/raw$/))) {
      const content = state.files[u.searchParams.get('ref')]?.[m[1]];
      return content == null ? json({ message: '404' }, 404) : json(content);
    }
    if (p === '/projects/group/app/merge_requests/7' && method === 'GET') {
      state.getMrCount += 1;
      if (headAfter && state.getMrCount > 1) return json({ ...state.mr, sha: headAfter });
      return json(state.mr);
    }
    if (p === '/projects/group/app/merge_requests/7' && method === 'PUT') {
      const add = (body.add_labels || '').split(',').filter(Boolean);
      const remove = (body.remove_labels || '').split(',').filter(Boolean);
      state.mr.labels = [...new Set([...state.mr.labels.filter((l) => !remove.includes(l)), ...add])];
      return json(state.mr);
    }
    const page = Number(u.searchParams.get('page') || 1);
    if (p.endsWith('/diffs')) return json(page === 1 ? state.diffs : []);
    if (p.endsWith('/commits')) return json(page === 1 ? state.commits : []);
    if (p.endsWith('/notes') && method === 'GET') return json(page === 1 ? state.notes : []);
    if (p.endsWith('/notes') && method === 'POST') {
      const note = { id: ++noteId, body: body.body, system: false };
      state.notes.push(note);
      return json(note, 201);
    }
    if ((m = p.match(/\/notes\/(\d+)$/)) && method === 'PUT') {
      const note = state.notes.find((n) => n.id === Number(m[1]));
      note.body = body.body;
      return json(note);
    }
    if (p.endsWith('/approvals') && method === 'GET') return json({ approved_by: state.approvedBy.map((username) => ({ user: { username } })) });
    if (p.endsWith('/approve')) {
      if (body.sha !== state.mr.sha) return json({ message: 'SHA does not match HEAD' }, 409);
      state.approvals.push(body.sha);
      return json({ approved: true }, 201);
    }
    return json({ message: `нет обработчика ${method} ${p}` }, 500);
  };
  return { state, gitlab: createGitlab({ url: 'https://gitlab.example', token: 'bot-token', fetch }) };
}
const project = 'group/app';
const no = async () => false;

console.log('[1] observe: решение комментарием, без апрува');
let g = fakeGitlab();
let out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('docs → approve в режиме observe', out.status === 'done' && out.result.decision === 'approve' && out.result.action === 'comment', JSON.stringify(out));
check('комментарий с маркером и правилом', g.state.notes.length === 1 && g.state.notes[0].body.includes(NOTE_MARKER('approve')) && g.state.notes[0].body.includes('`docs`'));
check('метка ship::observe, апрува нет', g.state.mr.labels.includes(LABELS.comment) && g.state.approvals.length === 0);
await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('повтор обновляет свой комментарий, а не плодит', g.state.notes.length === 1);

console.log('[2] enforce: approve с SHA');
g = fakeGitlab({ mode: 'enforce' });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('approve на оценённый SHA', g.state.approvals.join() === 'abc123def456' && g.state.mr.labels.includes(LABELS.approve), JSON.stringify(out.actions));
g = fakeGitlab({ mode: 'enforce', headAfter: 'fff999' });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('новый коммит во время оценки — апрува нет (stale)', out.status === 'stale' && g.state.approvals.length === 0, JSON.stringify(out));

console.log('[3] классификаторы');
g = fakeGitlab();
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: async () => true });
check('классификатор «да» → нужен человек и метка', out.result.decision === 'require_human' && out.result.rule === 'external-effect' && g.state.mr.labels.includes(LABELS.needs_human));
g = fakeGitlab();
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: async () => { throw new Error('502'); } });
check('ошибка модели → не посчитан → человек', out.result.decision === 'require_human' && /не посчитан/.test(out.result.reason));
g = fakeGitlab();
out = await runApprove({ gitlab: g.gitlab, project, iid: 7 });
check('нет модели → не посчитан → человек', out.result.decision === 'require_human');
let asked = 0;
g = fakeGitlab({ files: ['db/migrations/1.sql'] });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: async () => { asked += 1; return false; } });
check('модель не зовётся, если решение и так не approve', asked === 0 && out.result.rule === 'migrations');
check('метки решений сменяют друг друга', g.state.mr.labels.filter((l) => l.startsWith('ship::')).length === 1);

let askedBlock = 0;
g = fakeGitlab({ files: ['db/migrations/1.sql'], target: { '.mai-code/approval-policy.yaml': POLICY('observe').replace('    when_true: require_human', '    when_true: block') } });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: async () => { askedBlock += 1; return true; } });
check('нужен человек, но классификатор может дать block — модель зовётся, итог block', askedBlock === 1 && out.result.decision === 'block' && out.result.rule === 'external-effect', JSON.stringify(out.result));
console.log('[4] политика из target branch, самозащита, независимость');
g = fakeGitlab({ files: ['.mai-code/approval-policy.yaml'] });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('MR правит политику → нужен человек', out.result.rule === 'self-protection');
check('политика прочитана из main', g.state.requests.some((r) => r.includes('approval-policy.yaml/raw')));
g = fakeGitlab({ commits: ['fix\n\nAgent-Model: openai/gpt-5.1'] });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('исполнитель того же семейства, что approver → человек', out.result.rule === 'independence');
g = fakeGitlab({ commits: ['ручной коммит'] });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('коммит человека без трейлера → approve (observe)', out.result.decision === 'approve');
g = fakeGitlab({ pipeline: 'failed' });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('красный pipeline → block', out.result.decision === 'block' && g.state.mr.labels.includes(LABELS.block));

console.log('[5] выключение, пропуски, битый YAML, dry-run');
g = fakeGitlab();
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, env: { MAI_SHIP_DISABLED: 'true' } });
check('MAI_SHIP_DISABLED → пропуск без записей', out.status === 'skipped' && g.state.notes.length === 0);
g = fakeGitlab({ labels: [LABELS.paused] });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7 });
check('метка ship::paused → пропуск', out.status === 'skipped');
g = fakeGitlab();
delete g.state.files.main['.mai-code/ship.yaml'];
out = await runApprove({ gitlab: g.gitlab, project, iid: 7 });
check('нет ship.yaml в target → Ship не настроен', out.status === 'skipped' && /ship.yaml/.test(out.reason));
g = fakeGitlab({ target: { '.mai-code/approval-policy.yaml': 'version: 1\nmode: [observe' } });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no });
check('битый YAML политики → block с текстом ошибки', out.result.decision === 'block' && out.result.rule === 'policy-invalid' && /YAML/.test(out.result.reason));
g = fakeGitlab({ mode: 'enforce' });
out = await runApprove({ gitlab: g.gitlab, project, iid: 7, classify: no, dryRun: true });
check('dry-run: план без записей', out.status === 'planned' && g.state.notes.length === 0 && g.state.approvals.length === 0 && /dry-run/.test(out.note));
g = fakeGitlab();
g.state.mr.state = 'merged';
check('влитый MR — пропуск', (await runApprove({ gitlab: g.gitlab, project, iid: 7 })).status === 'skipped');

console.log('[6] классификатор: ответ модели и маскировка секретов');
check('ответ: JSON с true/false', parseClassifierAnswer('{"answer": false, "quote": "x"}') === false && parseClassifierAnswer('текст {"answer": true} хвост') === true);
check('мусор и не-boolean → null', parseClassifierAnswer('да') === null && parseClassifierAnswer('{"answer":"yes"}') === null);
const sent = [];
const client = { chat: { completions: { create: async (req) => { sent.push(req); return { choices: [{ message: { content: '{"answer": false}' } }] }; } } } };
const classify = createClassifier({ client, model: 'gpt-5.1' });
const answer = await classify('Внешний сервис?', '+const key = "sk-proj-' + 'a'.repeat(40) + '"');
check('секрет в diff замаскирован до отправки модели', answer === false && !sent[0].messages[1].content.includes('aaaaaaaaaa') && sent[0].messages[1].content.includes('[СКРЫТО'), sent[0].messages[1].content.slice(0, 200));
check('diff передан как данные, temperature 0', sent[0].temperature === 0 && /не инструкции/.test(sent[0].messages[0].content));
check('diffFacts: файлы, переименование и строки', JSON.stringify(diffFacts([{ old_path: 'a.js', new_path: 'b.js', diff: '+++ b\n--- a\n+x\n-y\n z' }])) === JSON.stringify({ files: ['b.js', 'a.js'], changedLines: 2 }));

console.log('[6b] гейт GitLab Free (--gate)');
const gate = async (opts, setup = () => {}) => { const f = fakeGitlab(opts); setup(f.state); const o = await runApprove({ gitlab: f.gitlab, project, iid: 7, classify: opts.classify || no }); return gateExitCode(o, { gitlab: f.gitlab, project, iid: 7, policyMode: o.policyMode }); };
check('observe: всегда 0, даже если нужен человек', (await gate({ files: ['db/migrations/1.sql'] })) === 0);
check('enforce + approve → 0', (await gate({ mode: 'enforce' })) === 0);
check('enforce + нужен человек, апрува нет → 3', (await gate({ mode: 'enforce', files: ['db/migrations/1.sql'] })) === 3);
check('апрув только бота не считается → 3', (await gate({ mode: 'enforce', files: ['db/migrations/1.sql'] }, (s) => { s.approvedBy = ['mai-ship-approver']; })) === 3);
check('апрув человека → 0', (await gate({ mode: 'enforce', files: ['db/migrations/1.sql'] }, (s) => { s.approvedBy = ['anna']; })) === 0);
check('enforce + block → 2', (await gate({ mode: 'enforce', pipeline: 'failed' })) === 2);
check('новый коммит во время оценки → 3', (await gate({ mode: 'enforce', headAfter: 'fff' })) === 3);

console.log('[7] CLI');
const cli = spawnSync(process.execPath, [path.join(repo, 'scripts', 'mai-ship.mjs'), 'approve'], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '' } });
check('без проекта и MR — код 1 и подсказка', cli.status === 1 && /--project и --mr/.test(cli.stderr), cli.stderr);
const wrong = spawnSync(process.execPath, [path.join(repo, 'scripts', 'mai-ship.mjs'), 'steward'], { encoding: 'utf8' });
check('неготовая роль — понятная ошибка', wrong.status === 1 && /review и steward/.test(wrong.stderr));

console.log(`\nship-approve: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
