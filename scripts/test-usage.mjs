/**
 * Учёт токенов (бэклог A3.8).
 */
import { normalizeUsage, addUsage, sessionUsage, isStreamOptionsRejected } from '../electron/lib/usage.js';

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

console.log('\n[1] Форматы провайдеров');
const chat = normalizeUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } });
check('chat.completions', chat.input === 100 && chat.output === 20 && chat.total === 120 && chat.cached === 64, JSON.stringify(chat));
const resp = normalizeUsage({ input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 10 } });
check('Responses API, total посчитан', resp.input === 50 && resp.total === 55 && resp.cached === 10, JSON.stringify(resp));
check('DeepSeek prompt_cache_hit_tokens', normalizeUsage({ prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 8 }).cached === 8);
check('пусто → null', normalizeUsage({}) === null && normalizeUsage(null) === null);

console.log('\n[2] Сумма');
check('addUsage складывает', addUsage(chat, resp).total === 175);
check('addUsage с null', addUsage(null, chat).total === 120);
const total = sessionUsage([{ role: 'user' }, { role: 'assistant', usage: chat }, { role: 'assistant' }, { role: 'assistant', usage: resp }]);
check('sessionUsage по ответам', total.input === 150 && total.output === 25, JSON.stringify(total));

console.log('\n[3] Шлюз без stream_options');
check('400 про stream_options распознан', isStreamOptionsRejected({ status: 400, message: 'Unrecognized request argument: stream_options' }));
check('другой 400 — нет', !isStreamOptionsRejected({ status: 400, message: 'bad model' }));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
