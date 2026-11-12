/**
 * Анализ речи без зависимостей: высота тона (F0), темп, громкость.
 *
 * Зачем это нужно. Клонировать голос моделями шлюза MAI нельзя: Silero
 * принимает только пять фиксированных голосов. Но можно измерить референсную
 * запись и выбрать из пяти голосов ближайший по высоте тона. Это честный
 * «подбор голоса», а не клон, и он работает на CPU без GPU.
 */

import { parseWav } from './wav.js';

/** PCM16 → Float32 в диапазоне [-1, 1]. */
export function toFloat32(data) {
  const out = new Float32Array(data.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

/** Среднеквадратичная громкость: нужна, чтобы отбросить тишину. */
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Основной тон одного кадра через нормированную автокорреляцию.
 * Возвращает 0, если кадр не voiced (тишина, шум, согласный).
 */
function frameF0(samples, start, length, sampleRate, minHz, maxHz) {
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.floor(sampleRate / minHz), length - 1);
  if (maxLag <= minLag) return 0;

  let energy = 0;
  for (let i = 0; i < length; i += 1) energy += samples[start + i] * samples[start + i];
  if (energy / length < 1e-5) return 0;

  const scores = new Float64Array(maxLag - minLag + 1);
  let bestScore = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length - lag; i += 1) {
      const a = samples[start + i];
      const b = samples[start + i + lag];
      sum += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const score = denom > 0 ? sum / denom : 0;
    scores[lag - minLag] = score;
    if (score > bestScore) bestScore = score;
  }

  // Порог 0.3 отсекает шум: у voiced-кадров корреляция заметно выше.
  if (bestScore < 0.3) return 0;

  // Ошибка на октаву: у периодического сигнала корреляция почти равна 1 и на
  // удвоенном периоде (субгармонике). Поэтому берём НАИМЕНЬШИЙ лаг, у которого
  // корреляция близка к максимуму, — это и есть основной период, а не его
  // двукратное или трёхкратное значение.
  const threshold = Math.max(0.3, bestScore * 0.85);
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = scores[lag - minLag];
    if (score < threshold) continue;
    const prev = lag > minLag ? scores[lag - minLag - 1] : -1;
    const next = lag < maxLag ? scores[lag - minLag + 1] : -1;
    // Локальный максимум: без этого шаг внутри плато даёт случайный лаг.
    if (score >= prev && score >= next) {
      bestLag = lag;
      break;
    }
  }
  if (!bestLag) return 0;

  return sampleRate / bestLag;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

/**
 * Измеряет голос по WAV.
 *
 * Возвращает медиану F0 (устойчива к выбросам), диапазон 10–90 перцентилей,
 * долю voiced-кадров и длительность. Медиана F0 — главный признак пола и
 * «низкости» голоса, по ней и подбирается ближайший голос Silero.
 */
export function analyzeVoice(buffer, { minHz = 60, maxHz = 400 } = {}) {
  const wav = parseWav(buffer);
  const samples = toFloat32(wav.data);
  const sampleRate = wav.sampleRate;

  const frameMs = 40;
  const hopMs = 20;
  const frameLength = Math.round((sampleRate * frameMs) / 1000);
  const hop = Math.round((sampleRate * hopMs) / 1000);

  const f0 = [];
  let frames = 0;

  for (let start = 0; start + frameLength <= samples.length; start += hop) {
    frames += 1;
    const value = frameF0(samples, start, frameLength, sampleRate, minHz, maxHz);
    if (value > 0) f0.push(value);
  }

  const duration = samples.length / sampleRate;
  const voicedRatio = frames ? f0.length / frames : 0;

  return {
    duration,
    sampleRate,
    channels: wav.channels,
    rms: rms(samples),
    voicedRatio,
    f0Median: median(f0),
    f0Low: percentile(f0, 10),
    f0High: percentile(f0, 90),
    frames,
    voicedFrames: f0.length,
  };
}

/**
 * Оценка темпа речи: слогов в секунду по огибающей энергии.
 *
 * Точность приблизительная — это эвристика для сравнения записей между собой,
 * а не фонетический анализ. Для подбора голоса достаточно.
 */
export function estimateTempo(buffer) {
  const wav = parseWav(buffer);
  const samples = toFloat32(wav.data);
  const sampleRate = wav.sampleRate;
  const window = Math.round(sampleRate * 0.02);

  const envelope = [];
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let i = 0; i < window; i += 1) sum += samples[start + i] * samples[start + i];
    envelope.push(Math.sqrt(sum / window));
  }
  if (envelope.length < 4) return { syllablesPerSecond: 0, duration: samples.length / sampleRate };

  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  let peaks = 0;
  for (let i = 1; i < envelope.length - 1; i += 1) {
    if (envelope[i] > mean && envelope[i] >= envelope[i - 1] && envelope[i] > envelope[i + 1]) peaks += 1;
  }

  const duration = samples.length / sampleRate;
  return { syllablesPerSecond: duration > 0 ? peaks / duration : 0, duration };
}
