/**
 * Ядро сервиса MAV: синтез, озвучка длинных текстов, дубляж.
 *
 * Все операции возвращают результат и не пишут файлы сами — запись делает
 * хранилище (storage.js). Так ядро можно тестировать без диска.
 */

import { chunkText, stripMarkdown } from './text.js';
import { concatWav, wavDuration } from './wav.js';
import { matchVoice, suggestSpeed } from './voice.js';

/**
 * Синтез одного куска текста с повтором при временной ошибке.
 * 5xx у шлюза бывает при перегрузке; повтор через паузу обычно помогает.
 */
async function synthesizeWithRetry(engine, params, { retries = 2, delayMs = 700 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await engine.synthesize(params);
    } catch (err) {
      lastError = err;
      const status = err?.status || 0;
      // Повторяем только на 5xx и сетевых ошибках: 4xx не изменится.
      const retryable = status === 0 || status >= 500;
      if (!retryable || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Синтез текста любой длины.
 *
 * Длинный текст режется на куски, каждый синтезируется отдельно, затем
 * куски склеиваются в один WAV. Для mp3 склейка не делается: без ffmpeg
 * нельзя корректно соединить сжатые кадры, поэтому при нескольких кусках
 * формат принудительно переводится в wav.
 */
export async function synthesize(engine, {
  text,
  voice = 'baya',
  speed = 1,
  format = 'wav',
  strip = true,
  gapMs = 180,
  onProgress = null,
} = {}) {
  const prepared = strip ? stripMarkdown(text) : String(text || '');
  const chunks = chunkText(prepared);
  if (!chunks.length) throw new Error('Нечего озвучивать: после очистки текста не осталось');

  const effectiveFormat = chunks.length > 1 ? 'wav' : format;
  const parts = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const result = await synthesizeWithRetry(engine, {
      text: chunks[index],
      voice,
      speed,
      format: effectiveFormat,
    });
    parts.push(result.audio);
    if (onProgress) onProgress({ done: index + 1, total: chunks.length });
  }

  const audio = parts.length === 1 ? parts[0] : concatWav(parts, { gapMs });

  return {
    audio,
    contentType: effectiveFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
    format: effectiveFormat,
    chunks: chunks.length,
    characters: prepared.length,
    duration: effectiveFormat === 'wav' ? Number(wavDuration(audio).toFixed(2)) : null,
    voice,
    speed,
  };
}

/**
 * Озвучка книги: текст делится на главы по заголовкам Markdown.
 * Возвращает список глав с готовым аудио — вызывающий код решает, как хранить.
 */
export async function narrateBook(engine, {
  text,
  voice = 'baya',
  speed = 1,
  gapMs = 400,
  onProgress = null,
} = {}) {
  const chapters = splitChapters(text);
  if (!chapters.length) throw new Error('Нечего озвучивать: в тексте нет содержимого');

  const results = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const result = await synthesize(engine, {
      text: chapter.body,
      voice,
      speed,
      format: 'wav',
      gapMs,
    });
    results.push({ title: chapter.title, ...result });
    if (onProgress) onProgress({ done: index + 1, total: chapters.length, title: chapter.title });
  }

  return {
    chapters: results,
    totalDuration: Number(results.reduce((sum, item) => sum + (item.duration || 0), 0).toFixed(2)),
    voice,
    speed,
  };
}

/** Делит Markdown на главы по заголовкам первого и второго уровня. */
export function splitChapters(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const chapters = [];
  let title = 'Вступление';
  let body = [];

  const flush = () => {
    const content = body.join('\n').trim();
    if (content) chapters.push({ title, body: content });
    body = [];
  };

  for (const line of lines) {
    const heading = /^\s{0,3}(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[2].trim();
      continue;
    }
    body.push(line);
  }
  flush();

  return chapters;
}

/**
 * Дубляж: распознать речь с таймкодами, перевести, озвучить.
 *
 * Перевод делается чат-моделью шлюза. Таймкоды сохраняются как метаданные:
 * точная подгонка длительности требует растяжения времени (ffmpeg), поэтому
 * в первой версии сегменты просто озвучиваются по порядку.
 */
export async function dub(engine, {
  audio,
  filename = 'input.wav',
  sttModel = 'whisper-large-v3',
  translate = null,
  voice = 'baya',
  speed = 1,
  onProgress = null,
} = {}) {
  if (!engine.transcribe) throw new Error('Дубляж: движок не поддерживает распознавание речи');

  const transcription = await engine.transcribe({ audio, filename, model: sttModel });
  if (!transcription.text) throw new Error('Дубляж: речь не распознана');

  const segments = (transcription.segments || []).map((segment) => ({
    start: segment.start ?? null,
    end: segment.end ?? null,
    text: String(segment.text || '').trim(),
  })).filter((segment) => segment.text);

  const source = segments.length ? segments : [{ start: null, end: null, text: transcription.text }];

  const translated = [];
  for (let index = 0; index < source.length; index += 1) {
    const segment = source[index];
    const text = translate ? await translate(segment.text) : segment.text;
    translated.push({ ...segment, translated: text });
    if (onProgress) onProgress({ stage: 'translate', done: index + 1, total: source.length });
  }

  const fullText = translated.map((segment) => segment.translated).join(' ');
  const speech = await synthesize(engine, { text: fullText, voice, speed, format: 'wav' });

  return {
    sourceText: transcription.text,
    translatedText: fullText,
    segments: translated,
    audio: speech.audio,
    contentType: speech.contentType,
    duration: speech.duration,
    voice,
  };
}

/** Подбор голоса по референсу — обёртка для API. */
export function pickVoice(referenceWav, { gender = 'any' } = {}) {
  const match = matchVoice(referenceWav, { gender });
  return { ...match, suggestedSpeed: suggestSpeed(match.measured.syllablesPerSecond) };
}
