/**
 * Локальные модели (N4, ADR 0100): обнаружение серверов и запись провайдера.
 */
import http from 'node:http';
import { detectLocalModels, providerFromLocal, parseModels, LOCAL_SERVERS } from '../electron/lib/local-models.js';

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
const serve = (handler) =>
  new Promise((r) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => r(s));
  });

console.log('[1] разбор');
check('стандартные порты', LOCAL_SERVERS.map((s) => `${s.id}:${s.port}`).join() === 'ollama:11434,lmstudio:1234,colibri:8000,llamacpp:8080,jan:1337');
check('/v1/models: data[].id и models[].name', parseModels({ data: [{ id: 'qwen3:8b' }] }).join() === 'qwen3:8b' && parseModels({ models: [{ name: 'llama3' }] }).join() === 'llama3' && parseModels(null).length === 0);

console.log('[2] обнаружение');
const ollama = await serve((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'nomic-embed-text' }, { id: 'qwen3:8b' }, { id: 'llama3.2' }] }));
  res.statusCode = 404;
  res.end('{}');
});
const empty = await serve((req, res) => res.end(JSON.stringify({ data: [] })));
const broken = await serve((req, res) => {
  res.statusCode = 500;
  res.end('oops');
});
const servers = [
  { id: 'ollama', name: 'Ollama', port: ollama.address().port, hint: 'ollama serve' },
  { id: 'lmstudio', name: 'LM Studio', port: empty.address().port, hint: 'Start Server' },
  { id: 'jan', name: 'Jan', port: broken.address().port, hint: 'x' },
  { id: 'colibri', name: 'colibri или vLLM', port: 1, hint: 'coli serve' },
];
let found = await detectLocalModels({ servers, timeoutMs: 800 });
const byId = Object.fromEntries(found.map((f) => [f.id, f]));
check('найдены отвечающие: Ollama и пустой LM Studio; 500 и закрытый порт — нет', Object.keys(byId).sort().join() === 'lmstudio,ollama', JSON.stringify(found));
check('модели: чатовые первыми, эмбеддинги — в конце', byId.ollama.models.join() === 'qwen3:8b,llama3.2,nomic-embed-text');
check('пустой сервер помечен', byId.lmstudio.empty && byId.lmstudio.models.length === 0);
const base = byId.ollama.baseURL;
found = await detectLocalModels({ servers, timeoutMs: 800, providers: { myollama: { baseURL: `${base}/` } } });
check('уже добавленный — added и id провайдера', found.find((f) => f.id === 'ollama').added && found.find((f) => f.id === 'ollama').providerId === 'myollama');

console.log('[3] провайдер');
const f = found.find((x) => x.id === 'ollama');
let p = providerFromLocal(f, {});
check('id, имя, адрес, ключ «local», модели', p.id === 'ollama' && p.provider.name === 'Ollama (локально)' && p.provider.baseURL === base && p.provider.apiKey === 'local' && p.provider.models[0].id === 'qwen3:8b');
p = providerFromLocal(f, { ollama: { baseURL: 'http://10.0.0.5:11434/v1' } });
check('id занят другим адресом — ollama-2', p.id === 'ollama-2');
check('colibri — своё имя', providerFromLocal({ id: 'colibri', name: 'colibri или vLLM', baseURL: 'http://127.0.0.1:8000/v1', models: ['qwen36'] }, {}).provider.name === 'colibri (локально)');

for (const s of [ollama, empty, broken]) s.close();
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
