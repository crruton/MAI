/**
 * Подбор голоса по референсной записи.
 *
 * Это НЕ клонирование. Шлюз MAI не принимает референс: Silero умеет только
 * пять фиксированных голосов. Поэтому мы измеряем референс (высота тона,
 * темп) и выбираем ближайший из пяти. Результат честно называется
 * «подобранный голос», а не «клон».
 *
 * Настоящее клонирование возможно только локальным движком (см. engines/),
 * и оно требует GPU и отдельной модели.
 */

import { analyzeVoice, estimateTempo } from './audio.js';
import { VOICE_INFO, SILERO_VOICES } from './mai.js';

/**
 * Сравнивает измеренный F0 с эталонным F0 голоса.
 * Логарифмическая шкала: разница в 2 раза по частоте — это октава,
 * и она должна весить одинаково на любой высоте.
 */
function pitchDistance(measured, reference) {
  if (!measured || !reference) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log2(measured / reference));
}

/**
 * Подбирает голос по референсу.
 *
 * @param {Buffer} wavBuffer — референсная запись в WAV PCM16.
 * @param {object} options
 * @param {string} [options.gender] — 'male' | 'female' | 'any'. Сужает поиск.
 * @returns {{voice: string, confidence: number, measured: object, candidates: object[]}}
 */
export function matchVoice(wavBuffer, { gender = 'any' } = {}) {
  const measured = analyzeVoice(wavBuffer);
  const tempo = estimateTempo(wavBuffer);

  if (!measured.f0Median) {
    throw new Error(
      'Не удалось измерить высоту тона: в записи нет внятной речи. Нужна запись без музыки и шума, 3–30 секунд.',
    );
  }

  const pool = SILERO_VOICES.filter((id) => gender === 'any' || VOICE_INFO[id].gender === gender);
  if (!pool.length) throw new Error(`Нет голосов для gender=${gender}`);

  const candidates = pool
    .map((id) => {
      const info = VOICE_INFO[id];
      const distance = pitchDistance(measured.f0Median, info.f0);
      return {
        voice: id,
        title: info.title,
        gender: info.gender,
        note: info.note,
        referenceF0: info.f0,
        distance: Number(distance.toFixed(4)),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const best = candidates[0];

  // Уверенность: 1.0 при точном совпадении, 0 при разнице в октаву и больше.
  const confidence = Math.max(0, Math.min(1, 1 - best.distance));

  return {
    voice: best.voice,
    confidence: Number(confidence.toFixed(3)),
    measured: {
      f0Median: Math.round(measured.f0Median),
      f0Low: Math.round(measured.f0Low),
      f0High: Math.round(measured.f0High),
      voicedRatio: Number(measured.voicedRatio.toFixed(3)),
      duration: Number(measured.duration.toFixed(2)),
      syllablesPerSecond: Number(tempo.syllablesPerSecond.toFixed(2)),
      rms: Number(measured.rms.toFixed(4)),
    },
    candidates,
    note: 'Это подбор ближайшего голоса, а не клонирование: шлюз MAI не принимает референс.',
  };
}

/**
 * Рекомендация скорости синтеза по темпу референса.
 * Средний русский темп — около 4.5 слога в секунду.
 */
export function suggestSpeed(syllablesPerSecond) {
  if (!syllablesPerSecond) return 1;
  const ratio = syllablesPerSecond / 4.5;
  return Number(Math.max(0.7, Math.min(1.3, ratio)).toFixed(2));
}
