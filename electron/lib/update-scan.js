/**
 * Проактивный сканер обновлений (N6, ADR 0102).
 *
 * Что проверяет: зависимости npm проекта (`npm outdated`), уязвимости
 * (`npm audit`), конфликты версий (`npm ls` → problems), встроенные навыки
 * (версия в приложении новее установленной), CLI (repowise, gh) и сам MAI Code
 * (последний релиз на GitHub). Каждая находка — с риском обновления:
 * high (мажорная версия, критичная/высокая уязвимость, конфликт), medium, low.
 * Обновление — только на отдельной ветке с прогоном тестов (main.js).
 *
 * Модуль не зависит от Electron: команды и сеть передаёт вызывающий:
 *   run(cmd, args) → { code, stdout }   fetchJson(url) → объект или бросает
 */

export const RISK_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

const parse = (v) => String(v || '').replace(/^[^\d]*/, '').split(/[-+]/)[0].split('.').map((n) => Number(n) || 0);

/** Насколько прыжок: major | minor | patch | same | unknown. */
export function bumpKind(from, to) {
  if (!from || !to) return 'unknown';
  const [a1, b1, c1] = parse(from);
  const [a2, b2, c2] = parse(to);
  if (a2 > a1) return 'major';
  if (a2 === a1 && b2 > b1) return 'minor';
  if (a2 === a1 && b2 === b1 && c2 > c1) return 'patch';
  return 'same';
}

const RISK_BY_BUMP = { major: 'high', minor: 'medium', patch: 'low', unknown: 'info', same: 'info' };
const RISK_BY_SEVERITY = { critical: 'high', high: 'high', moderate: 'medium', low: 'low', info: 'info' };

/** `npm outdated --json` → обновления. */
export function parseOutdated(json) {
  const items = [];
  for (const [name, info] of Object.entries(json || {})) {
    const row = Array.isArray(info) ? info[0] : info;
    if (!row) continue;
    const bump = bumpKind(row.current, row.latest);
    items.push({
      source: 'npm',
      kind: 'update',
      name,
      current: row.current || '',
      wanted: row.wanted || '',
      latest: row.latest || '',
      bump,
      risk: row.current ? RISK_BY_BUMP[bump] : 'info',
      note: !row.current ? 'не установлен (npm install)' : bump === 'major' ? 'мажорная версия — возможны несовместимые изменения' : row.wanted && row.wanted !== row.current ? `в пределах package.json — до ${row.wanted}` : '',
    });
  }
  return items;
}

/** `npm audit --json` (npm 7+) → уязвимости. */
export function parseAudit(json) {
  const items = [];
  for (const [name, v] of Object.entries(json?.vulnerabilities || {})) {
    const via = (v.via || []).map((x) => (typeof x === 'string' ? x : x?.title)).filter(Boolean);
    const fix = v.fixAvailable;
    items.push({
      source: 'npm',
      kind: 'security',
      name,
      severity: v.severity || 'info',
      risk: RISK_BY_SEVERITY[v.severity] || 'info',
      note: `${via.slice(0, 2).join('; ') || 'уязвимость'}${fix === false ? ' — исправления нет' : fix?.isSemVerMajor ? ` — исправление: ${fix.name}@${fix.version} (мажорное)` : fix ? ' — есть исправление (npm audit fix)' : ''}`.slice(0, 300),
      fixAvailable: Boolean(fix),
    });
  }
  return items;
}

/** `npm ls --json --all` → конфликты (problems). */
export function parseLsProblems(json) {
  return (json?.problems || []).slice(0, 50).map((p) => ({ source: 'npm', kind: 'conflict', name: /(?:peer|invalid|missing|extraneous)[: ]+([@\w./-]+)/i.exec(p)?.[1] || 'зависимость', risk: /missing|invalid|peer/i.test(p) ? 'high' : 'medium', note: String(p).slice(0, 300) }));
}

/** Встроенные навыки: [{ name, bundled, installed }] → обновления. */
export function skillUpdates(list = []) {
  return list
    .filter((s) => s.bundled && s.installed && bumpKind(s.installed, s.bundled) !== 'same' && bumpKind(s.installed, s.bundled) !== 'unknown')
    .map((s) => ({ source: 'навык', kind: 'update', name: s.name, current: s.installed, latest: s.bundled, bump: bumpKind(s.installed, s.bundled), risk: 'low', note: 'обновится при следующем запуске; прежняя копия — в skills/.previous' }));
}

