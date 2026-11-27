/**
 * MAI Ship: эскалация к человеку (E3.F4, ADR 0123). Без Electron.
 *
 * Когда approver решил «нужен человек» или «заблокировано», MR назначается владельцам изменённых
 * файлов по CODEOWNERS target branch, а в канал из `ship.yaml` (`notify`) уходит уведомление.
 * Повтор того же решения по тому же SHA никого не дёргает второй раз.
 */
import { globToRegExp } from '../tools/fs.js';
import { normalizeChannel, channelRequest } from '../notify.js';

export const CODEOWNERS_PATHS = ['CODEOWNERS', '.gitlab/CODEOWNERS', 'docs/CODEOWNERS'];

/** Шаблон CODEOWNERS (как в .gitignore) → RegExp пути от корня. */
export function ownerPatternRe(pattern) {
  let p = String(pattern).trim();
  // Маска — по исходному шаблону: префикс «**/» ниже добавляем сами.
  const wildcard = /[*?]/.test(p);
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dir = p.endsWith('/');
  if (dir) p = `${p}**`;
  // Без «/» внутри — имя в любой папке; с «/» — путь от корня.
  if (!anchored && !p.replace(/\/\*\*$/, '').includes('/')) p = `**/${p}`;
  const re = globToRegExp(p).source;
  // Шаблон-папка без «/» в конце тоже покрывает файлы внутри неё.
  return new RegExp(dir || wildcard ? re : `${re.replace(/\$$/, '')}(?:/.*)?$`);
}

/**
 * Разбор CODEOWNERS: секции `[Имя]` и `^[Имя]` (необязательная), комментарии, владельцы
 * `@user`, `@group/sub`, email.
 * @returns {Array<{ section: string, optional: boolean, re: RegExp, owners: string[] }>}
 */
export function parseCodeowners(text) {
  const rules = [];
  let section = '';
  let optional = false;
  let sectionOwners = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const head = /^(\^)?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (head) {
      optional = Boolean(head[1]);
      section = head[2].trim();
      sectionOwners = head[3].split(/\s+/).filter(Boolean);
      continue;
    }
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ section, optional, re: ownerPatternRe(pattern), owners: owners.length ? owners : sectionOwners });
  }
  return rules;
}

/** Владельцы файлов: в каждой секции побеждает последнее совпадение, секции объединяются. */
export function ownersFor(rules, files) {
  const owners = new Set();
  const sections = [...new Set(rules.map((r) => r.section))];
  for (const file of files) {
    for (const s of sections) {
      const hit = rules.filter((r) => r.section === s && r.re.test(file)).pop();
      if (hit && !hit.optional) for (const o of hit.owners) owners.add(o);
    }
  }
  return [...owners];
}

/** Канал уведомлений Ship: тип из ship.yaml, секреты — из переменных CI. */
export function shipChannel(notify = {}, env = {}) {
  const type = notify.channel || 'none';
  if (type === 'none') return null;
  if (type === 'telegram') return normalizeChannel({ type, token: env.SHIP_NOTIFY_TELEGRAM_TOKEN, chatId: env.SHIP_NOTIFY_TELEGRAM_CHAT });
  return normalizeChannel({ type, url: env.SHIP_NOTIFY_WEBHOOK_URL });
}

/** Тип события уведомления по действию approver'а. */
export function eventFor(action) {
  return { needs_human: 'needs_human', block: 'blocked' }[action] || '';
}

/**
 * @param {{ gitlab, project, iid, mr, files: string[], result, previous?: object|null, sha: string,
 *           shipCfg: object, env?: object, fetch?: Function, self?: string }} o
 * @returns {Promise<{ reviewers: string[], notified: boolean, skipped?: string, errors: string[] }>}
 */
export async function escalate({ gitlab, project, iid, mr, files, result, previous = null, sha, shipCfg = {}, env = {}, fetch: doFetch = globalThis.fetch, self = '' }) {
  const out = { reviewers: [], notified: false, errors: [] };
  const event = eventFor(result.action);
  if (!event) return { ...out, skipped: 'не эскалация' };
  // То же решение по тому же SHA уже было — людей второй раз не зовём.
  if (previous && previous.sha === sha && previous.action === result.action) return { ...out, skipped: 'уже сообщено по этому SHA' };

  if (result.action === 'needs_human' && !(mr.reviewers || []).length) {
    let text = null;
    for (const p of CODEOWNERS_PATHS) {
      text = await gitlab.getFile(project, p, mr.target_branch);
      if (text != null) break;
    }
    if (text != null) {
      const author = mr.author?.username || '';
      const names = ownersFor(parseCodeowners(text), files)
        .filter((o) => o.startsWith('@') && !o.slice(1).includes('/'))
        .map((o) => o.slice(1))
        .filter((u) => u !== author && u !== self);
      const ids = [];
      for (const name of names) {
        try {
          const found = await gitlab.findUser(name);
          if (found?.id) ids.push({ id: found.id, name });
        } catch (err) {
          out.errors.push(`@${name}: ${err.message}`);
        }
      }
      if (ids.length) {
        try {
          await gitlab.setReviewers(project, iid, ids.map((x) => x.id));
          out.reviewers = ids.map((x) => x.name);
        } catch {
          // GitLab Free принимает одного ревьюера.
          try {
            await gitlab.setReviewers(project, iid, [ids[0].id]);
            out.reviewers = [ids[0].name];
          } catch (err) {
            out.errors.push(`ревьюеры: ${err.message}`);
          }
        }
      }
    }
  }

  const channel = shipChannel(shipCfg.notify, env);
  const wanted = Array.isArray(shipCfg.notify?.events) ? shipCfg.notify.events : ['needs_human', 'blocked'];
  if (channel && wanted.includes(event)) {
    const title = `${mr.title || `MR !${iid}`} — ${event === 'blocked' ? 'заблокирован' : 'нужен человек'}`;
    const body = `${result.reason}${out.reviewers.length ? ` · ревьюеры: ${out.reviewers.map((r) => `@${r}`).join(', ')}` : ''}${mr.web_url ? ` · ${mr.web_url}` : ''}`;
    const req = channelRequest(channel, { kind: event === 'blocked' ? 'MAI Ship · заблокировано' : 'MAI Ship · нужен человек', title, body });
    try {
      const res = await doFetch(req.url, { ...req.init, signal: AbortSignal.timeout ? AbortSignal.timeout(15_000) : undefined });
      out.notified = Boolean(res?.ok);
      if (!res?.ok) out.errors.push(`уведомление: HTTP ${res?.status}`);
    } catch (err) {
      out.errors.push(`уведомление: ${err.message}`);
    }
  }
  return out;
}
