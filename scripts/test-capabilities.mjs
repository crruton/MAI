/**
 * Возможности модели и глубина рассуждений (CC13.1, CC7.11, ADR 0058).
 */
import { modelCapabilities, requestOptions, EFFORTS, withCacheControl } from '../electron/lib/capabilities.js';
import { normalizeUsage } from '../electron/lib/usage.js';
import { uniqueSkills, skillConflicts } from '../electron/lib/skill-conflicts.js';

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
const caps = (id, provider) => modelCapabilities(id, provider);
check('gpt-5: глубина, без temperature, зрение', caps('gpt-5').effort.join() === EFFORTS.join() && caps('gpt-5').temperature === false && caps('gpt-5').vision);
check('o3-mini: глубина, без temperature', caps('o3-mini').effort.length === 3 && !caps('o3-mini').temperature);
check('gpt-4o: без глубины, с temperature', caps('gpt-4o').effort.length === 0 && caps('gpt-4o').temperature && !caps('gpt-4o').reasoning);
check('deepseek-reasoner: рассуждает, глубину не задать', caps('deepseek-reasoner').reasoning && caps('deepseek-reasoner').effort.length === 0);
check('по умолчанию инструменты есть', caps('some-unknown-model').tools === true);
check('провайдер/модель — по имени модели', caps('agentrouter/gpt-5.1-codex').effort.length === 3);
const provider = { models: [{ id: 'local-llm', tools: false, vision: false, reasoning: true, effort: ['low', 'high', 'extreme'], temperature: false, transport: 'responses', context: 32000 }] };
const local = caps('local-llm', provider);
check('флаги модели у провайдера сильнее имени', local.tools === false && local.vision === false && local.effort.join() === 'low,high' && local.transport === 'responses' && local.context === 32000 && local.temperature === false);
check('effort: false выключает глубину', caps('gpt-5', { models: [{ id: 'gpt-5', effort: false }] }).effort.length === 0);
check('запрос: temperature только если можно', JSON.stringify(requestOptions(caps('gpt-4o'), { temperature: 0.2 })) === '{"temperature":0.2}' && JSON.stringify(requestOptions(caps('gpt-5'), { temperature: 0.2 })) === '{}');
check('запрос: reasoning_effort только поддерживаемый', requestOptions(caps('gpt-5'), { effort: 'high' }).reasoning_effort === 'high' && requestOptions(caps('gpt-4o'), { effort: 'high' }).reasoning_effort === undefined && requestOptions(local, { effort: 'medium' }).reasoning_effort === undefined);
console.log('[кэш промпта, CC5.4]');
check('Claude — метки кэша, gpt — нет, флаг модели сильнее', caps('anthropic/claude-sonnet-4.5').cache === true && caps('gpt-5').cache === false && caps('my-claude', { models: [{ id: 'my-claude', cache: false }] }).cache === false);
const marked = withCacheControl([
  { role: 'system', content: 'система' },
  { role: 'user', content: 'вопрос' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c', content: 'результат' },
]);
check('метка на системном промпте и последнем сообщении', marked[0].content[0].cache_control?.type === 'ephemeral' && marked[3].content[0].cache_control?.type === 'ephemeral' && marked[1].content === 'вопрос' && marked[2].content === null, JSON.stringify(marked));
check('картинка: метка на последней части', withCacheControl([{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }] }])[1].content[1].cache_control?.type === 'ephemeral');
check('кэш в usage: Anthropic через шлюз', normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 80 }).cached === 80);

console.log('[дубли навыков, CC10.5]');
const list = [
  { name: 'review', scope: 'project' },
  { name: 'Review', scope: 'package:kit' },
  { name: 'deploy', scope: 'global' },
  { name: 'review', scope: 'global' },
];
const uniq = uniqueSkills(list);
check('один навык на имя: проектный, остальные — в shadowed', uniq.length === 2 && uniq[0].scope === 'project' && uniq[0].shadowed.join() === 'package:kit,global');
const warn = skillConflicts(list, ['review', 'new'], 'package:kit');
check('конфликт при установке: кто будет работать', warn.length === 1 && /«review» уже есть \(project\) — работать будет навык из «project»/.test(warn[0]), JSON.stringify(warn));
check('пакет поверх глобального — работает пакет', /работать будет навык из «package:kit»/.test(skillConflicts([{ name: 'deploy', scope: 'global' }], ['deploy'], 'package:kit')[0] || ''));
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
