import { loadSettings } from './config.js';

let cache = { at: 0, baseURL: '', data: [] };
const TTL = 5 * 60 * 1000;

// У MAI в /v1/models нет поля name — даём читаемые названия вручную.
const PRETTY_NAMES = {
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'DeepSeek-V4-Flash': 'DeepSeek V4 Flash',
  'Qwen3.5-122B-A10B': 'Qwen 3.5 122B A10B',
  'qwen3.8-27b': 'Qwen 3.8 27B',
  'qwen3.8-flash-next': 'Qwen 3.8 Flash Next',
  'qwen3.6-35b-a3b': 'Qwen 3.6 35B A3B',
};

function prettyName(id) {
  if (PRETTY_NAMES[id]) return PRETTY_NAMES[id];
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

export function isChatModel(model) {
  if (model.mode) return model.mode === 'chat';
  // Шлюз не всегда отдаёт mode: чат-модели определяем по имени.
  return /deepseek|qwen|gpt|claude|llama|mistral|gemma|glm/i.test(model.id || '');
}

export async function listModels({ force = false } = {}) {
  const { baseURL, apiKey } = loadSettings();
  if (!force && cache.data.length && cache.baseURL === baseURL && Date.now() - cache.at < TTL) {
    return cache.data;
  }
  const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`Список моделей: HTTP ${res.status}`);
  const body = await res.json();
  const models = (body.data || [])
    .filter(isChatModel)
    .map((m) => ({
      id: m.id,
      name: m.name || prettyName(m.id),
      context: m.max_input_tokens || m.context_length || null,
      output: m.max_output_tokens || null,
    }))
    .sort((a, b) => (b.context || 0) - (a.context || 0) || a.id.localeCompare(b.id));
  cache = { at: Date.now(), baseURL, data: models };
  return models;
}
