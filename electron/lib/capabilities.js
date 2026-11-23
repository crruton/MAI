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
    // Кэш промпта (CC5.4): метки cache_control — Claude (Anthropic, OpenRouter);
    // OpenAI, DeepSeek и Qwen кэшируют общий префикс сами. Флаг модели сильнее.
    cache: typeof entry.cache === 'boolean' ? entry.cache : /claude|anthropic/i.test(bare),
  };
}

/** Поля запроса chat.completions по возможностям: temperature и reasoning_effort. */
export function requestOptions(caps, { temperature = 0.3, effort = '' } = {}) {
  const out = {};
  if (caps.temperature) out.temperature = temperature;
  if (effort && caps.effort.includes(effort)) out.reasoning_effort = effort;
  return out;
}

/**
 * Метки кэша (CC5.4, ADR 0080): системный промпт и последнее сообщение — точки
 * cache_control; всё до них провайдер кэширует. Строковый текст становится
 * массивом частей; сообщения с картинками получают метку на последней части.
 */
export function withCacheControl(messages) {
  const mark = (message) => {
    if (!message) return message;
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content.map((p) => ({ ...p })) : null;
    if (!parts || !parts.length) return message;
    parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
    return { ...message, content: parts };
  };
  if (!messages.length) return messages;
  const out = [...messages];
  if (out[0].role === 'system') out[0] = mark(out[0]);
  // Последнее сообщение с текстом: следующий шаг переиспользует весь диалог до него.
  for (let i = out.length - 1; i > 0; i -= 1) {
    if (out[i].role !== 'assistant' && (typeof out[i].content === 'string' ? out[i].content : Array.isArray(out[i].content))) {
      out[i] = mark(out[i]);
      break;
    }
  }
  return out;
}
