import zlib from 'node:zlib';

/**
 * Минимальный писатель ZIP-архивов.
 *
 * DOCX и XLSX — это ZIP с XML внутри. Отдельная библиотека не нужна: формат
 * простой, а офлайн-дистрибутив не должен расти. См. ADR 0025.
 *
 * Поддержано только то, что нужно офисным форматам: записи без сжатия
 * (method 0) и с deflate (method 8), имена файлов в UTF-8, без шифрования
 * и без ZIP64. Файлы больше 4 ГБ не поддерживаются — для ответа агента
 * это недостижимо.
 */

/** Таблица CRC-32 по полиному 0xEDB88320, строится один раз. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 для буфера.
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Время в формате MS-DOS: два 16-битных поля.
 * @param {Date} date
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/**
 * Собирает ZIP-архив из списка файлов.
 *
 * @param {Array<{ name: string, data: Buffer | string, compress?: boolean }>} entries
 * @returns {Buffer}
 */
function createZip(entries) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    // Сжатие включаем только по просьбе: мелкие XML выгоднее хранить как есть.
    const useDeflate = entry.compress === true && raw.length > 1024;
    const body = useDeflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // сигнатура локального заголовка
    local.writeUInt16LE(20, 4); // версия для распаковки
    local.writeUInt16LE(0x0800, 6); // флаг: имена в UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field отсутствует

    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // сигнатура центрального каталога
    central.writeUInt16LE(20, 4); // версия создателя
    central.writeUInt16LE(20, 6); // версия для распаковки
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // номер диска
    central.writeUInt16LE(0, 36); // внутренние атрибуты
    central.writeUInt32LE(0, 38); // внешние атрибуты
    central.writeUInt32LE(offset, 42); // смещение локального заголовка

    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // сигнатура конца каталога
  end.writeUInt16LE(0, 4); // номер диска
  end.writeUInt16LE(0, 6); // диск с каталогом
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // комментарий отсутствует

  return Buffer.concat([...locals, centralBuffer, end]);
}

export { createZip, crc32 };
