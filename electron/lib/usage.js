/**
 * Учёт токенов (бэклог A3.8): единый вид для chat.completions и Responses API.
 * Основа для индикатора контекста и стоимости (CC5).
 */

/** usage провайдера → { input, output, total, cached } или null. */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = Number(raw.prompt_tokens ?? raw.input_tokens ?? 0) || 0;
  const output = Number(raw.completion_tokens ?? raw.output_tokens ?? 0) || 0;
  // Кэш (CC5.4): OpenAI/Responses, DeepSeek, Anthropic через совместимые шлюзы.
  const cached =
    Number(raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? 0) || 0;
  const total = Number(raw.total_tokens ?? input + output) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, total, cached };
}

export function addUsage(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
    cached: (a.cached || 0) + (b.cached || 0),
  };
}

/** Сумма по сообщениям ассистента в истории. */
export function sessionUsage(messages) {
  return (messages || []).reduce((sum, m) => (m?.role === 'assistant' && m.usage ? addUsage(sum, m.usage) : sum), null);
}

/** Шлюз не принимает stream_options: 400 с упоминанием параметра. */
export function isStreamOptionsRejected(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 400 && /stream_options|include_usage/i.test(`${err?.message || ''} ${JSON.stringify(err?.error || '')}`);
}
