import OpenAI, { toFile } from 'openai';

/**
 * Голосовой ввод (F18, ADR 0092): выбор движка распознавания.
 *
 * - `mas` (по умолчанию) — локальный MAS (mas.js), запись не покидает машину;
 * - `provider` — OpenAI-совместимый `/audio/transcriptions` провайдера из
 *   настроек (например, whisper-1); запись уходит провайдеру.
 *
 * Модуль не зависит от Electron: MAS и разбор модели передаёт вызывающий.
 */

export const VOICE_ENGINES = ['mas', 'provider'];

/** Настройки голоса с умолчаниями. */
export function voiceConfig(settings = {}) {
  const v = settings.voice || {};
  return {
    engine: VOICE_ENGINES.includes(v.engine) ? v.engine : 'mas',
    // «провайдер/модель», как у моделей чата: openai/whisper-1.
    model: String(v.model || '').trim(),
    language: String(v.language || 'ru').trim() || 'ru',
  };
}

/** Готов ли движок «провайдер»: модель задана и у провайдера есть ключ. */
export function providerVoiceStatus(config, resolve) {
  if (!config.model) return { ok: false, engine: 'provider', error: 'Не задана модель распознавания (например, openai/whisper-1) в «Настройки» → «Голос»' };
  let resolved;
  try {
    resolved = resolve(config.model);
  } catch (err) {
    return { ok: false, engine: 'provider', error: err.message };
  }
  if (!resolved.provider?.apiKey) return { ok: false, engine: 'provider', error: `Не задан API-ключ провайдера «${resolved.provider?.name || resolved.providerId}»` };
  if (!resolved.provider?.baseURL) return { ok: false, engine: 'provider', error: 'У провайдера не задан Base URL' };
  return { ok: true, engine: 'provider', model: config.model, provider: resolved.provider.name || resolved.providerId };
}

/** Распознавание через провайдера: WAV → текст. */
export async function providerTranscribe({ wav, config, resolve, clientFactory = null, timeoutMs = 120_000 }) {
  const status = providerVoiceStatus(config, resolve);
  if (!status.ok) throw new Error(status.error);
  const { provider, modelId } = resolve(config.model);
  const client = (clientFactory || ((o) => new OpenAI(o)))({ apiKey: provider.apiKey, baseURL: provider.baseURL, maxRetries: 1, timeout: timeoutMs });
  const started = Date.now();
  const file = await toFile(Buffer.from(wav), 'voice.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: modelId, language: config.language, response_format: 'json' });
  return { text: String(res?.text || '').trim(), model: config.model, engine: 'provider', elapsedMs: Date.now() - started };
}
