/**
 * Проверки и отчёт набора сценариев (Q5, ADR 0082). Без Electron: раннер
 * запускает агента через `mai -p`, а сюда приходят папка задачи и ответ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { docxToMarkdown, pptxToMarkdown, readXlsx, sheetsToText } from '../electron/lib/documents.js';

export const CHECK_TYPES = ['file_exists', 'file_contains', 'file_unchanged', 'file_equals_lines', 'line_count', 'json_valid', 'file_magic', 'doc_contains', 'no_text', 'any_file_contains', 'answer_contains', 'command'];

/** Создаёт файлы задачи в папке. */
export function writeFiles(dir, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

/** Все файлы папки (кроме служебных) с путями от неё. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.mai-code' || entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const globRe = (glob) => new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')}$`);

/** Текст документа для проверки: docx → Markdown, pptx → слайды, xlsx → строки листов. */
export function documentText(file) {
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') return docxToMarkdown(buf);
  if (ext === '.pptx') return pptxToMarkdown(buf);
  if (ext === '.xlsx') return sheetsToText(readXlsx(buf));
  return buf.toString('utf8');
}

/**
 * Проверка одной задачи.
 * @returns {{ ok: boolean, detail: string }}
 */
export function runCheck(check, { dir, answer = '', original = {} }) {
  const fail = (detail) => ({ ok: false, detail });
  const pass = (detail = '') => ({ ok: true, detail });
  try {
    switch (check.type) {
      case 'file_exists':
        return fs.existsSync(path.join(dir, check.path)) ? pass() : fail(`нет файла ${check.path}`);
      case 'file_contains': {
        const text = read(dir, check.path);
        if (text === null) return fail(`нет файла ${check.path}`);
        return new RegExp(check.regex, 'mi').test(text) ? pass() : fail(`в ${check.path} нет /${check.regex}/`);
      }
      case 'file_unchanged': {
        const text = read(dir, check.path);
        return text === original[check.path] ? pass() : fail(text === null ? `${check.path} удалён` : `${check.path} изменён`);
      }
      case 'file_equals_lines': {
        const text = read(dir, check.path);
        if (text === null) return fail(`нет файла ${check.path}`);
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        return JSON.stringify(lines) === JSON.stringify(check.lines) ? pass() : fail(`строки: ${JSON.stringify(lines).slice(0, 200)}`);
      }
      case 'line_count': {
        const text = read(dir, check.path);
        if (text === null) return fail(`нет файла ${check.path}`);
        const n = text.split(/\r?\n/).filter((l) => l.trim()).length;
        return n === check.count ? pass() : fail(`строк ${n}, нужно ${check.count}`);
      }
      case 'json_valid': {
        const text = read(dir, check.path);
        if (text === null) return fail(`нет файла ${check.path}`);
        JSON.parse(text);
        return pass();
      }
      case 'file_magic': {
        const file = path.join(dir, check.path);
        if (!fs.existsSync(file)) return fail(`нет файла ${check.path}`);
        return fs.readFileSync(file).subarray(0, check.magic.length).toString('latin1') === check.magic ? pass() : fail(`${check.path}: не ${check.magic}`);
      }
      case 'doc_contains': {
        const file = path.join(dir, check.path);
        if (!fs.existsSync(file)) return fail(`нет файла ${check.path}`);
        return new RegExp(check.regex, 'mi').test(documentText(file)) ? pass() : fail(`в ${check.path} нет /${check.regex}/`);
      }
      case 'no_text': {
        const re = new RegExp(check.regex, 'm');
        const bad = listFiles(dir).filter((f) => globRe(check.glob).test(f) && re.test(read(dir, f) || ''));
        return bad.length ? fail(`/${check.regex}/ остался в ${bad.join(', ')}`) : pass();
      }
      case 'any_file_contains': {
        const re = new RegExp(check.regex, 'mi');
        const hit = listFiles(dir).find((f) => globRe(check.glob).test(f) && re.test(read(dir, f) || ''));
        return hit ? pass(hit) : fail(`ни в одном ${check.glob} нет /${check.regex}/`);
      }
      case 'answer_contains':
        return new RegExp(check.regex, 'mi').test(answer) ? pass() : fail(`в ответе нет /${check.regex}/`);
      case 'command': {
        const r = spawnSync(check.run, { cwd: dir, shell: true, encoding: 'utf8', timeout: (check.timeoutSec || 30) * 1000, windowsHide: true });
        if (r.status !== 0) return fail(`«${check.run}»: код ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
        if (check.stdout && !String(r.stdout).includes(check.stdout)) return fail(`«${check.run}»: в выводе нет «${check.stdout}»: ${String(r.stdout).trim().slice(0, 120)}`);
        return pass();
      }
      default:
        return fail(`неизвестная проверка ${check.type}`);
    }
  } catch (err) {
    return fail(`${check.type}: ${err.message}`);
  }
}

/** Проверки задачи → { ok, checks: [{ type, ok, detail }] }. */
export function gradeTask(task, ctx) {
  const checks = (task.checks || []).map((c) => ({ type: c.type, ...runCheck(c, ctx) }));
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

/** Описание набора: ошибки формата (id, проверки, файлы). */
export function validateTasks(data) {
  const errors = [];
  const ids = new Set();
  for (const t of data?.tasks || []) {
    if (!/^[a-z0-9-]+$/.test(t.id || '')) errors.push(`неверный id: ${t.id}`);
    if (ids.has(t.id)) errors.push(`повтор id: ${t.id}`);
    ids.add(t.id);
    if (!['code', 'task'].includes(t.kind)) errors.push(`${t.id}: kind code или task`);
    if (!String(t.prompt || '').trim()) errors.push(`${t.id}: нет prompt`);
    if (!(t.checks || []).length) errors.push(`${t.id}: нет проверок`);
    for (const c of t.checks || []) if (!CHECK_TYPES.includes(c.type)) errors.push(`${t.id}: неизвестная проверка ${c.type}`);
    for (const rel of Object.keys(t.files || {})) if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) errors.push(`${t.id}: файл вне папки ${rel}`);
  }
  return errors;
}

/** Отчёт Markdown: сводка по профилям и матрица задач. */
export function reportMarkdown({ results, profiles, tasks, startedAt }) {
  const lines = [`# Набор сценариев MAI — ${startedAt}`, ''];
  lines.push('| Профиль | Пройдено | Токены ↑/↓ | Время |', '|---|---|---|---|');
  for (const p of profiles) {
    const rows = results.filter((r) => r.profile === p.name);
    const ok = rows.filter((r) => r.ok).length;
    const tin = rows.reduce((s, r) => s + (r.usage?.input || 0), 0);
    const tout = rows.reduce((s, r) => s + (r.usage?.output || 0), 0);
    const sec = Math.round(rows.reduce((s, r) => s + (r.durationMs || 0), 0) / 1000);
    lines.push(`| ${p.name} | ${ok} из ${rows.length} (${rows.length ? Math.round((ok / rows.length) * 100) : 0}%) | ${tin}/${tout} | ${sec} с |`);
  }
  lines.push('', `| Задача | ${profiles.map((p) => p.name).join(' | ')} |`, `|---|${profiles.map(() => '---').join('|')}|`);
  for (const t of tasks) {
    const cells = profiles.map((p) => {
      const r = results.find((x) => x.profile === p.name && x.task === t.id);
      return r ? (r.ok ? '✅' : `❌ ${(r.error || r.checks.find((c) => !c.ok)?.detail || '').replace(/\|/g, '\\|').slice(0, 80)}`) : '—';
    });
    lines.push(`| ${t.id} — ${t.title} | ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}
