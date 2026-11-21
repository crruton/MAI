/**
 * Изображения во вложениях → мультимодальные части запроса (бэклог F1).
 *
 * В сессии хранится только путь к файлу (`message.images`), base64 собирается
 * на каждый запрос: иначе sessions.json раздувался бы мегабайтами.
 * Модуль не зависит от Electron.
 */
import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export const IMAGE_LIMITS = {
  perImageBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  maxImages: 10,
};

const VISION_RE = /gpt-4o|gpt-4\.1|gpt-5|gpt-6|o3|o4|claude|gemini|vision|[-_.]vl\b|vl-|qwen.*vl|llava|pixtral|glm-4v|internvl|minicpm-v/i;

/**
 * Умеет ли модель принимать изображения. Явный флаг `vision` в описании модели
 * провайдера сильнее эвристики по имени.
 */
export function supportsVision(modelId, provider = null) {
  const entry = (provider?.models || []).find((m) => m?.id === modelId);
  if (typeof entry?.vision === 'boolean') return entry.vision;
  return VISION_RE.test(String(modelId || ''));
}

export function isImageFile(file) {
  return Boolean(MIME[path.extname(String(file || '')).toLowerCase()]);
}

/** Часть сообщения с картинкой или null (нет файла, не тот тип, слишком большой, вне проекта). */
export function imagePart(projectDir, relPath, { maxBytes = IMAGE_LIMITS.perImageBytes } = {}) {
  if (!projectDir || !relPath) return null;
  const full = path.resolve(projectDir, relPath);
  const rel = path.relative(projectDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const mime = MIME[path.extname(full).toLowerCase()];
  if (!mime) return null;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;
  const data = fs.readFileSync(full).toString('base64');
  return { part: { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }, bytes: stat.size };
}

/** Картинка по полному пути (вызывающий уже проверил, что путь в рабочих папках). */
export function imageFilePart(full, { maxBytes = IMAGE_LIMITS.perImageBytes } = {}) {
  const mime = MIME[path.extname(String(full)).toLowerCase()];
  if (!mime) return null;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return { part: { type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(full).toString('base64')}` } }, bytes: stat.size };
  } catch {
    return null;
  }
}

/**
 * Картинки, которые агент открыл read_file (CC1.3): после блока результатов
 * шага вставляется сообщение пользователя с изображениями. В историю чата оно
 * не попадает — только в запрос. Индексы: `sourceMessages[i]` ↔ `apiMessages[i]`.
 */
export function attachToolImages(apiMessages, sourceMessages, limits = IMAGE_LIMITS) {
  const out = [];
  let count = 0;
  let total = 0;
  for (let i = 0; i < apiMessages.length; i += 1) {
    out.push(apiMessages[i]);
    const src = sourceMessages[i];
    if (src?.role !== 'tool' || !Array.isArray(src.images) || !src.images.length) continue;
    // Вставляем после последнего результата этого шага.
    let j = i;
    while (sourceMessages[j + 1]?.role === 'tool') {
      j += 1;
      out.push(apiMessages[j]);
    }
    const parts = [];
    const names = [];
    for (let k = i; k <= j; k += 1) {
      for (const file of sourceMessages[k]?.images || []) {
        if (count >= limits.maxImages) continue;
        const image = imageFilePart(file, { maxBytes: limits.perImageBytes });
        if (!image || total + image.bytes > limits.totalBytes) continue;
        count += 1;
        total += image.bytes;
        parts.push(image.part);
        names.push(path.basename(file));
      }
    }
    if (parts.length) out.push({ role: 'user', content: [{ type: 'text', text: `[Изображения, открытые read_file: ${names.join(', ')}]` }, ...parts] });
    i = j;
  }
  return { messages: out, count };
}

/**
 * Добавляет картинки к сообщениям пользователя, начиная с последних, пока не
 * исчерпан бюджет. Возвращает новые сообщения и сколько картинок пропущено.
 */
export function attachImages(apiMessages, sourceMessages, projectDir, limits = IMAGE_LIMITS) {
  const out = [...apiMessages];
  let total = 0;
  let count = 0;
  let skipped = 0;
  for (let i = sourceMessages.length - 1; i >= 0; i -= 1) {
    const source = sourceMessages[i];
    if (source?.role !== 'user' || !Array.isArray(source.images) || !source.images.length) continue;
    const parts = [];
    for (const rel of source.images) {
      if (count >= limits.maxImages) {
        skipped += 1;
        continue;
      }
      const image = imagePart(projectDir, rel, { maxBytes: limits.perImageBytes });
      if (!image || total + image.bytes > limits.totalBytes) {
        skipped += 1;
        continue;
      }
      total += image.bytes;
      count += 1;
      parts.push(image.part);
    }
    if (!parts.length) continue;
    const text = typeof out[i].content === 'string' ? out[i].content : '';
    out[i] = { ...out[i], content: [{ type: 'text', text }, ...parts] };
  }
  return { messages: out, count, skipped, bytes: total };
}

/** Шлюз отверг изображение: 400 с упоминанием картинок или мультимодальности. */
export function isImageRejected(err) {
  const status = err?.status ?? err?.response?.status;
  const text = `${err?.message || ''} ${JSON.stringify(err?.error || '')}`;
  return status === 400 && /image|vision|multimodal|image_url|unsupported content|content type/i.test(text);
}
