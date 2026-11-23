import fs from 'node:fs';
import { resolveInside, assertNotSecret, markRead, readGuard } from './fs.js';

/**
 * Ноутбуки Jupyter (CC1.10, ADR 0079): `read_file` показывает .ipynb по ячейкам,
 * `notebook_edit` меняет, вставляет и удаляет ячейки. JSON ноутбука пишется с
 * тем же отступом, что был; у изменённой ячейки кода сбрасываются выводы.
 */

const MAX_OUTPUT = 2000;
const srcText = (source) => (Array.isArray(source) ? source.join('') : String(source ?? ''));
const toSource = (text) => {
  const lines = String(text ?? '').split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter((line, i, all) => !(i === all.length - 1 && line === ''));
};

function outputText(out) {
  if (out.output_type === 'stream') return srcText(out.text);
  if (out.output_type === 'error') return `${out.ename}: ${out.evalue}`;
  const data = out.data || {};
  if (data['text/plain']) return srcText(data['text/plain']);
  const kinds = Object.keys(data).filter((k) => k !== 'text/plain');
  return kinds.length ? `[${kinds.join(', ')}]` : '';
}

/** Ноутбук → текст по ячейкам с номерами, id, языком и кратким выводом. */
export function renderNotebook(nb) {
  const cells = Array.isArray(nb?.cells) ? nb.cells : [];
  const lang = nb?.metadata?.kernelspec?.language || nb?.metadata?.language_info?.name || 'python';
  const parts = [`[Ноутбук Jupyter: ячеек ${cells.length}, язык ${lang}. Правка — notebook_edit по номеру ячейки.]`];
  cells.forEach((cell, i) => {
    const type = cell.cell_type || 'code';
    parts.push(`\n### Ячейка ${i} · ${type}${cell.id ? ` · id ${cell.id}` : ''}${type === 'code' && cell.execution_count ? ` · [${cell.execution_count}]` : ''}`);
    parts.push(type === 'code' ? `\`\`\`${lang}\n${srcText(cell.source)}\n\`\`\`` : srcText(cell.source));
    const outputs = (cell.outputs || []).map(outputText).filter(Boolean).join('\n');
    if (outputs) parts.push(`Вывод:\n${outputs.length > MAX_OUTPUT ? `${outputs.slice(0, MAX_OUTPUT)}\n… обрезано` : outputs}`);
  });
  return parts.join('\n');
}

/** Отступ JSON файла: у nbformat обычно 1 пробел. */
function indentOf(raw) {
  const m = /^\{\r?\n([ \t]+)"/.exec(raw);
  return m ? m[1] : 1;
}

/** План правки: { file, raw, before, after, summary } или текст ошибки. */
function planNotebookEdit(ctx, args) {
  const file = resolveInside(ctx, args.path);
  assertNotSecret(ctx, file, 'изменение');
  if (!/\.ipynb$/i.test(file)) return 'notebook_edit — только для .ipynb; остальное — edit_file';
  if (!fs.existsSync(file)) return `Файл не найден: ${file}`;
  const guard = readGuard(ctx, file);
  if (guard) return guard;
  const raw = fs.readFileSync(file, 'utf8');
  let nb;
  try {
    nb = JSON.parse(raw);
  } catch (err) {
    return `Ноутбук не разобран как JSON: ${err.message}`;
  }
  if (!Array.isArray(nb.cells)) return 'В файле нет ячеек (cells) — это не ноутбук Jupyter';
  const mode = args.edit_mode || 'replace';
  if (!['replace', 'insert', 'delete'].includes(mode)) return 'edit_mode: replace, insert или delete';
  let index = Number.isInteger(args.cell) ? args.cell : -1;
  if (args.cell_id) index = nb.cells.findIndex((c) => c.id === args.cell_id);
  const count = nb.cells.length;
  if (mode === 'insert') {
    if (index < 0) index = count;
    if (index > count) return `Нет места ${index}: ячеек ${count} (вставка — от 0 до ${count})`;
  } else if (index < 0 || index >= count) {
    return `Нет ячейки ${args.cell_id ? `id ${args.cell_id}` : index}: ячеек ${count} (номера от 0)`;
  }
  if (mode !== 'delete' && typeof args.new_source !== 'string') return 'Нужен new_source — новый текст ячейки';
  const before = index < count ? srcText(nb.cells[index].source) : '';
  let summary;
  if (mode === 'delete') {
    nb.cells.splice(index, 1);
    summary = `удалена ячейка ${index}`;
  } else if (mode === 'insert') {
    const type = args.cell_type === 'markdown' ? 'markdown' : 'code';
    const cell = { cell_type: type, metadata: {}, source: toSource(args.new_source) };
    if (type === 'code') Object.assign(cell, { execution_count: null, outputs: [] });
    // nbformat 4.5+: у ячеек есть id.
    if (nb.nbformat > 4 || (nb.nbformat === 4 && (nb.nbformat_minor ?? 0) >= 5)) cell.id = Math.random().toString(16).slice(2, 10);
    nb.cells.splice(index, 0, cell);
    summary = `вставлена ячейка ${index} (${type})`;
  } else {
    const cell = nb.cells[index];
    cell.source = toSource(args.new_source);
    if (args.cell_type && args.cell_type !== cell.cell_type) {
      cell.cell_type = args.cell_type === 'markdown' ? 'markdown' : 'code';
      if (cell.cell_type === 'markdown') {
        delete cell.outputs;
        delete cell.execution_count;
      }
    }
    // Старый вывод больше не соответствует коду.
    if (cell.cell_type === 'code') Object.assign(cell, { outputs: [], execution_count: null });
    summary = `изменена ячейка ${index}`;
  }
  const after = `${JSON.stringify(nb, null, indentOf(raw))}\n`;
  return { file, raw, before, newText: mode === 'delete' ? '' : args.new_source, after, summary };
}

export const notebookTools = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'notebook_edit',
        description:
          'Изменить ноутбук Jupyter (.ipynb): заменить текст ячейки, вставить новую или удалить. Сначала прочитай ноутбук read_file — он покажет ячейки с номерами. ' +
          'У изменённой ячейки кода старый вывод сбрасывается.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            cell: { type: 'number', description: 'Номер ячейки с 0 (для insert — куда вставить; по умолчанию в конец)' },
            cell_id: { type: 'string', description: 'id ячейки вместо номера' },
            new_source: { type: 'string', description: 'Новый текст ячейки' },
            cell_type: { type: 'string', enum: ['code', 'markdown'] },
            edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'По умолчанию replace' },
          },
          required: ['path'],
        },
      },
    },
    precheck(ctx, args) {
      const plan = planNotebookEdit(ctx, args);
      return typeof plan === 'string' ? plan : null;
    },
    preview(ctx, args) {
      const plan = planNotebookEdit(ctx, args);
      if (typeof plan === 'string') return { before: '', after: '' };
      return { before: plan.before, after: plan.newText };
    },
    async run(ctx, args) {
      const plan = planNotebookEdit(ctx, args);
      if (typeof plan === 'string') return plan;
      ctx.beforeWrite?.(plan.file);
      fs.writeFileSync(plan.file, plan.after, 'utf8');
      markRead(ctx, plan.file);
      return `Ноутбук ${plan.file}: ${plan.summary}`;
    },
  },
];
