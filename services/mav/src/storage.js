/**
 * Хранилище результатов: аудио, референсы, история заданий.
 *
 * Файлы лежат в dataDir. Имена — content-addressed по SHA-256: одинаковый
 * запрос не создаёт второй файл. Метаданные — в index.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createStorage(dataDir) {
  const root = path.resolve(dataDir);
  const audioDir = path.join(root, 'audio');
  const refDir = path.join(root, 'references');
  const indexFile = path.join(root, 'index.json');

  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(refDir, { recursive: true });

  function readIndex() {
    try {
      return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
      return { items: [] };
    }
  }

  function writeIndex(index) {
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmp, indexFile);
  }

  function hash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  return {
    root,

    /** Сохраняет аудио и запись о нём. Возвращает метаданные с id. */
    saveAudio(buffer, meta = {}) {
      const digest = hash(buffer);
      const ext = meta.format === 'mp3' ? 'mp3' : 'wav';
      const file = path.join(audioDir, `${digest.slice(0, 16)}.${ext}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);

      const index = readIndex();
      const existing = index.items.find((item) => item.id === digest.slice(0, 16));
      if (existing) return existing;

      const item = {
        id: digest.slice(0, 16),
        sha256: digest,
        file,
        bytes: buffer.length,
        format: ext,
        createdAt: new Date().toISOString(),
        ...meta,
      };
      index.items.unshift(item);
      index.items = index.items.slice(0, 500);
      writeIndex(index);
      return item;
    },

    /** Сохраняет референсную запись для подбора голоса. */
    saveReference(buffer, meta = {}) {
      const digest = hash(buffer);
      const file = path.join(refDir, `${digest.slice(0, 16)}.wav`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
      return { id: digest.slice(0, 16), file, bytes: buffer.length, ...meta };
    },

    list(limit = 50) {
      return readIndex().items.slice(0, limit);
    },

    get(id) {
      return readIndex().items.find((item) => item.id === id) || null;
    },

    read(id) {
      const item = this.get(id);
      if (!item) throw new Error(`Запись ${id} не найдена`);
      return fs.readFileSync(item.file);
    },

    remove(id) {
      const index = readIndex();
      const item = index.items.find((entry) => entry.id === id);
      if (!item) return false;
      try {
        fs.unlinkSync(item.file);
      } catch {
        /* файла уже нет — не страшно */
      }
      index.items = index.items.filter((entry) => entry.id !== id);
      writeIndex(index);
      return true;
    },
  };
}
