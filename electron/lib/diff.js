/**
 * Построчный unified diff для запроса разрешения и карточки правки (CC7.3).
 * Без зависимостей: LCS по строкам с ограничением размера.
 */

const MAX_CELLS = 4_000_000; // n*m для таблицы LCS
const DEFAULT_MAX_LINES = 400;

function splitLines(text) {
  const value = String(text ?? '');
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Операции diff: [{ op: ' ' | '-' | '+', text, a, b }] (a, b — номера строк с 1). */
function operations(before, after) {
  // Общие начало и конец убираем сразу: так большие файлы с маленькой правкой укладываются в лимит.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ op: ' ', text: before[i], a: i + 1, b: i + 1 });

  if (a.length * b.length > MAX_CELLS) {
    // Слишком большая разница: показываем как замену блока.
    a.forEach((text, i) => ops.push({ op: '-', text, a: start + i + 1 }));
    b.forEach((text, i) => ops.push({ op: '+', text, b: start + i + 1 }));
  } else {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        ops.push({ op: ' ', text: a[i], a: start + i + 1, b: start + j + 1 });
        i += 1;
        j += 1;
      } else if (i < a.length && (j >= b.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) {
        // Сначала удаления, потом вставки — как в unified diff.
        ops.push({ op: '-', text: a[i], a: start + i + 1 });
        i += 1;
      } else {
        ops.push({ op: '+', text: b[j], b: start + j + 1 });
        j += 1;
      }
    }
  }
  for (let k = 0; k < before.length - endA; k += 1) {
    ops.push({ op: ' ', text: before[endA + k], a: endA + k + 1, b: endB + k + 1 });
  }
  return ops;
}

/**
 * @returns {{ lines: Array<{type:' '|'+'|'-'|'@', text:string}>, added:number, removed:number, truncated:boolean, created:boolean }}
 */
export function unifiedDiff(beforeText, afterText, { context = 3, maxLines = DEFAULT_MAX_LINES } = {}) {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const ops = operations(before, after);
  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;
  const changed = ops.map((o, index) => (o.op === ' ' ? -1 : index)).filter((index) => index >= 0);
  const lines = [];
  let truncated = false;
  if (changed.length) {
    // Ханки: изменённые строки плюс `context` строк вокруг.
    const keep = new Set();
    for (const index of changed) {
      for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) keep.add(k);
    }
    let previous = -2;
    for (let index = 0; index < ops.length; index += 1) {
      if (!keep.has(index)) continue;
      if (index !== previous + 1) {
        const op = ops[index];
        lines.push({ type: '@', text: `@@ строка ${op.a || op.b || 1} @@` });
      }
      lines.push({ type: ops[index].op, text: ops[index].text });
      previous = index;
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  }
  return { lines, added, removed, truncated, created: !before.length && after.length > 0 };
}