/** CLI и приложение: [{ name, current, latest, how }] → обновления. */
export function toolUpdates(list = []) {
  return list
    .filter((t) => t.current && t.latest && ['major', 'minor', 'patch'].includes(bumpKind(t.current, t.latest)))
    .map((t) => {
      const bump = bumpKind(t.current, t.latest);
      return { source: t.source || 'CLI', kind: 'update', name: t.name, current: t.current, latest: t.latest, bump, risk: RISK_BY_BUMP[bump], note: t.how || '' };
    });
}

const versionIn = (text) => /(\d+\.\d+(?:\.\d+)?)/.exec(String(text || ''))?.[1] || '';

/**
 * Полный скан. `projectDir` — проект с package.json (или без), `appVersion`,
 * `skills` — [{ name, bundled, installed }], `releasesRepo` — owner/repo MAI.
 * Возвращает { at, items, counts, errors }.
 */
export async function scanUpdates({ projectDir, hasPackageJson = false, appVersion = '', skills = [], releasesRepo = 'crruton/MAI', run, fetchJson, now = () => new Date() }) {
  const items = [];
  const errors = [];
  const json = (args) => {
    const r = run('npm', args, projectDir);
    // npm outdated и audit выходят с кодом 1, когда что-то нашли, — это не ошибка.
    try {
      return r.stdout ? JSON.parse(r.stdout) : null;
    } catch {
      errors.push(`npm ${args[0]}: ответ не JSON`);
      return null;
    }
  };
  if (hasPackageJson) {
    items.push(...parseOutdated(json(['outdated', '--json', '--long'])));
    items.push(...parseAudit(json(['audit', '--json'])));
    items.push(...parseLsProblems(json(['ls', '--json', '--all'])));
  }
  items.push(...skillUpdates(skills));

  const tools = [];
  const local = (cmd, args) => versionIn(run(cmd, args, projectDir)?.stdout);
  const remote = async (label, url, pick) => {
    try {
      return pick(await fetchJson(url));
    } catch (err) {
      errors.push(`${label}: ${err?.message || err}`);
      return '';
    }
  };
  const rw = local('repowise', ['--version']);
  if (rw) tools.push({ name: 'repowise', current: rw, latest: await remote('PyPI repowise', 'https://pypi.org/pypi/repowise/json', (d) => d?.info?.version || ''), how: 'uv tool upgrade repowise' });
  const gh = local('gh', ['--version']);
  if (gh) tools.push({ name: 'GitHub CLI (gh)', current: gh, latest: await remote('GitHub cli/cli', 'https://api.github.com/repos/cli/cli/releases/latest', (d) => versionIn(d?.tag_name)), how: 'winget upgrade GitHub.cli / brew upgrade gh' });
  if (appVersion && releasesRepo) {
    tools.push({ source: 'приложение', name: 'MAI Code', current: appVersion, latest: await remote('релизы MAI Code', `https://api.github.com/repos/${releasesRepo}/releases/latest`, (d) => versionIn(d?.tag_name)), how: `новый установщик — github.com/${releasesRepo}/releases` });
  }
  items.push(...toolUpdates(tools));

  items.sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.name.localeCompare(b.name));
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const i of items) counts[i.risk] += 1;
  return { at: now().toISOString(), items, counts, errors };
}

/** Пора ли сканировать: раз в intervalHours (по умолчанию сутки). */
export function scanDue(lastAt, { intervalHours = 24, now = Date.now() } = {}) {
  const t = Date.parse(lastAt || '');
  return !Number.isFinite(t) || now - t >= intervalHours * 3600_000;
}

/** npm install для выбранных: только безопасные имена и версии. */
export function installArgs(packages = []) {
  const ok = packages.filter((p) => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(p?.name || '') && /^[\w.^~<>=|*-]+$/.test(p?.version || 'latest'));
  if (!ok.length) throw new Error('Нечего обновлять: выберите пакеты');
  return ['install', ...ok.map((p) => `${p.name}@${p.version || 'latest'}`)];
}
