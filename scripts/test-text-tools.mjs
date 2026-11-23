/**
 * Текстовый протокол инструментов (CC13.4, ADR 0078).
 */
import { isToolsUnsupported, textToolsPrompt, parseTextToolCalls, toTextProtocol } from '../electron/lib/text-tools.js';

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

console.log('[1] отказ шлюза');
for (const msg of ['400 this model does not support tools', 'tool use is not supported for this model', 'Tools are not supported', 'function calling is not enabled for model x', '"tool_choice" is not supported']) {
  check(`распознан: ${msg}`, isToolsUnsupported(new Error(msg)));
}
check('прочие ошибки — нет', !isToolsUnsupported(new Error('429 rate limit')) && !isToolsUnsupported(new Error('image is not supported')));

console.log('[2] разбор вызовов');
let p = parseTextToolCalls('Смотрю.\n<tool_call>{"name":"read_file","arguments":{"path":"a.md"}}</tool_call>\n<tool_call>\n```json\n{"name":"grep","arguments":{"pattern":"x"}}\n```\n</tool_call>');
check('два вызова, в т.ч. в ```json', p.calls.length === 2 && p.calls[0].name === 'read_file' && JSON.parse(p.calls[0].arguments).path === 'a.md' && p.calls[1].name === 'grep' && p.text === 'Смотрю.', JSON.stringify(p));
check('id уникальны', p.calls[0].id !== p.calls[1].id);
p = parseTextToolCalls('<tool_call>{"tool":"list_files","args":{}}</tool_call><tool_call>не json</tool_call><tool_call>{"arguments":{}}</tool_call>');
check('синонимы tool/args; плохой JSON и без name — в errors', p.calls.length === 1 && p.calls[0].name === 'list_files' && p.errors.length === 2, JSON.stringify(p));
check('текст без блоков — без вызовов', parseTextToolCalls('просто ответ').calls.length === 0);

console.log('[3] история для модели без инструментов');
const api = [
  { role: 'user', content: 'прочитай два файла' },
  { role: 'assistant', content: 'Читаю.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }, { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'A' },
  { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: 'B' },
  { role: 'assistant', content: 'Готово' },
];
const out = toTextProtocol(api);
check('нет ролей tool, результаты одним сообщением пользователя', out.length === 4 && !out.some((m) => m.role === 'tool') && out[2].role === 'user' && (out[2].content.match(/<tool_result/g) || []).length === 2 && !('toolResults' in out[2]), JSON.stringify(out).slice(0, 400));
check('вызовы ассистента — блоками после текста', /^Читаю\.\n<tool_call>\{"name":"read_file","arguments":\{"path":"a"\}\}<\/tool_call>/.test(out[1].content) && !out[1].tool_calls);
const prompt = textToolsPrompt([{ type: 'function', function: { name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
check('промпт: протокол, пример и схема инструмента', /<tool_call>\{"name": "read_file"/.test(prompt) && /### read_file/.test(prompt) && /"path"/.test(prompt));

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
