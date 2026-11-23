/**
 * Фильтр секретов в запросах к модели (N3, ADR 0099): поиск, знаки, обратная
 * подстановка, режимы, сообщения API.
 */
import { findSecrets, createSecretFilter, maskMessages, filterNotice } from '../electron/lib/secret-filter.js';

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
const types = (t) => findSecrets(t).map((h) => h.type);

console.log('[1] что находится');
// Формат Stripe в фикстуре не держим: push protection GitHub считает его настоящим ключом.
check('ключи OpenAI, Anthropic, GitHub, AWS, Google, Slack, Telegram', JSON.stringify(types('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC AKIAABCDEFGHIJKLMNOP AIzaSyD-1234567890abcdefghijklmnopqrstu xoxb-1234567890-abcdefghij 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0')) === JSON.stringify(['ключ-openai', 'ключ-anthropic', 'токен-github', 'ключ-aws', 'ключ-google', 'токен-slack', 'токен-telegram']), JSON.stringify(types('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB')));
check('JWT и Bearer', types('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c').includes('jwt') && types('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').includes('bearer'));
check('приватный ключ целиком', findSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----')[0]?.type === 'приватный-ключ');
const url = findSecrets('DATABASE_URL=postgres://admin:S3cretPass@db:5432/app');
check('пароль в адресе — только пароль', url.length === 1 && url[0].value === 'S3cretPass', JSON.stringify(url));
check('присваивания: password=, "api_key": "…", SECRET:', findSecrets('password=hunter2xyz').length === 1 && findSecrets('{"api_key": "abc123def456"}')[0]?.value === 'abc123def456' && findSecrets('CLIENT_SECRET: zz9988776655')[0]?.value === 'zz9988776655');
check('карта — только с контрольной суммой Луна', types('карта 4111 1111 1111 1111').includes('карта') && !types('счёт 1234 5678 9012 3456').includes('карта') && !types('0000000000000000').includes('карта'));
check('заглушки не секреты: ${TOKEN}, process.env, ***, <ключ>, changeme', ['token=${TOKEN}', 'apiKey = process.env.OPENAI_KEY', 'password: ********', 'api_key=<ваш ключ>', 'password=changeme', 'token: true'].every((t) => findSecrets(t).length === 0), JSON.stringify(['token=${TOKEN}', 'apiKey = process.env.OPENAI_KEY'].map(findSecrets)));
check('обычный текст и код — чисто', findSecrets('function add(a, b) { return a + b; }\nВерсия 1.2.3, порт 8080, телефон 8 800 555 35 35').length === 0);

console.log('[2] знаки и обратная подстановка');
const f = createSecretFilter();
const text = 'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12\nDB=postgres://u:Passw0rd!@h/db';
const masked = f.mask(text);
check('значения заменены знаками', !masked.includes('sk-proj-ABC') && !masked.includes('Passw0rd!') && /\[СКРЫТО:ключ-openai:[0-9a-f]{6}\]/.test(masked) && /u:\[СКРЫТО:пароль:[0-9a-f]{6}\]@h/.test(masked), masked);
check('одно значение — один знак везде', f.mask('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12') === createSecretFilter().mask('и sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12').slice(2));
check('обратно — исходный текст', f.unmask(masked) === text);
check('чужой знак не трогается', f.unmask('[СКРЫТО:пароль:ffffff]') === '[СКРЫТО:пароль:ffffff]');
check('повторная маска знаков не меняет', f.mask(masked) === masked);
check('найдено по типам', JSON.stringify(f.found()) === JSON.stringify({ 'ключ-openai': 1, 'пароль': 1 }));

console.log('[3] режимы');
const warn = createSecretFilter({ mode: 'warn' });
check('warn — текст как есть, но найдено', warn.mask(text) === text && warn.found()['пароль'] === 1);
check('off — ничего', createSecretFilter({ mode: 'off' }).mask(text) === text);
check('неизвестный режим → mask', createSecretFilter({ mode: 'x' }).mode === 'mask');
check('уведомления по режимам', /Скрыто от модели: ключ-openai ×1/.test(filterNotice({ 'ключ-openai': 1 }, 'mask')) && /отправлены как есть/.test(filterNotice({ a: 1 }, 'warn')) && /Запрос не отправлен/.test(filterNotice({ a: 1 }, 'block')) && filterNotice({}, 'mask') === '');

console.log('[4] сообщения API');
const mf = createSecretFilter();
const out = maskMessages([
  { role: 'system', content: 'AGENTS: token=abcdef123456' },
  { role: 'user', content: [{ type: 'text', text: 'ключ sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12' }, { type: 'image_url', image_url: { url: 'data:…' } }] },
  { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: '{"content":"password=hunter2xyz"}' } }] },
  { role: 'tool', tool_call_id: '1', content: 'AWS AKIAABCDEFGHIJKLMNOP' },
], mf);
const dump = JSON.stringify(out);
check('система, части content, аргументы вызовов, результаты — без секретов', !/abcdef123456|sk-proj-ABC|hunter2xyz|AKIAABCDEFGHIJKLMNOP/.test(dump) && out[1].content[1].type === 'image_url', dump);
check('исходные сообщения не изменены', !JSON.stringify(out).includes('hunter2xyz'));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
