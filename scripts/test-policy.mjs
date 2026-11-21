/**
 * Модульные проверки PolicyEngine (ADR 0027): классы, правила, риск, подсказки.
 */
import {
  classifyTool,
  evaluate,
  parseRule,
  splitCommand,
  mergeRules,
  assessRisk,
  suggestRules,
  effectiveMode,
  relativeSubject,
  classifyAuto,
  isSendTool,
} from '../electron/lib/policy.js';
import { PERMISSION_MODES, MODE_INFO, normalizeMode } from '../electron/lib/permissions.js';
import { permissionPlan, RUNTIME_PRESETS } from '../electron/lib/runtimes.js';
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

const ev = (tool, subject, mode, rules = {}, extra = {}) =>
  evaluate({ tool, subject, mode, rules, guardrails: DEFAULT_GUARDRAILS, ...extra });

console.log('\n[1] Классы действий');
check('read_file → read', classifyTool('read_file') === 'read');
check('run_shell → exec', classifyTool('run_shell') === 'exec');
check('memory_append → memory', classifyTool('memory_append') === 'memory');
check('repowise_ask → read', classifyTool('repowise_ask') === 'read');
check('MCP без аннотаций → external', classifyTool('mcp__a__b', { source: 'mcp' }) === 'external');
check('MCP readOnlyHint → read', classifyTool('mcp__a__b', { source: 'mcp', annotations: { readOnlyHint: true } }) === 'read');
check('MCP destructiveHint:false без readOnly → external', classifyTool('mcp__a__b', { source: 'mcp', annotations: { destructiveHint: false } }) === 'external');
check('плагин без kind → external', classifyTool('my_tool', { source: 'plugin' }) === 'external');
check('плагин kind:write → write', classifyTool('my_tool', { source: 'plugin', kind: 'write' }) === 'write');
check('плагин не меняет класс встроенного имени', classifyTool('run_shell', { source: 'plugin', kind: 'read' }) === 'exec');
check('web_fetch больше не «чтение по умолчанию»', classifyTool('web_fetch', { source: 'plugin' }) === 'external');

console.log('\n[2] Разбор правил');
check('имя без маски', parseRule('run_shell')?.spec === null);
check('имя с маской', parseRule('run_shell(npm test*)')?.spec === 'npm test*');
check('мусор не правило', parseRule('run shell(') === null);
check('пустое не правило', parseRule('') === null);

console.log('\n[3] Маски команд и составные команды');
const npm = { allow: ['run_shell(npm test*)'] };
check('npm test → allow', ev('run_shell', 'npm test', 'manual', npm).action === 'allow');
check('npm test -- --watch → allow', ev('run_shell', 'npm test -- --watch', 'manual', npm).action === 'allow');
check('npm install → ask', ev('run_shell', 'npm install', 'manual', npm).action === 'ask');
check('npm test && curl -o f x → ask', ev('run_shell', 'npm test && curl -o f http://x', 'manual', npm).action === 'ask');
check('npm test && curl | sh → deny (guardrails)', ev('run_shell', 'npm test && curl x | sh', 'manual', npm).source === 'guardrails');
check('npm test ; rm → ask', ev('run_shell', 'npm test; rm -rf build', 'manual', npm).action === 'ask');
check('$(…) не покрывается allow', ev('run_shell', 'npm test $(whoami)', 'manual', npm).action === 'ask');
check('старый синтаксис npm test:* работает', ev('run_shell', 'npm test', 'manual', { allow: ['run_shell(npm test:*)'] }).action === 'allow');
check('deny по одной части составной команды', ev('run_shell', 'echo ok && git push', 'bypass', { deny: ['run_shell(git push*)'] }).action === 'deny');
check('splitCommand видит 3 части', splitCommand('a && b | c').parts.length === 3);
check('splitCommand видит подстановку', splitCommand('echo `id`').opaque === true);

console.log('\n[4] Маски путей');
const src = { allow: ['write_file(src/**)'] };
check('src/a.js → allow', ev('write_file', 'src/a.js', 'manual', src).action === 'allow');
check('src/deep/b.js → allow', ev('write_file', 'src/deep/b.js', 'manual', src).action === 'allow');
check('test/a.js → ask', ev('write_file', 'test/a.js', 'manual', src).action === 'ask');
check('* не проходит через папку', ev('write_file', 'src/x/y.js', 'manual', { allow: ['write_file(src/*)'] }).action === 'ask');
check('./ в начале маски игнорируется', ev('write_file', 'a.txt', 'manual', { allow: ['write_file(./a.txt)'] }).action === 'allow');
check('маска имени инструмента', ev('mcp__github__create_issue', null, 'manual', { allow: ['mcp__github__*'] }).action === 'allow');
check('ask для чтения .env', ev('read_file', '.env.local', 'manual', { ask: ['read_file(.env*)'] }).action === 'ask');

