/**
 * Возможности модели (бэклог CC13.1, CC7.11, ADR 0058).
 *
 * Флаги берутся из записи модели у провайдера (`models: [{ id, tools, vision,
 * reasoning, effort, temperature, transport, context }]`), иначе — по имени.
 * Из них: что показывать в окне (переключатель глубины рассуждений), что
 * слать в запросе (temperature, reasoning_effort) и как.
 *
 * Модуль не зависит от Electron.
 */
import { supportsVision } from './vision.js';
import { supportsTemperature } from './responses.js';

export const EFFORTS = ['low', 'medium', 'high'];

// Модели с настраиваемой глубиной рассуждений (reasoning_effort).
const EFFORT_RE = /^(o[1-9](-mini|-pro)?|gpt-[5-9](\.\d+)?(-mini|-nano|-pro|-codex)?|gpt-oss)/i;
// Рассуждающие модели, у которых глубину не задать, но размышления видны.
const REASONING_RE = /deepseek-(r1|reasoner)|qwq|-thinking|reasoning|magistral|kimi-k2-thinking/i;

export function modelCapabilities(modelId, provider = null) {
  const id = String(modelId || '').trim();
  const bare = id.includes('/') ? id.split('/').pop() : id;
  const entry = (provider?.models || []).find((m) => m?.id === id) || {};
  const effort = Array.isArray(entry.effort) ? entry.effort.filter((e) => EFFORTS.includes(e)) : entry.effort === false ? [] : EFFORT_RE.test(bare) ? EFFORTS : [];
  return {
    id,
    // Без инструментов агент не может действовать — выключаем только явным флагом модели.
    tools: entry.tools !== false,
    vision: supportsVision(id, provider),
    reasoning: typeof entry.reasoning === 'boolean' ? entry.reasoning : effort.length > 0 || REASONING_RE.test(bare),
    effort,
    temperature: typeof entry.temperature === 'boolean' ? entry.temperature : supportsTemperature(bare) && !/^o[1-9]/i.test(bare),
    transport: ['chat', 'responses'].includes(entry.transport) ? entry.transport : 'auto',
    context: Number(entry.context) > 0 ? Number(entry.context) : null,
  };
}

/** Поля запроса chat.completions по возможностям: temperature и reasoning_effort. */
export function requestOptions(caps, { temperature = 0.3, effort = '' } = {}) {
  const out = {};
  if (caps.temperature) out.temperature = temperature;
  if (effort && caps.effort.includes(effort)) out.reasoning_effort = effort;
  return out;
}
