/**
 * Нарезка текста на куски для синтеза.
 *
 * Причина: silero-tts возвращает 500 на тексте длиннее ~900 символов.
 * Режем по границам предложений, затем по запятым, затем по словам —
 * чтобы не разрывать слово и не терять знак конца фразы.
 */

import { MAX_TTS_CHARS } from './mai.js';

const ABBREVIATIONS = ['т.е.', 'т.д.', 'т.п.', 'др.', 'г.', 'гг.', 'ул.', 'стр.', 'рис.', 'табл.', 'напр.', 'им.'];

/** Заменяет сокращения на маркеры, чтобы точка внутри них не считалась концом предложения. */
function protectAbbreviations(text) {
  let out = text;
  for (const abbr of ABBREVIATIONS) {
    out = out.split(abbr).join(abbr.replace(/\./g, '\u0001'));
  }
  return out;
}

function restoreAbbreviations(text) {
  return text.split('\u0001').join('.');
}

/** Делит текст на предложения, сохраняя знаки конца. */
export function splitSentences(text) {
  const protectedText = protectAbbreviations(String(text || ''));
  const parts = protectedText.match(/[^.!?…]+[.!?…]+[\s]*|[^.!?…]+$/g) || [];
  return parts.map((part) => restoreAbbreviations(part).trim()).filter(Boolean);
}

/** Делит слишком длинное предложение по запятым, точкам с запятой и двоеточиям. */
function splitClauses(sentence) {
  const parts = sentence.match(/[^,;:—–]+[,;:—–]*[\s]*|[^,;:—–]+$/g) || [sentence];
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Последний резерв: режем по словам, не разрывая слово.
 * Слово длиннее лимита (ссылка, длинный идентификатор) режется принудительно:
 * иначе кусок превысит лимит и шлюз вернёт 500.
 */
function splitWords(text, limit) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';

  const push = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const word of words) {
    if (word.length > limit) {
      push();
      for (let i = 0; i < word.length; i += limit) chunks.push(word.slice(i, i + limit));
      continue;
    }
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ` ${word}`;
    } else {
      push();
      current = word;
    }
  }
  push();
  return chunks;
}

/**
 * Режет текст на куски не длиннее limit.
 * Возвращает массив строк; пустой текст даёт пустой массив.
 */
export function chunkText(text, limit = MAX_TTS_CHARS) {
  const normalized = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const units = [];
  for (const sentence of splitSentences(normalized)) {
    if (sentence.length <= limit) {
      units.push(sentence);
      continue;
    }
    for (const clause of splitClauses(sentence)) {
      if (clause.length <= limit) {
        units.push(clause);
      } else {
        units.push(...splitWords(clause, limit));
      }
    }
  }

  // Собираем единицы обратно в куски, пока влезает.
  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (!current) {
      current = unit;
    } else if (current.length + 1 + unit.length <= limit) {
      current += ` ${unit}`;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/**
 * Готовит текст к озвучке: убирает Markdown и служебные блоки.
 * Silero читает всё, что дали, поэтому код и таблицы надо вырезать.
 */
export function stripMarkdown(text) {
  let out = String(text || '');

  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/~~~[\s\S]*?~~~/g, ' ');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');
  out = out.replace(/^\s*\|.*\|\s*$/gm, ' ');
  out = out.replace(/^\s*[-:|\s]{3,}$/gm, ' ');
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
