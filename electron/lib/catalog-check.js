/**
 * Проверка каталога пакетов команды (ADR 0111).
 *
 * Каталог — `mai-marketplace.json` в корне репозитория и пакеты в `catalog/<имя>/`
 * (формат ADR 0037, 0042). Проверка не исполняет код пакетов: только читает файлы.
 * Ошибка не пускает каталог в `dev`; предупреждение печатается и не валит проверку.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CATALOG } from './marketplace.js';
import { MANIFEST, NAME_RE } from './packages.js';

export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const POLICY_FILE = 'catalog/catalog-policy.json';
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py', '.sh', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.tpl', '.tf', '.hcl', '']);
const MAX_SKILL_LINES = 500;

/** Настоящие токены. Плейсхолдеры вида `glpat-xxxxxxxx` и `sk-...` не считаются. */
const SECRET_PATTERNS = [
  ['GitLab-токен', /glpat-(?!x{6,})[A-Za-z0-9_-]{20,}/],
  ['GitHub-токен', /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{30,}/],
  ['ключ API', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/],
  ['токен Multica', /\bmul_[A-Za-z0-9]{20,}/],
  ['AWS-ключ', /\bAKIA[0-9A-Z]{16}\b/],
  ['приватный ключ', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Slack-токен', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Frontmatter `---` … `---`: только ключи верхнего уровня `ключ: значение`. */
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!match) return null;
  const data = {};
  let last = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      last = kv[1];
      data[last] = kv[2].replace(/^["']|["']$/g, '').trim();
    } else if (last && /^\s+\S/.test(line)) {
      data[last] = `${data[last]} ${line.trim()}`.trim();
    }
  }
  for (const key of Object.keys(data)) if (/^[>|]-?$/.test(data[key].split(' ')[0])) data[key] = data[key].replace(/^[>|]-?\s*/, '');
  return data;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function hostRe(host) {
  return new RegExp(`(?:^|[^A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${host.replace(/\./g, '\\.')}\\b`, 'i');
}

function emailAllowed(email, allow) {
  const lower = email.toLowerCase();
  return allow.some((rule) => (rule.startsWith('*@') ? lower.endsWith(rule.slice(1).toLowerCase()) : lower === rule.toLowerCase()));
}

/** Имена навыков из фраз «навык `имя`», «скилл `имя`», «скиллу `имя`». */
export function skillRefs(text) {
  return [...String(text).matchAll(/(?:скилл|навык)[а-яё]*\s+`([a-z][a-z0-9-]+)`/gi)].map((m) => m[1]);
}

/** Поиск секретов, запрещённых хостов и email в тексте одного файла. */
export function scanText(text, { denyHosts = [], allowEmails = [], denyTerms = [] } = {}) {
  const found = [];
  for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) found.push(label);
  for (const host of denyHosts) if (hostRe(host).test(text)) found.push(`внутренний хост ${host}`);
  const lower = text.toLowerCase();
  for (const term of denyTerms) if (term && lower.includes(String(term).toLowerCase())) found.push(`внутреннее название «${term}»`);
  for (const email of text.match(EMAIL_RE) || []) {
    if (!emailAllowed(email, allowEmails)) found.push(`email ${email}`);
  }
  return [...new Set(found)];
}

/**
 * @param {string} root корень репозитория с `mai-marketplace.json`
 * @returns {{ errors: string[], warnings: string[], packages: number, skills: number }}
 */
