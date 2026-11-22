/**
 * Разбор флагов и вывод безголового режима (CC12.1, CC12.2, ADR 0077).
 */
import { isCliInvocation, parseCliArgs, resultObject, streamLine } from '../electron/lib/cli.js';

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

console.log('[1] это CLI?');
check('-p, --print, --cli — да; обычный запуск — нет', isCliInvocation(['x', '-p', 'a']) && isCliInvocation(['x', '--cli']) && isCliInvocation(['x', '--print=a']) && !isCliInvocation(['x', '.']));

console.log('[2] флаги');
let o = parseCliArgs(['/app', '--cli', '-p', 'сделай', '--mode', 'acceptEdits', '--output', 'stream-json', '--model', 'mai/x', '--kind', 'task', '--cwd', '/p', '--max-turns', '5', '--allow', 'run_shell(npm test*)', '--allow', 'write_file(*.md)'], { cwd: '/home' });
check('все флаги', !o.error && o.prompt === 'сделай' && o.mode === 'acceptEdits' && o.output === 'stream-json' && o.model === 'mai/x' && o.kind === 'task' && o.cwd === '/p' && o.maxTurns === 5 && o.allow.length === 2, JSON.stringify(o));
o = parseCliArgs(['-p', 'x'], { cwd: '/home' });
check('по умолчанию: dontAsk, text, code, текущая папка', o.mode === 'dontAsk' && o.output === 'text' && o.kind === 'code' && o.cwd === '/home');
o = parseCliArgs(['--print=задача', '--output=json']);
check('флаг=значение', o.prompt === 'задача' && o.output === 'json', JSON.stringify(o));
check('-p - — из stdin', parseCliArgs(['-p', '-']).fromStdin === true && !parseCliArgs(['-p', '-']).error);
check('флаги Chromium и путь приложения пропускаются', !parseCliArgs(['/app', '--no-sandbox', '--user-data-dir=/d', '--ozone-platform=headless', '-p', 'x']).error);
check('--help', parseCliArgs(['--cli', '--help']).help === true);
for (const [args, re] of [
  [['-p', 'x', '--mode', 'yolo'], /--mode/],
  [['-p', 'x', '--output', 'xml'], /--output/],
  [['-p', 'x', '--max-turns', '0'], /--max-turns/],
  [['-p', 'x', '--kind', 'chat'], /--kind/],
  [['-p', 'x', '--wat'], /неизвестный флаг/],
  [['--cli'], /нет задачи/],
  [['-p'], /нужно значение/],
]) {
  const r = parseCliArgs(args);
  check(`ошибка: ${args.join(' ')}`, re.test(r.error || ''), r.error);
}

console.log('[3] вывод');
const res = resultObject({ ok: true, answer: 'готово', sessionId: 's1', model: 'mai/x', mode: 'plan', durationMs: 12, usage: { input: 5, output: 7 } });
check('итог: type, ok, result, session_id, usage', res.type === 'result' && res.ok && res.result === 'готово' && res.session_id === 's1' && res.usage.output === 7 && !('error' in res));
const bad = resultObject({ ok: false, error: 'нет ключа', denied: [{ tool: 'write_file' }] });
check('ошибка: result пустой, error и denied', bad.result === '' && bad.error === 'нет ключа' && bad.denied.length === 1);
check('строка события — JSON с type', JSON.parse(streamLine({ type: 'tool_call', name: 'read_file' })).type === 'tool_call');

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
