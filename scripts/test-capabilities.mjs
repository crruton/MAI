/**
 * Возможности модели и глубина рассуждений (CC13.1, CC7.11, ADR 0058).
 */
import { modelCapabilities, requestOptions, EFFORTS } from '../electron/lib/capabilities.js';

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
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
