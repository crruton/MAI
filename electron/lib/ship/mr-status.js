/**
 * MAI Ship: статус MR для MAI (E3.C2, ADR 0125). Без Electron.
 *
 * Источник — GitLab через `glab api` в папке проекта: используется вход пользователя в glab,
 * токен MAI не хранит. Из MR, комментариев и обсуждений собирается карточка: pipeline, находки
 * ревью, раунды steward, решение approver'а (и на тот ли SHA), расход моделей, нужен ли человек.
 */
import { execFile } from 'node:child_process';
import { createGitlab } from './gitlab.js';
import { parseDecision } from './report.js';
import { mrCost } from './cost.js';

const FINDING_RE = /<!-- mai-ship:finding:[0-9a-f]{16} -->/;
const ROUND = '<!-- mai-ship:steward-round -->';

/**
 * fetch поверх `glab api`: createGitlab работает без токена — вход берёт glab.
 * @param {{ cwd: string, exec?: (args: string[], opts) => Promise<{ stdout: string }>, timeoutMs?: number }} o
 */
export function glabFetch({ cwd, exec = execGlab, timeoutMs = 20_000 }) {
  return async (url, init = {}) => {
    const u = new URL(url);
    // createGitlab кодирует проект: «:id» (подстановка glab) возвращаем как есть.
    const apiPath = `${u.pathname.replace(/^\/api\/v4\//, '').replace(/%3Aid(?=\/|$)/i, ':id')}${u.search}`;
    const args = ['api', '--method', init.method || 'GET', apiPath];
    if (init.body) for (const [k, v] of Object.entries(JSON.parse(init.body))) args.push('-f', `${k}=${Array.isArray(v) ? v.join(',') : v}`);
    try {
      const { stdout } = await exec(args, { cwd, timeout: timeoutMs });
      return { ok: true, status: 200, json: async () => JSON.parse(stdout || 'null'), text: async () => stdout };
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('glab не установлен или не в PATH');
      const text = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
      const status = Number(/\b([45]\d\d)\b/.exec(text)?.[1] || 500);
      return { ok: false, status, json: async () => ({}), text: async () => text.trim().slice(0, 300) };
    }
  };
}

function execGlab(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('glab', args, { ...opts, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout });
    });
  });
}

/** Карточка MR из MR (с head_pipeline), комментариев и обсуждений. */
export function mrStatus({ mr, notes = [], discussions = [] }) {
  const labels = Array.isArray(mr.labels) ? mr.labels : [];
  let decision = null;
  for (const n of notes) {
    const d = parseDecision(n.body);
    if (d && (!decision || String(d.at) > String(decision.at))) decision = d;
  }
  const findings = discussions.map((d) => d.notes?.[0]).filter((n) => n && FINDING_RE.test(String(n.body || '')));
  const openFindings = findings.filter((n) => !n.resolved);
  const rounds = notes.filter((n) => String(n.body || '').includes(ROUND));
  const pipeline = mr.head_pipeline?.status || mr.pipeline?.status || '';
  const cost = mrCost(notes);
  const status = labels.includes('ship::blocked')
    ? 'blocked'
    : labels.includes('ship::needs-human')
      ? 'needs-human'
      : labels.includes('ship::paused')
        ? 'paused'
        : pipeline === 'failed'
          ? 'red-ci'
          : labels.includes('ship::approved') && decision?.sha === mr.sha
            ? 'approved'
            : 'in-progress';
  return {
    iid: mr.iid,
    title: mr.title || '',
    url: mr.web_url || '',
    branch: mr.source_branch || '',
    draft: Boolean(mr.draft || mr.work_in_progress),
    author: mr.author?.username || '',
    updatedAt: mr.updated_at || '',
    pipeline,
    review: { findings: findings.length, open: openFindings.length, blocking: labels.includes('ship::blocking') },
    steward: { rounds: rounds.length, lastAt: rounds.map((n) => String(n.created_at || '')).sort().pop() || '' },
    approver: decision ? { decision: decision.decision, action: decision.action, rule: decision.rule, mode: decision.mode, stale: decision.sha !== mr.sha } : null,
    cost: cost.usd || cost.tokens ? cost : null,
    status,
  };
}

/** MR проекта за `days` дней (открытые, слитые, закрытые) — для связи с задачами Multica (E3.C4). */
export async function collectRecentMrs({ cwd, days = 14, exec, now = Date.now() } = {}) {
  const gitlab = createGitlab({ url: 'https://glab.local', token: 'glab', fetch: glabFetch({ cwd, exec }) });
  const project = await gitlab.getProject(':id');
  const mrs = await gitlab.listMrs(project.id, { updatedAfter: new Date(now - days * 86_400_000).toISOString() });
  return mrs.map((m) => ({ iid: m.iid, title: m.title || '', state: m.state, source_branch: m.source_branch || '', web_url: m.web_url || '' }));
}

/** Открытые MR проекта папки (до `limit`, свежие сверху) → карточки. */
export async function collectMrStatuses({ cwd, limit = 10, exec } = {}) {
  const gitlab = createGitlab({ url: 'https://glab.local', token: 'glab', fetch: glabFetch({ cwd, exec }) });
  // `:id` glab подставляет сам по remote папки.
  const project = await gitlab.getProject(':id');
  const mrs = await gitlab.listOpenMrs(project.id, limit);
  return Promise.all(
    mrs.map(async (m) => {
      const [mr, notes, discussions] = await Promise.all([gitlab.getMr(project.id, m.iid), gitlab.getNotes(project.id, m.iid), gitlab.getDiscussions(project.id, m.iid)]);
      return mrStatus({ mr, notes, discussions });
    }),
  );
}