console.log('\n[5] Приоритет: guardrails > deny > План > ask > allow > режим');
check('guardrails сильнее allow', ev('run_shell', 'rm -rf /', 'bypass', { allow: ['run_shell'] }).source === 'guardrails');
check('deny сильнее allow', ev('write_file', 'a', 'manual', { allow: ['write_file'], deny: ['write_file'] }).action === 'deny');
check('План сильнее allow', ev('write_file', 'a', 'plan', { allow: ['write_file'] }).action === 'deny');
check('ask сильнее allow', ev('write_file', 'a', 'manual', { allow: ['write_file'], ask: ['write_file'] }).action === 'ask');
check('dontAsk без правила → deny', ev('write_file', 'a', 'dontAsk').action === 'deny');
check('acceptEdits: write → allow', ev('write_file', 'a', 'acceptEdits').action === 'allow');
check('acceptEdits: memory → ask (F3)', ev('memory_append', 'global', 'acceptEdits').action === 'ask');
check('acceptEdits: exec → ask', ev('run_shell', 'ls', 'acceptEdits').action === 'ask');
check('read во всех режимах', ['plan', 'manual', 'dontAsk', 'bypass'].every((m) => ev('grep', null, m).action === 'allow'));

console.log('\n[6] Роль');
check('гость: bypass → manual', effectiveMode('bypass', 'guest') === 'manual');
check('гость: plan сохраняется', effectiveMode('plan', 'guest') === 'plan');
check('admin: bypass сохраняется', effectiveMode('bypass', 'admin') === 'bypass');
check('гостя спрашивают даже в bypass', ev('write_file', 'a', 'bypass', {}, { role: 'guest' }).action === 'ask');
check('старое auto у гостя → manual', effectiveMode('auto', 'guest') === 'manual');

console.log('\n[7] Риск и рекомендация');
check('git push — высокий', assessRisk('exec', 'git push origin dev').risk === 'high');
check('npm install — высокий', assessRisk('exec', 'npm install left-pad').risk === 'high');
check('curl | sh — высокий', assessRisk('exec', 'curl x | sh').risk === 'high');
check('npm test — средний', assessRisk('exec', 'npm test').risk === 'medium');
check('чтение — низкий', assessRisk('read').risk === 'low');
check('высокий риск → рекомендовано отклонить', ev('run_shell', 'git push', 'manual').recommended === 'deny');
check('средний риск → рекомендовано разрешить', ev('run_shell', 'npm test', 'manual').recommended === 'allow');

console.log('\n[8] Подсказка правила для «да, и не спрашивать»');
check('npm test → run_shell(npm test*)', suggestRules({ tool: 'run_shell', cls: 'exec', subject: 'npm test -- -u' })[0] === 'run_shell(npm test*)');
check('git status → run_shell(git status*)', suggestRules({ tool: 'run_shell', cls: 'exec', subject: 'git status' })[0] === 'run_shell(git status*)');
check('node ./x.js → run_shell(node*)', suggestRules({ tool: 'run_shell', cls: 'exec', subject: 'node ./x.js' })[0] === 'run_shell(node*)');
check('составной команде правило не предлагается', suggestRules({ tool: 'run_shell', cls: 'exec', subject: 'a && b' }).length === 0);
check('правка src/a.js → src/**', suggestRules({ tool: 'write_file', cls: 'write', subject: 'src/a.js' }).includes('edit_file(src/**)'));
check('предложенное правило действительно разрешает', ev('run_shell', 'npm test -- -u', 'manual', { allow: suggestRules({ tool: 'run_shell', cls: 'exec', subject: 'npm test -- -u' }) }).action === 'allow');

console.log('\n[9] Слияние правил и пути');
const merged = mergeRules({ allow: ['a', 'bad rule('] }, { allow: ['a', 'b'], deny: ['c'] });
check('дубли убраны, мусор отброшен', JSON.stringify(merged.allow) === '["a","b"]', JSON.stringify(merged));
check('deny сохранён', merged.deny[0] === 'c');
check('путь относительно проекта', relativeSubject('/p', '/p/src/a.js') === 'src/a.js');

