#!/usr/bin/env node
/**
 * Хук PostToolUse пакета impeccable-check (N5, ADR 0101): после правки UI-файла
 * (.html .css .scss .jsx .tsx .vue .svelte) ищет частые ошибки интерфейса — по
 * мотивам проверок impeccable (audit, harden) — и возвращает находки агенту
 * через additionalContext. Ничего не блокирует; без зависимостей.
 *
 * Вход — JSON на stdin: { tool_name, tool_input: { path }, ... }; MAI_PROJECT_DIR.
 */
import fs from 'node:fs';
import path from 'node:path';

const UI = /\.(html?|css|scss|less|jsx|tsx|vue|svelte|astro)$/i;

/** Правила: id, где искать (css | markup | any), регулярка, что сказать. */
export const RULES = [
  { id: 'focus-outline', scope: 'css', re: /outline\s*:\s*(?:none|0)\b/i, say: 'outline: none — фокус с клавиатуры не виден; добавьте :focus-visible со своей обводкой' },
  { id: 'transition-all', scope: 'css', re: /transition\s*:\s*all\b/i, say: 'transition: all — анимируются и размеры с отступами; перечислите свойства (opacity, transform)' },
  { id: 'tiny-font', scope: 'css', re: /font-size\s*:\s*(?:[0-9]|1[01])(?:\.\d+)?px\b/i, say: 'шрифт меньше 12px — трудно читать; минимум 12px, основной текст — 14–16px' },
  { id: 'z-index', scope: 'css', re: /z-index\s*:\s*\d{4,}/i, say: 'z-index 1000+ — признак войны слоёв; заведите шкалу (dropdown, modal, toast)' },
  { id: 'important', scope: 'css', re: /!important/gi, min: 3, say: '!important трижды и больше — каскад сломан; поднимите специфичность или упростите селекторы' },
  { id: 'img-alt', scope: 'markup', re: /<img\b(?![^>]*\balt\s*=)[^>]*>/i, say: '<img> без alt — для декоративных alt="", для смысловых — описание' },
  { id: 'click-div', scope: 'markup', re: /<(div|span)\b[^>]*\bon(?:click|Click)\s*=/, say: 'клик на <div>/<span> — нет фокуса и Enter/Space; используйте <button>' },
  { id: 'placeholder-label', scope: 'markup', re: /<input\b(?![^>]*\b(?:aria-label|aria-labelledby|id)\s*=)[^>]*\bplaceholder\s*=/i, say: 'поле только с placeholder — подпись пропадает при вводе; добавьте <label> или aria-label' },
  { id: 'user-scalable', scope: 'markup', re: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?\b/i, say: 'запрет масштабирования — недоступно для слабовидящих; уберите user-scalable=no' },
];

export function checkUi(file, text) {
  const ext = path.extname(file).toLowerCase();
  const css = /\.(css|scss|less)$/.test(ext);
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const rule of RULES) {
    if (rule.scope === 'css' && !css && !/<style|style=|styled\.|css`/.test(text)) continue;
    if (rule.scope === 'markup' && css) continue;
    if (rule.min) {
      const n = (String(text).match(rule.re) || []).length;
      if (n >= rule.min) findings.push({ id: rule.id, line: 0, say: `${rule.say} (${n} раз)` });
      continue;
    }
    const at = lines.findIndex((l) => rule.re.test(l));
    if (at >= 0) findings.push({ id: rule.id, line: at + 1, say: rule.say });
  }
  return findings;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const rel = String(input.tool_input?.path || input.tool_input?.file_path || '');
  if (!rel || !UI.test(rel)) return;
  const file = path.resolve(process.env.MAI_PROJECT_DIR || process.cwd(), rel);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const found = checkUi(file, text);
  if (!found.length) return;
  const list = found.map((f) => `- ${rel}${f.line ? `:${f.line}` : ''} — ${f.say}`).join('\n');
  process.stdout.write(JSON.stringify({ additionalContext: `Проверка интерфейса (impeccable-check): ${found.length}\n${list}\nИсправь, если это не осознанное решение, и скажи пользователю, что поправил.` }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ui-check.mjs')) await main();
