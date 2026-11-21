import zlib from 'node:zlib';

/**
 * Минимальный читатель ZIP (CW2.1, ADR 0049) для DOCX и XLSX: центральный
 * каталог, записи без сжатия и deflate. Без ZIP64 и шифрования.
 * Ограничения против «zip-бомб»: до 2000 записей и 200 МБ распакованного.
 */
const MAX_ENTRIES = 2000;
const MAX_TOTAL = 200 * 1024 * 1024;

export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Это не ZIP (нет конца центрального каталога)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new Error(`Слишком много записей в архиве: ${count}`);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('Повреждён центральный каталог');
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    total += size;
    if (total > MAX_TOTAL) throw new Error('Архив распаковывается больше чем в 200 МБ');
    const localName = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) + 1024 }));
    // прочие методы пропускаем — офисные форматы их не используют
  }
  return files;
}
