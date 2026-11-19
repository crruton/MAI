/**
 * Офлайн-тест транспорта /v1/responses: конвертация сообщений, схем
 * инструментов, разбор ответа и выбор параметров. Сеть не нужна.
 */
import assert from 'node:assert/strict';
import {
  splitSystem,
  toInput,
  toResponseTools,
  collectFromResponse,
  isResponsesRequired,
  supportsTemperature,
} from '../electron/lib/responses.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  OK   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

console.log('\n[1] Системный промпт выносится в instructions');
ok('system собирается в одну строку', () => {
  const { system, rest } = splitSystem([
    { role: 'system', content: 'А' },
    { role: 'user', content: 'вопрос' },
    { role: 'system', content: 'Б' },
  ]);
  assert.equal(system, 'А\n\nБ');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].role, 'user');
});
ok('без system пустая строка', () => {
  assert.equal(splitSystem([{ role: 'user', content: 'x' }]).system, '');
});

console.log('\n[2] Chat-история → input[]');
ok('user получает input_text', () => {
  const input = toInput([{ role: 'user', content: 'привет' }]);
  assert.equal(input[0].role, 'user');
  assert.equal(input[0].content[0].type, 'input_text');
});
ok('assistant получает output_text', () => {
  const input = toInput([{ role: 'assistant', content: 'ответ' }]);
  assert.equal(input[0].content[0].type, 'output_text');
});
ok('tool_calls становятся function_call', () => {
  const input = toInput([
    {
      role: 'assistant',
      content: 'читаю',
      tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
    },
  ]);
  assert.equal(input.length, 2, 'текст и вызов — отдельные items');
  assert.equal(input[0].content[0].text, 'читаю');
  assert.equal(input[1].type, 'function_call');
  assert.equal(input[1].call_id, 'c1');
  assert.equal(input[1].name, 'read_file');
  assert.equal(input[1].arguments, '{"path":"a"}');
});
ok('роль tool становится function_call_output', () => {
  const input = toInput([{ role: 'tool', tool_call_id: 'c1', content: 'содержимое' }]);
  assert.equal(input[0].type, 'function_call_output');
  assert.equal(input[0].call_id, 'c1');
  assert.equal(input[0].output, 'содержимое');
});
ok('пустые сообщения отбрасываются', () => {
  assert.equal(toInput([{ role: 'assistant', content: '' }]).length, 0);
});
ok('изображение уходит частью input_image, а не текстом', () => {
  const input = toInput([
    { role: 'user', content: [{ type: 'text', text: 'смотри' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]);
  assert.equal(input[0].content[0].type, 'input_text');
  assert.match(input[0].content[0].text, /смотри/);
  assert.equal(input[0].content[1].type, 'input_image');
  assert.equal(input[0].content[1].image_url, 'data:image/png;base64,AAAA');
});
ok('картинка в ответе инструмента не превращается в base64-текст', () => {
  const input = toInput([
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ]);
  assert.doesNotMatch(input[0].output, /base64/);
});

console.log('\n[3] Схемы инструментов');
ok('chat-обёртка function разворачивается', () => {
  const [tool] = toResponseTools([
    { schema: { type: 'function', function: { name: 'grep', description: 'd', parameters: { type: 'object' } } } },
  ]);
  assert.equal(tool.type, 'function');
  assert.equal(tool.name, 'grep');
  assert.equal(tool.function, undefined, 'обёртки function быть не должно');
  assert.deepEqual(tool.parameters, { type: 'object' });
});
ok('схема без имени отбрасывается', () => {
  assert.equal(toResponseTools([{ schema: { function: {} } }]).length, 0);
});

console.log('\n[4] Разбор готового ответа (fallback без дельт)');
ok('текст, reasoning и вызовы из output[]', () => {
  const parsed = collectFromResponse({
    output: [
      { type: 'reasoning', summary: [{ text: 'думаю' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'привет' }] },
      { type: 'function_call', call_id: 'c9', name: 'grep', arguments: '{"pattern":"x"}' },
    ],
  });
  assert.equal(parsed.content, 'привет');
  assert.equal(parsed.reasoning, 'думаю');
  assert.equal(parsed.toolCalls[0].id, 'c9');
  assert.equal(parsed.toolCalls[0].name, 'grep');
});
ok('пустой ответ не падает', () => {
  assert.deepEqual(collectFromResponse(undefined), { content: '', reasoning: '', toolCalls: [] });
});

console.log('\n[5] Детектор «нужен /v1/responses»');
ok('русско-китайское сообщение шлюза распознано', () => {
  assert.ok(isResponsesRequired({
    message: '模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses',
  }));
});
ok('английский вариант распознан', () => {
  assert.ok(isResponsesRequired({ message: 'does not support /v1/chat/completions, please use /v1/responses' }));
});
ok('обычная ошибка не считается', () => {
  assert.equal(isResponsesRequired({ message: 'invalid api key' }), false);
  assert.equal(isResponsesRequired({ message: '429 rate limit' }), false);
});

console.log('\n[6] Температура по имени модели');
ok('gpt-5+ не шлёт temperature', () => {
  assert.equal(supportsTemperature('gpt-5.6-sol'), false);
  assert.equal(supportsTemperature('gpt-6.1-sol'), false);
});
ok('остальные шлют', () => {
  assert.ok(supportsTemperature('deepseek-v4.1-flash'));
  assert.ok(supportsTemperature('qwen3.8-flash-next'));
  assert.ok(supportsTemperature('gpt-4o'));
  assert.ok(supportsTemperature(''));
});

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