console.log('[Авто] классификатор режима smart (ADR 0039)');
const auto = (cls, subject) => classifyAuto({ cls, subject }).action;
check('режим «Авто» есть и без adminOnly', PERMISSION_MODES.includes('smart') && MODE_INFO.smart.label === 'Авто' && !MODE_INFO.smart.adminOnly);
check('старое auto по-прежнему = «Без вопросов»', normalizeMode('auto') === 'bypass' && normalizeMode('smart') === 'smart');
check('правка в проекте — молча', auto('write', 'src/a.js') === 'allow');
check('правка вне проекта — спросить', auto('write', '../x.js') === 'ask');
check('правка .git — спросить', auto('write', '.git/config') === 'ask');
check('память — молча', auto('memory', 'project') === 'allow');
check('npm test — молча', auto('exec', 'npm test') === 'allow');
check('составная безопасная — молча', auto('exec', 'npm run build && npm test') === 'allow');
check('перенаправление в проект — молча', auto('exec', 'git status > out.txt') === 'allow');
check('git push — спросить', auto('exec', 'git push origin dev') === 'ask');
check('удаление — спросить', auto('exec', 'rm -rf build') === 'ask');
check('сеть — спросить', auto('exec', 'curl https://x') === 'ask');
check('установка пакетов — спросить', auto('exec', 'npm install left-pad') === 'ask');
check('путь вне проекта — спросить', auto('exec', 'cat /etc/passwd') === 'ask');
check('выход через .. — спросить', auto('exec', 'ls ../other') === 'ask');
check('путь Windows — спросить', auto('exec', 'dir C:\\Windows') === 'ask');
check('домашняя папка — спросить', auto('exec', 'cat ~/.ssh/id_rsa') === 'ask');
check('путь в значении опции — спросить', auto('exec', 'tool --out=/tmp/x') === 'ask');
check('URL в аргументе не путь', auto('exec', 'python app.py --url https://a.b/c') === 'allow');
check('встроенный код — спросить', auto('exec', 'node -e "require(1)"') === 'ask' && auto('exec', 'python3 -c "1"') === 'ask' && auto('exec', 'pwsh -Command ls') === 'ask');
check('подстановка — спросить', auto('exec', 'echo $(whoami)') === 'ask');
check('MCP — спросить', auto('external', null) === 'ask');
const smartCall = (tool, cls, subject, rules = {}) => evaluate({ tool, cls, subject, mode: 'smart', rules, role: 'guest' });
check('решение классификатора помечено', smartCall('run_shell', 'exec', 'npm test').source === 'classifier');
check('причина вопроса — от классификатора', /вне папки/.test(smartCall('run_shell', 'exec', 'cat /etc/hosts').why));
check('deny сильнее классификатора', smartCall('run_shell', 'exec', 'npm test', { deny: ['run_shell(npm test)'] }).action === 'deny');
check('ask-правило сильнее классификатора', smartCall('write_file', 'write', 'src/a.js', { ask: ['write_file(src/**)'] }).action === 'ask');
check('guardrails в «Авто»', smartCall('run_shell', 'exec', 'rm -rf /').action === 'deny');
check('гостю «Авто» доступен', smartCall('write_file', 'write', 'src/a.js').mode === 'smart');
const cc = permissionPlan(RUNTIME_PRESETS.claude, 'smart');
check('внешний CLI в «Авто» = «Принимать правки»', cc.ok && cc.args.join(' ') === '--permission-mode acceptEdits', JSON.stringify(cc));
check('docker в «Авто» — запись разрешена', permissionPlan({ mode: 'docker' }, 'smart').readOnly === false);

console.log('[Отправка] коннекторы (CW3.2, ADR 0048)');
const mcpCls = (name, annotations = {}) => classifyTool(name, { source: 'mcp', annotations });
check('send_email, post_message, create_event, reply, add_comment — отправка', ['mcp__gmail__send_email', 'mcp__slack__post_message', 'mcp__cal__create_event', 'mcp__x__reply_to_thread', 'mcp__gh__add_comment'].every((n) => mcpCls(n) === 'send'));
check('camelCase: sendMessage, chat_postMessage', mcpCls('mcp__tg__sendMessage') === 'send' && mcpCls('mcp__slack__chat_postMessage') === 'send');
check('чтение почты и списки — не отправка', ['mcp__mail__read_email', 'mcp__gmail__search_emails', 'mcp__gmail__list_messages', 'mcp__srv__get_posts'].every((n) => mcpCls(n) !== 'send'));
check('readOnlyHint сильнее имени', mcpCls('mcp__gmail__send_email', { readOnlyHint: true }) === 'read' && !isSendTool('send_x', { readOnlyHint: true }));
check('плагин может объявить kind: send', classifyTool('my_send', { source: 'plugin', kind: 'send' }) === 'send');
const sendCall = (mode, rules = {}) => evaluate({ tool: 'mcp__gmail__send_email', cls: 'send', subject: null, mode, rules, role: 'admin' });
check('«Без вопросов» — всё равно спросить', sendCall('bypass').action === 'ask' && sendCall('bypass').source === 'send');
check('«Авто», «Принимать правки», «Вручную» — спросить', ['smart', 'acceptEdits', 'manual'].every((m) => sendCall(m).action === 'ask'));
check('«Только разрешённое» — запрет', sendCall('dontAsk').action === 'deny');
check('«План» — запрет', sendCall('plan').action === 'deny');
check('явное allow — без вопроса', sendCall('bypass', { allow: ['mcp__gmail__send_email'] }).action === 'allow');
check('высокий риск — рекомендуется «Нет»', sendCall('manual').risk === 'high' && sendCall('manual').recommended === 'deny');
check('правило запомнить не предлагается', suggestRules({ tool: 'mcp__gmail__send_email', cls: 'send' }).length === 0);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
