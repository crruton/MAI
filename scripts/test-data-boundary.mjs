/**
 * Границы данных (N2, ADR 0098): локальные адреса, уровни и чек-лист.
 */
import { isLocalUrl, dataBoundaryReport } from '../electron/lib/data-boundary.js';

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

console.log('[1] локальные адреса');
check('localhost, 127.x, ::1, частные сети, .local', ['http://localhost:11434', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080', 'http://10.1.2.3', 'http://192.168.0.5:8000', 'http://172.20.0.2', 'http://gpu.local:8000'].every(isLocalUrl));
check('внешние и мусор — нет', !['https://api.openai.com/v1', 'http://172.32.0.1', 'http://8.8.8.8', 'не адрес', ''].some(isLocalUrl));

console.log('[2] облачная конфигурация');
const cloud = {
  activeModel: 'openai/gpt-5',
  fallbackModel: 'mai/glm',
  providers: { openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1' }, mai: { name: 'MAI', baseURL: 'https://api-ai.mai.ru/v1' }, ollama: { name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1' } },
  telemetry: { enabled: true, endpoint: 'https://otel.example.com' },
  notifications: { channels: [{ type: 'telegram', enabled: true }] },
  voice: { engine: 'provider', model: 'openai/whisper-1' },
  runtimes: { claude: { command: 'claude' } },
  infra: { postgresUrl: 'postgres://u:p@db.example.com:5432/mai', seaweedUrl: 'http://127.0.0.1:8888' },
};
let r = dataBoundaryReport(cloud, { mcp: [{ name: 'files', url: '' }, { name: 'remote', url: 'https://mcp.example.com/mcp' }], connectors: [{ name: 'notion', connected: true }], schedules: [{ title: 'Отчёт', model: '', enabled: true }, { title: 'Выкл', enabled: false }] });
const titles = r.findings.map((f) => `${f.level}:${f.title}`);
check('не строго локально, сначала fail', !r.strictLocal && r.findings[0].level === 'fail' && r.counts.fail === 3, titles.join(' | '));
check('fail: модель чата, запасная, плановая задача на облаке', titles.includes('fail:Модель чата — облако: OpenAI') && titles.includes('fail:Модель запасная — облако: MAI') && titles.some((t) => /fail:Плановые задачи на облачной модели: 1/.test(t)));
check('warn: телеметрия, удалённый MCP, коннектор, веб, браузер, мессенджер, голос, рантайм, Postgres', ['Телеметрия уходит наружу', 'Удалённый MCP-сервер «remote»', 'Подключены коннекторы: notion', 'Веб-инструменты включены', 'Браузер агента включён', 'Уведомления в мессенджеры: telegram', 'Голос распознаёт облачный провайдер OpenAI', 'Внешние рантаймы: claude', 'Postgres на внешнем сервере'].every((t) => titles.includes(`warn:${t}`)), titles.join(' | '));
check('info: локальный MCP и SeaweedFS', titles.includes('info:Локальные MCP-серверы: 1') && titles.includes('info:SeaweedFS — локально'));
check('пароль из Postgres URL не попал в отчёт', !JSON.stringify(r).includes('u:p@'));
check('чек-лист: модели и плановые — нет', r.checklist.find((c) => /модели чата/.test(c.label)).ok === false && r.checklist.find((c) => /плановые/.test(c.label)).ok === false);

console.log('[3] строго локальная конфигурация');
const local = {
  activeModel: 'ollama/qwen3:8b',
  providers: { ollama: { name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1' } },
  telemetry: { enabled: true, endpoint: 'http://127.0.0.1:4318' },
  webTools: false,
  browserEnabled: false,
  voice: { engine: 'mas' },
  mas: { url: 'http://127.0.0.1:8765' },
};
r = dataBoundaryReport(local, { mcp: [{ name: 'repowise', url: '' }], schedules: [{ title: 'Ночная', model: 'ollama/qwen3:8b', enabled: true }] });
check('строго локально, нет fail и warn', r.strictLocal && r.counts.fail === 0 && r.counts.warn === 0, JSON.stringify(r.findings.filter((f) => f.level !== 'info')));
check('все пункты чек-листа ✓', r.checklist.length >= 10 && r.checklist.every((c) => c.ok), JSON.stringify(r.checklist.filter((c) => !c.ok)));
check('без модели — пункт моделей не ✓', dataBoundaryReport({ ...local, activeModel: '' }, {}).checklist.find((c) => /модели/.test(c.label)).ok === false);
check('модель без префикса — провайдер mai', dataBoundaryReport({ activeModel: 'glm', providers: { mai: { name: 'MAI', baseURL: 'https://api-ai.mai.ru/v1' } } }, {}).findings[0].title === 'Модель чата — облако: MAI');

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
