/**
 * Хуки на события агента (ADR 0035).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHooks, matches, collectHooks, createHookRunner } from '../electron/lib/hooks.js';
import { runToolCall, toolEntry } from '../electron/lib/tool-runner.js';
import { fsTools } from '../electron/lib/tools/fs.js';
import { DEFAULT_GUARDRAILS } from '../electron/lib/guardrails.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-hooks-'));
const script = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return `"${process.execPath}" "${file}"`;
};
const readStdin = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const input=JSON.parse(s);";
const block = script('block.js', `${readStdin} process.stderr.write('нельзя трогать '+input.tool_input.path); process.exit(2); });`);
const allow = script('allow.js', `${readStdin} console.log(JSON.stringify({decision:'allow'})); });`);
const ask = script('ask.js', `${readStdin} console.log(JSON.stringify({decision:'ask', reason:'проверь вручную'})); });`);
const context = script('ctx.js', `${readStdin} console.log(JSON.stringify({additionalContext:'линтер: 0 ошибок для '+input.tool_name})); });`);
const record = script('record.js', `${readStdin} require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'stdin.json'))}, s); });`);
const broken = script('broken.js', 'process.exit(1);');
const slow = script('slow.js', 'setTimeout(()=>{}, 10000);');

console.log('\n[1] Конфигурация');
const config = normalizeHooks({
  PreToolUse: [{ matcher: 'write_file|edit_file', hooks: [{ type: 'command', command: 'x', timeout: 9999 }] }, { hooks: [{ type: 'prompt', command: 'y' }] }],
  Bogus: [{ hooks: [{ command: 'z' }] }],
});
check('событие и matcher разобраны', config.PreToolUse?.[0].matcher === 'write_file|edit_file');
check('таймаут ограничен 600 с', config.PreToolUse[0].hooks[0].timeout === 600);
check('не-command и неизвестные события отброшены', config.PreToolUse.length === 1 && !config.Bogus);
check('matcher — регулярка по имени целиком', matches('write_file|edit_file', 'edit_file') && !matches('write', 'write_file') && matches('', 'anything') && matches('mcp__.*', 'mcp__fs__x'));
fs.mkdirSync(path.join(dir, 'proj', '.mai-code'), { recursive: true });
fs.writeFileSync(path.join(dir, 'proj', '.mai-code', 'hooks.json'), JSON.stringify({ Stop: [{ hooks: [{ command: 'project-hook' }] }] }));
check('хуки проекта — только при доверии', !collectHooks({ projectDir: path.join(dir, 'proj'), trusted: false }).Stop && collectHooks({ projectDir: path.join(dir, 'proj'), trusted: true }).Stop?.[0].hooks[0].source === 'project');

const runner = (hooks) => createHookRunner({ hooks: normalizeHooks(hooks), projectDir: dir, sessionId: 's1' });

console.log('\n[2] Протокол команды');
const r1 = await runner({ PreToolUse: [{ hooks: [{ command: block }] }] }).run('PreToolUse', { tool_name: 'write_file', tool_input: { path: '.env.prod' } });
check('код 2 — deny с причиной из stderr', r1.decision === 'deny' && /нельзя трогать \.env\.prod/.test(r1.reason), JSON.stringify(r1));
const r2 = await runner({ PostToolUse: [{ hooks: [{ command: context }] }] }).run('PostToolUse', { tool_name: 'edit_file' });
check('additionalContext собран', r2.context[0] === 'линтер: 0 ошибок для edit_file', JSON.stringify(r2));
await runner({ Stop: [{ hooks: [{ command: record }] }] }).run('Stop', { last_assistant_message: 'готово' });
const stdin = JSON.parse(fs.readFileSync(path.join(dir, 'stdin.json'), 'utf8'));
check('на stdin — событие, сессия, проект и данные', stdin.hook_event_name === 'Stop' && stdin.session_id === 's1' && stdin.project_dir === dir && stdin.last_assistant_message === 'готово');
const r3 = await runner({ Stop: [{ hooks: [{ command: broken }] }] }).run('Stop', {});
check('код 1 — ошибка хука, не блокировка', r3.decision === null && r3.results[0].code === 1);
const started = Date.now();
const r4 = await runner({ Stop: [{ hooks: [{ command: slow, timeout: 1 }] }] }).run('Stop', {});
check('таймаут — не блокирует и не висит', r4.decision === null && Date.now() - started < 4000, `${Date.now() - started} мс`);
const r5 = await runner({ PreToolUse: [{ hooks: [{ command: allow }, { command: block }] }] }).run('PreToolUse', { tool_name: 'x', tool_input: { path: 'p' } });
check('самое строгое решение побеждает', r5.decision === 'deny');

console.log('\n[3] Связка с PolicyEngine');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-hooks-proj-'));
const target = path.join(project, 'note.txt');
const write = fsTools.find((t) => t.schema.function.name === 'write_file');
const entry = toolEntry(write.schema, { source: 'builtin', run: write.run, precheck: write.precheck });
const call = async (mode, hooks, answer = false) => {
  const asked = [];
  const out = await runToolCall({
    entry,
    args: { path: 'note.txt', content: 'ИЗМЕНЕНО' },
    ctx: { projectDir: project, guardrails: DEFAULT_GUARDRAILS },
    policy: { getMode: () => mode, getRules: () => ({}) },
    approve: async (r) => (asked.push(r), answer),
    hooks: runner(hooks),
  });
  return { out, asked };
};
fs.writeFileSync(target, 'исходный', 'utf8');
let r = await call('bypass', { PreToolUse: [{ matcher: 'write_file', hooks: [{ command: block }] }] });
check('хук deny сильнее «Без вопросов»', !r.out.ok && /Хук PreToolUse/.test(r.out.content) && fs.readFileSync(target, 'utf8') === 'исходный', r.out.content);
r = await call('manual', { PreToolUse: [{ hooks: [{ command: allow }] }] });
check('хук allow снимает вопрос в «Вручную»', r.out.ok && r.asked.length === 0 && fs.readFileSync(target, 'utf8') === 'ИЗМЕНЕНО');
fs.writeFileSync(target, 'исходный', 'utf8');
r = await call('plan', { PreToolUse: [{ hooks: [{ command: allow }] }] });
check('хук allow не пробивает «План»', !r.out.ok && fs.readFileSync(target, 'utf8') === 'исходный');
r = await call('bypass', { PreToolUse: [{ hooks: [{ command: ask }] }] }, false);
check('хук ask заставляет спросить даже в «Без вопросов»', r.asked.length === 1 && fs.readFileSync(target, 'utf8') === 'исходный');
r = await call('bypass', { PostToolUse: [{ hooks: [{ command: context }] }] });
check('PostToolUse дописывает контекст к результату', /\[Хук PostToolUse\]\nлинтер: 0 ошибок для write_file/.test(r.out.content), r.out.content);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(project, { recursive: true, force: true });
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
