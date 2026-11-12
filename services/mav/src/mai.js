/**
 * Клиент аудио-эндпоинтов шлюза MAI (OpenAI-совместимый LiteLLM).
 *
 * Проверено на api-ai.mai.ru:
 * - POST /v1/audio/speech        → audio/mpeg или audio/wav
 * - POST /v1/audio/transcriptions → JSON с полем text
 *
 * Ограничения, найденные на практике (см. docs/MAV.md):
 * - silero-tts принимает только голоса aidar, baya, kseniya, eugene, xenia;
 * - латиница отбрасывается: «модель русская»;
 * - текст длиннее ~900 символов даёт 500, поэтому текст режется на куски;
 * - qwen3-tts есть в /v1/models, но для ключа недоступна (400).
 */

export const SILERO_VOICES = ['aidar', 'baya', 'kseniya', 'eugene', 'xenia'];

/**
 * Эталонные значения F0 измерены на реальном синтезе шлюза MAI
 * (текст 120 символов, WAV 48 кГц, медиана по voiced-кадрам).
 * Пересъёмка: node services/mav/test/measure-voices.mjs
 *
 * Значения не из документации Silero, а из замера: документации по F0 нет,
 * а подбор голоса без точных эталонов ошибается на соседний голос.
 */
export const VOICE_INFO = {
  eugene: { title: 'Евгений', gender: 'male', f0: 94, note: 'низкий мужской' },
  aidar: { title: 'Айдар', gender: 'male', f0: 122, note: 'средний мужской' },
  xenia: { title: 'Ксения (xenia)', gender: 'female', f0: 203, note: 'женский, ниже' },
  baya: { title: 'Бая', gender: 'female', f0: 235, note: 'женский, нейтральный' },
  kseniya: { title: 'Ксения', gender: 'female', f0: 251, note: 'женский, выше' },
};

export const TTS_MODELS = ['silero-tts', 'silero-tts-accented'];
export const STT_MODELS = ['whisper-large-v3', 'gigaam-ru', 'stt-diarize-gigaam', 'stt-diarize-whisper'];

/** Максимум символов на один запрос синтеза. 900 уже даёт 500, берём с запасом. */
export const MAX_TTS_CHARS = 800;

export class MaiError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'MaiError';
    this.status = status;
    this.body = body;
  }
}

export function createMaiClient({ baseURL, apiKey, timeoutMs = 120_000 } = {}) {
  if (!baseURL) throw new Error('MAI: не задан baseURL');
  const root = String(baseURL).replace(/\/+$/, '');

  async function request(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await fetch(`${root}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // Сеть и таймаут — самая частая причина. Сообщение должно быть понятным.
      const reason = err?.name === 'TimeoutError' ? `таймаут ${timeoutMs} мс` : err?.message || String(err);
      throw new MaiError(`MAI: запрос ${path} не выполнен — ${reason}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new MaiError(`MAI: ${path} вернул HTTP ${response.status}`, { status: response.status, body: body.slice(0, 600) });
    }
    return response;
  }

  return {
    baseURL: root,

    /** Синтез речи. Возвращает Buffer с аудио и его content-type. */
    async speech({ text, voice = 'baya', model = 'silero-tts', format = 'wav', speed = 1 }) {
      if (!String(text || '').trim()) throw new MaiError('MAI: пустой текст для синтеза');
      if (!SILERO_VOICES.includes(voice)) {
        throw new MaiError(`MAI: голос «${voice}» не поддерживается. Доступны: ${SILERO_VOICES.join(', ')}`);
      }

      const response = await request('/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, response_format: format, speed }),
      });

      const audio = Buffer.from(await response.arrayBuffer());
      return { audio, contentType: response.headers.get('content-type') || 'audio/wav', format };
    },

    /** Распознавание речи. Возвращает текст и сегменты, если модель их отдала. */
    async transcribe({ audio, filename = 'audio.wav', model = 'whisper-large-v3', language = 'ru' }) {
      const form = new FormData();
      form.append('file', new Blob([audio]), filename);
      form.append('model', model);
      if (language) form.append('language', language);

      const response = await request('/audio/transcriptions', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      return { text: String(body.text || '').trim(), segments: body.segments || null, model };
    },

    /** Список моделей шлюза: нужен для проверки ключа и доступности аудио. */
    async models() {
      const response = await request('/models', { method: 'GET' });
      const body = await response.json().catch(() => ({ data: [] }));
      return body.data || [];
    },
  };
}
