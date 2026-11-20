/**
 * Внешние рантаймы (ADR 0029): режим разрешений, сборка команды, запуск без оболочки.
 */
import {
  RUNTIME_PRESETS,
  permissionPlan,
  buildCommand,
  buildDockerCommand,
  spawnPlan,
  escapeCmdArgument,
  startRuntime,
  supportsStdin,
} from '../electron/lib/runtimes.js';

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

const preset = (id, extra = {}) => ({ ...RUNTIME_PRESETS[id], args: [...RUNTIME_PRESETS[id].args], ...extra });
const vars = { prompt: 'сделай', model: 'm', projectDir: '/p', target: '' };

console.log('\n[1] Режим разрешений → флаги CLI');
check('Claude «План» → --permission-mode plan', permissionPlan(preset('claude'), 'plan').args.join(' ') === '--permission-mode plan');
check('Claude «Без вопросов» → bypassPermissions', permissionPlan(preset('claude'), 'bypass').args.includes('bypassPermissions'));
check('Codex «Вручную» → read-only', permissionPlan(preset('codex'), 'manual').args.join(' ') === '--sandbox read-only');
check('Codex «Правки» → workspace-write', permissionPlan(preset('codex'), 'acceptEdits').args.includes('workspace-write'));
check('Gemini «План» на хосте — отказ', permissionPlan(preset('gemini'), 'plan').ok === false);
check('Gemini «Правки» → auto_edit', permissionPlan(preset('gemini'), 'acceptEdits').args.includes('auto_edit'));
check('OpenCode «Вручную» на хосте — отказ', permissionPlan(preset('opencode'), 'manual').ok === false);
check('OpenCode «Правки» на хосте — отказ', permissionPlan(preset('opencode'), 'acceptEdits').ok === false);
check('OpenCode «Без вопросов» — запуск', permissionPlan(preset('opencode'), 'bypass').ok === true);
check('в отказе есть подсказка про docker', /docker/.test(permissionPlan(preset('opencode'), 'plan').error || ''));
const docker = preset('opencode', { mode: 'docker', image: 'img' });
check('docker «План» — только чтение', permissionPlan(docker, 'plan').readOnly === true);
check('docker «Вручную» — только чтение', permissionPlan(docker, 'manual').readOnly === true);
check('docker «Правки» — запись', permissionPlan(docker, 'acceptEdits').readOnly === false);
check('сменили команду пресета — флаги пресета не применяются', permissionPlan({ ...preset('claude'), command: 'my-claude', permissionArgs: undefined }, 'plan').ok === false);
check('свои флаги в permissionArgs работают', permissionPlan({ command: 'x', permissionArgs: { plan: ['--ro'] } }, 'plan').args[0] === '--ro');

console.log('\n[2] Сборка команды');
const codexPlan = buildCommand(preset('codex'), vars, { modeArgs: ['--sandbox', 'read-only'] });
check('флаги Codex после подкоманды exec', codexPlan.args.join(' ') === 'exec --sandbox read-only сделай', codexPlan.args.join(' '));
const claudePlan = buildCommand(preset('claude'), vars, { modeArgs: ['--permission-mode', 'plan'] });
check('флаги Claude в начале', claudePlan.args.join(' ') === '--permission-mode plan -p сделай', claudePlan.args.join(' '));
check('Codex через stdin: вместо запроса «-»', buildCommand(preset('codex'), vars, { stdin: true }).args.join(' ') === 'exec -');
check('Claude через stdin: запроса в аргументах нет', !buildCommand(preset('claude'), vars, { stdin: true }).args.includes('сделай'));
check('Claude и Codex умеют stdin', supportsStdin(preset('claude')) && supportsStdin(preset('codex')));
check('OpenCode stdin не объявлял', !supportsStdin(preset('opencode')));
const ro = buildDockerCommand(docker, vars, '/p', { readOnly: true });
check('docker: проект смонтирован :ro', ro.args.includes('/p:/workspace:ro'), ro.args.join(' '));
check('docker: без readOnly — rw', buildDockerCommand(docker, vars, '/p').args.includes('/p:/workspace'));

console.log('\n[3] Запуск без оболочки');
const posix = spawnPlan('claude', ['-p', 'a & b\n%PATH%'], { platform: 'linux' });
check('POSIX: аргументы без изменений', posix.file === 'claude' && posix.args[1] === 'a & b\n%PATH%');
const exe = spawnPlan('codex', ['exec', 'x & y'], { platform: 'win32', resolve: () => 'C:\\bin\\codex.exe' });
check('Windows .exe: без cmd.exe', exe.file.endsWith('codex.exe') && exe.args[1] === 'x & y' && !exe.shim);
const shim = spawnPlan('claude', ['-p', 'a & b | c %PATH% "q"\nвторая строка'], {
  platform: 'win32',
  resolve: () => 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
});
const line = shim.args[3];
check('Windows .cmd: через cmd.exe /d /s /c', shim.args.slice(0, 3).join(' ') === '/d /s /c' && shim.options.windowsVerbatimArguments === true);
check('& экранирован', line.includes('^&') && !/[^^]&/.test(line), line);
check('| экранирован', line.includes('^|'), line);
check('% экранирован', line.includes('^%PATH^%'), line);
check('кавычка в запросе экранирована', line.includes('\\^"q\\^"'), line);
check('перевода строки в командной строке нет', !/\n/.test(line));
check('замена перевода строки отмечена', shim.flattened === true);
const local = spawnPlan('tool', ['a&b'], { platform: 'win32', resolve: () => 'C:\\p\\node_modules\\.bin\\tool.cmd' });
check('node_modules/.bin: двойное экранирование', local.args[3].includes('^^^&'), local.args[3]);
check('escapeCmdArgument("foo bar") как в cross-spawn', escapeCmdArgument('foo bar') === '^"foo^ bar^"', escapeCmdArgument('foo bar'));
check('обратные слеши перед кавычкой удваиваются', escapeCmdArgument('a\\"b') === '^"a\\\\\\^"b^"', escapeCmdArgument('a\\"b'));

const run = (runtime, permissionMode, prompt) =>
  new Promise((resolve) => {
    let out = '';
    startRuntime({
      runtime,
      prompt,
      model: 'm',
      projectDir: process.cwd(),
      permissionMode,
      onData: (t) => {
        out += t;
      },
      onExit: (result) => resolve({ ...result, out }),
    });
  });

console.log('\n[4] Реальный процесс: запрос доходит без искажений');
const tricky = 'первая строка\nвторая & третья | "кавычки" %PATH% $HOME `id`';
const echoArg = {
  name: 'echo',
  command: process.execPath,
  args: ['-e', 'process.stdout.write(JSON.stringify(process.argv[1]))', '{prompt}'],
  permissionArgs: { manual: [] },
};
const a = await run(echoArg, 'manual', tricky);
check('аргументом: текст совпал байт в байт', a.code === 0 && JSON.parse(a.out) === tricky, a.out);
const echoStdin = {
  name: 'stdin',
  command: process.execPath,
  args: ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify(s)))", '{prompt}'],
  promptVia: 'stdin',
  stdin: { arg: '' },
  permissionArgs: { manual: [] },
};
const b = await run(echoStdin, 'manual', tricky);
check('через stdin: текст совпал', b.code === 0 && JSON.parse(b.out) === tricky, b.out);
const refused = await run({ name: 'cli', command: process.execPath, args: ['-e', '1'] }, 'plan', 'x');
check('режим без поддержки — процесс не запущен', refused.permissionDenied === true && refused.code === -1);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
