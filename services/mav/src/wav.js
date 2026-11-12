/**
 * WAV без зависимостей: разбор, сборка, склейка.
 *
 * Silero отдаёт PCM16 mono 48 kHz. Этого достаточно, чтобы склеивать длинные
 * тексты из кусков без внешнего ffmpeg: формат у всех кусков одинаковый.
 */

/** Разбирает RIFF/WAVE. Возвращает формат и сырые сэмплы PCM16. */
export function parseWav(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 44) throw new Error('WAV: файл короче заголовка');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV: нет сигнатуры RIFF/WAVE');
  }

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!fmt) throw new Error('WAV: нет чанка fmt');
  if (!data) throw new Error('WAV: нет чанка data');
  if (fmt.audioFormat !== 1) throw new Error(`WAV: поддерживается только PCM, получено ${fmt.audioFormat}`);
  if (fmt.bitsPerSample !== 16) throw new Error(`WAV: поддерживается только 16 бит, получено ${fmt.bitsPerSample}`);

  return { ...fmt, data };
}

/** Собирает WAV из сырых PCM16-сэмплов. */
export function buildWav(data, { sampleRate = 48000, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Тишина заданной длительности в PCM16. */
export function silence(ms, { sampleRate = 48000, channels = 1 } = {}) {
  const frames = Math.round((sampleRate * ms) / 1000);
  return Buffer.alloc(frames * channels * 2);
}

/**
 * Склеивает куски WAV в один файл.
 * Между кусками вставляется пауза: без неё слышны склейки на стыке фраз.
 */
export function concatWav(buffers, { gapMs = 180 } = {}) {
  if (!buffers.length) throw new Error('WAV: нечего склеивать');
  const parts = buffers.map((b) => parseWav(b));
  const first = parts[0];

  for (const part of parts) {
    if (part.sampleRate !== first.sampleRate || part.channels !== first.channels) {
      throw new Error(
        `WAV: форматы не совпадают (${part.sampleRate}/${part.channels} против ${first.sampleRate}/${first.channels})`,
      );
    }
  }

  const gap = gapMs > 0 ? silence(gapMs, first) : Buffer.alloc(0);
  const chunks = [];
  parts.forEach((part, index) => {
    if (index > 0 && gap.length) chunks.push(gap);
    chunks.push(part.data);
  });

  return buildWav(Buffer.concat(chunks), first);
}

/** Длительность WAV в секундах. */
export function wavDuration(buffer) {
  const { data, byteRate } = parseWav(buffer);
  return byteRate > 0 ? data.length / byteRate : 0;
}
