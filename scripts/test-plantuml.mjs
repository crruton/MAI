/**
 * Рендер PlantUML (ADR 0127): поиск Java и jar, кодирование для сервера, очистка SVG, кэш,
 * слияние запросов, таймаут, ошибки настройки. Живой рендер — если на машине есть Java и jar.
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { findJava, findJar, encodePlantuml, sanitizeSvg, createPlantuml } from '../electron/lib/plantuml.js';
import { generateViews } from '../electron/lib/boards.js';
import fs from 'node:fs';
import os from 'node:os';

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

console.log('[1] поиск Java и jar');
const has = (...files) => (f) => files.includes(f);
check('настройка главнее JAVA_HOME и PATH', findJava({ settings: { java: '/opt/j/java' }, env: { JAVA_HOME: '/jh', PATH: '/bin' }, exists: has('/opt/j/java', path.join('/jh', 'bin', 'java')), platform: 'linux' }) === '/opt/j/java');
check('JAVA_HOME, затем PATH', findJava({ env: { JAVA_HOME: '/jh', PATH: '/usr/bin' }, exists: has(path.join('/usr/bin', 'java')), platform: 'linux' }) === path.join('/usr/bin', 'java'));
check('нет Java — пустая строка', findJava({ env: { PATH: '' }, exists: () => false, platform: 'linux' }) === '');
check('jar: настройка, затем PLANTUML_JAR', findJar({ settings: {}, env: { PLANTUML_JAR: '/x/p.jar' }, exists: has('/x/p.jar') }) === '/x/p.jar');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-puml-'));
fs.mkdirSync(path.join(data, 'plantuml'));
for (const f of ['plantuml-1.2025.1.jar', 'plantuml-1.2026.6.jar', 'readme.txt']) fs.writeFileSync(path.join(data, 'plantuml', f), '');
check('jar из папки данных MAI — самая новая версия', findJar({ env: {}, dataDir: data }) === path.join(data, 'plantuml', 'plantuml-1.2026.6.jar'));
fs.rmSync(data, { recursive: true, force: true });

console.log('[2] кодирование и очистка');
check('кодирование для сервера — эталон из документации PlantUML', encodePlantuml('Bob -> Alice : hello') === 'SyfFKj2rKt3CoKnELR1Io4ZDoSa70000', encodePlantuml('Bob -> Alice : hello'));
const dirty = '<?xml version="1.0"?><svg onload="x()"><script>alert(1)</script><a href="javascript:alert(1)"><text onclick=\'y()\'>A</text></a><foreignObject><div>z</div></foreignObject></svg>';
const clean = sanitizeSvg(dirty);
check('SVG без скриптов, обработчиков, javascript: и foreignObject', !/script|onload|onclick|javascript:|foreignObject|<\?xml/i.test(clean) && /<text>A<\/text>/.test(clean), clean);

console.log('[3] рендер через Java (поддельный процесс)');
function fakeSpawn({ stdout = '<svg>ok</svg>', code = 0, delay = 5, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { on() {}, end: (text) => { input = text; } };
    child.kill = () => setTimeout(() => child.emit('close', null, 'SIGTERM'), 1);
    calls.push({ cmd, args, get input() { return input; } });
    if (!hang) setTimeout(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code, null); }, delay);
    return child;
  };
  return { calls, spawnImpl };
}
const local = { plantuml: { java: '/j', jar: '/p.jar' } };
const realExists = fs.existsSync;
fs.existsSync = (f) => f === '/j' || f === '/p.jar' || realExists(f);
try {
  let f = fakeSpawn();
  let p = createPlantuml({ getSettings: () => local, spawnImpl: f.spawnImpl });
  const [a, b] = await Promise.all([p.render('@startuml\nA->B\n@enduml'), p.render('@startuml\nA->B\n@enduml')]);
  check('одинаковые запросы — один запуск JVM', a.ok && b.ok && f.calls.length === 1 && a.svg === '<svg>ok</svg>');
  check('безопасный профиль, -pipe, текст в stdin', f.calls[0].args.includes('-DPLANTUML_SECURITY_PROFILE=SANDBOX') && f.calls[0].args.includes('-pipe') && f.calls[0].args.includes('-tsvg') && /A->B/.test(f.calls[0].input), JSON.stringify(f.calls[0].args));
  await p.render('@startuml\nA->B\n@enduml');
  check('повтор — из кэша', f.calls.length === 1);
  f = fakeSpawn({ stdout: '<svg><text>Syntax Error?</text></svg>', code: 200 });
  p = createPlantuml({ getSettings: () => local, spawnImpl: f.spawnImpl });
  let r = await p.render('@startuml\n(((\n@enduml');
  check('ошибка схемы — ok: false, картинка ошибки сохраняется', !r.ok && /ошибка в схеме/.test(r.error) && /Syntax Error/.test(r.svg));
  f = fakeSpawn({ hang: true });
  p = createPlantuml({ getSettings: () => local, spawnImpl: f.spawnImpl, timeoutMs: 30 });
  r = await p.render('@startuml\nA->B\n@enduml');
  check('зависший PlantUML — таймаут', !r.ok && /таймауту/.test(r.error), r.error);
  f = fakeSpawn({ stdout: '\x89PNG..' });
  p = createPlantuml({ getSettings: () => local, spawnImpl: f.spawnImpl });
  r = await p.render('@startuml\nA->B\n@enduml', 'png');
  check('PNG — буфер, формат -tpng', r.ok && Buffer.isBuffer(r.png) && f.calls[0].args.includes('-tpng'));
  check('пустая и огромная схема отклоняются без запуска', !(await p.render('  ')).ok && !(await p.render('x'.repeat(200_001))).ok && f.calls.length === 1);
} finally {
  fs.existsSync = realExists;
}

console.log('[4] сервер и отсутствие настройки');
const fetched = [];
let p = createPlantuml({ getSettings: () => ({ plantuml: { java: '/нет', jar: '/нет.jar', server: 'https://puml.example/' } }), env: { PATH: '' }, fetchImpl: async (url) => { fetched.push(url); return { ok: true, status: 200, text: async () => '<svg>srv</svg>' }; } });
let r = await p.render('Bob -> Alice : hello');
check('без Java — сервер команды, адрес /svg/<код>', r.ok && r.engine === 'server' && fetched[0] === 'https://puml.example/svg/SyfFKj2rKt3CoKnELR1Io4ZDoSa70000', fetched[0]);
p = createPlantuml({ getSettings: () => ({ plantuml: { java: '/нет', jar: '/нет.jar', server: 'ftp://x' } }), env: { PATH: '' }, dataDir: '/data' });
r = await p.render('@startuml\nA->B\n@enduml');
check('ничего не настроено — понятная подсказка, публичный сервер не используется', !r.ok && r.setup && /PlantUML не настроен/.test(r.error) && /plantuml/.test(r.error) && p.status().ready === false, r.error);

console.log('[5] живой рендер всех представлений доски');
const live = createPlantuml({ dataDir: path.join(os.homedir(), 'AppData', 'Roaming', 'mai-code') });
if (!live.status().ready) {
  console.log('  —    пропуск: нет Java и plantuml.jar на этой машине');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-views-'));
  const { views } = generateViews(dir, '');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(views)) {
    if (!v.puml) continue;
    const res = await live.render(v.puml);
    check(`${k}: PlantUML рисует без ошибок`, res.ok && /<svg/.test(res.svg), res.error);
  }
  const blocked = await live.render('@startuml\n!include C:/Windows/win.ini\nA -> B\n@enduml');
  check('!include локального файла запрещён профилем SANDBOX', !/\[fonts\]|\[extensions\]/i.test(blocked.svg || ''));
}

console.log(`\nplantuml: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