export function checkCatalog(root) {
  const errors = [];
  const warnings = [];
  let skills = 0;
  const refs = [];
  const index = readJson(path.join(root, CATALOG));
  if (!index || !Array.isArray(index.packages)) return { errors: [`${CATALOG}: нет списка packages`], warnings, packages: 0, skills };
  const policy = readJson(path.join(root, POLICY_FILE)) || {};
  const scan = { denyHosts: policy.denyHosts || [], allowEmails: policy.allowEmails || [], denyTerms: policy.denyTerms || [] };
  const seen = new Set();
  for (const [i, entry] of index.packages.entries()) {
    const at = `${CATALOG}: packages[${i}]`;
    const name = String(entry?.name || '');
    if (!NAME_RE.test(name)) {
      errors.push(`${at}: неверное имя «${name}»`);
      continue;
    }
    if (seen.has(name)) errors.push(`${at}: пакет ${name} повторяется`);
    seen.add(name);
    if (!SEMVER_RE.test(String(entry.version || ''))) errors.push(`${name}: версия «${entry.version || ''}» не semver`);
    if (!entry.description) errors.push(`${name}: нет description`);
    const source = String(entry.source || '');
    const dir = path.resolve(root, source);
    const rel = path.relative(root, dir);
    if (!source || rel.startsWith('..') || path.isAbsolute(rel) || !rel.replace(/\\/g, '/').startsWith('catalog/')) {
      errors.push(`${name}: source должен быть папкой внутри catalog/`);
      continue;
    }
    const manifest = readJson(path.join(dir, MANIFEST));
    if (!manifest) {
      errors.push(`${name}: нет ${MANIFEST} в ${source}`);
      continue;
    }
    if (manifest.name !== name) errors.push(`${name}: в ${MANIFEST} имя «${manifest.name}»`);
    if (manifest.version !== entry.version) errors.push(`${name}: в каталоге ${entry.version}, в ${MANIFEST} ${manifest.version}`);
    if (!manifest.owner) errors.push(`${name}: в ${MANIFEST} нет owner`);
    if (!manifest.license) errors.push(`${name}: в ${MANIFEST} нет license`);
    const skillsDir = path.join(dir, 'skills');
    const skillDirs = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
    if (skillDirs.length === 0) warnings.push(`${name}: в пакете нет навыков`);
    for (const skill of skillDirs) {
      skills += 1;
      const file = path.join(skillsDir, skill.name, 'SKILL.md');
      if (!fs.existsSync(file)) {
        errors.push(`${name}/${skill.name}: нет SKILL.md`);
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      for (const ref of skillRefs(text)) refs.push({ from: `${name}/${skill.name}`, ref });
      const fm = frontmatter(text);
      if (!fm) {
        errors.push(`${name}/${skill.name}: нет frontmatter`);
        continue;
      }
      if (fm.name !== skill.name) errors.push(`${name}/${skill.name}: name во frontmatter «${fm.name || ''}»`);
      if (!fm.description) errors.push(`${name}/${skill.name}: нет description`);
      if (!SEMVER_RE.test(fm.version || '')) errors.push(`${name}/${skill.name}: version «${fm.version || ''}» не semver`);
      else if (fm.version !== manifest.version) errors.push(`${name}/${skill.name}: version ${fm.version} ≠ версии пакета ${manifest.version}`);
      if (!fm.owner) errors.push(`${name}/${skill.name}: нет owner`);
      const lines = text.split('\n').length;
      if (lines > MAX_SKILL_LINES) warnings.push(`${name}/${skill.name}: SKILL.md ${lines} строк > ${MAX_SKILL_LINES}`);
      const skillDir = path.join(skillsDir, skill.name);
      if (fs.existsSync(path.join(skillDir, 'UPSTREAM.md')) && !fs.existsSync(path.join(skillDir, 'LICENSE'))) {
        errors.push(`${name}/${skill.name}: есть UPSTREAM.md, нет LICENSE`);
      }
    }
    for (const file of walk(dir)) {
      if (!TEXT_EXT.has(path.extname(file).toLowerCase()) || path.basename(file) === 'LICENSE') continue;
      for (const problem of scanText(fs.readFileSync(file, 'utf8'), scan)) {
        errors.push(`${path.relative(root, file).replace(/\\/g, '/')}: ${problem}`);
      }
    }
  }
  // Ссылки «навык `имя`» — на навык каталога или встроенный навык MAI (`skills/` в корне).
  const builtin = fs.existsSync(path.join(root, 'skills')) ? fs.readdirSync(path.join(root, 'skills')) : [];
  const known = new Set([...seen, ...builtin]);
  for (const { from, ref } of refs) if (!known.has(ref)) errors.push(`${from}: ссылка на навык «${ref}», которого нет в каталоге`);
  return { errors, warnings, packages: seen.size, skills };
}
