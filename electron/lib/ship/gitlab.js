/**
 * MAI Ship: клиент GitLab REST для ролей Ship (ADR 0108). Без Electron и без glab.
 *
 * `fetch` передаётся параметром: в CI — глобальный fetch Node, в тестах — поддельный сервер.
 * Токен — бот-учётки роли (ADR 0108): у approver'а право апрува без push.
 */

export const NOTE_MARKER = (role) => `<!-- mai-ship:${role} -->`;

export function createGitlab({ url, token, fetch: fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
  if (!url) throw new Error('GitLab: не задан адрес (GITLAB_URL или CI_SERVER_URL)');
  if (!token) throw new Error('GitLab: не задан токен (GITLAB_TOKEN)');
  const base = `${String(url).replace(/\/+$/, '')}/api/v4`;

  async function call(method, path, { body, raw = false, allow404 = false } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'PRIVATE-TOKEN': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab ${method} ${path.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (raw) return res.text();
    return res.status === 204 ? null : res.json();
  }

  async function all(path) {
    const out = [];
    for (let page = 1; page <= 20; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const chunk = await call('GET', `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      out.push(...chunk);
      if (chunk.length < 100) break;
    }
    return out;
  }

  const p = (project) => encodeURIComponent(String(project));
  const mrPath = (project, iid) => `/projects/${p(project)}/merge_requests/${Number(iid)}`;

  return {
    getMr: (project, iid) => call('GET', mrPath(project, iid)),
    /** MR проекта, обновлённые после даты (для отчёта о согласии). */
    listMrs: (project, { updatedAfter } = {}) => all(`/projects/${p(project)}/merge_requests?state=all&order_by=updated_at${updatedAfter ? `&updated_after=${encodeURIComponent(updatedAfter)}` : ''}`),
    getDiffs: (project, iid) => all(`${mrPath(project, iid)}/diffs`),
    getCommits: (project, iid) => all(`${mrPath(project, iid)}/commits`),
    getNotes: (project, iid) => all(`${mrPath(project, iid)}/notes?sort=desc`),
    /** Файл из ветки; нет файла — null. */
    getFile: (project, file, ref) =>
      call('GET', `/projects/${p(project)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(ref)}`, { raw: true, allow404: true }),
    createNote: (project, iid, body) => call('POST', `${mrPath(project, iid)}/notes`, { body: { body } }),
    updateNote: (project, iid, noteId, body) => call('PUT', `${mrPath(project, iid)}/notes/${Number(noteId)}`, { body: { body } }),
    /** Апрув привязан к SHA: GitLab откажет, если head MR уже другой. */
    approve: (project, iid, sha) => call('POST', `${mrPath(project, iid)}/approve`, { body: { sha } }),
    getPipelineJobs: (project, pipelineId) => all(`/projects/${p(project)}/pipelines/${Number(pipelineId)}/jobs`),
    getDiscussions: (project, iid) => all(`${mrPath(project, iid)}/discussions`),
    /** Обсуждение на строке diff: `position` — base/start/head SHA, new_path, new_line. */
    createDiscussion: (project, iid, body, position) => call('POST', `${mrPath(project, iid)}/discussions`, { body: { body, position } }),
    /** Кто апрувнул MR (есть и на Free). Сброс апрувов при push — настройка проекта. */
    getApprovals: (project, iid) => call('GET', `${mrPath(project, iid)}/approvals`),
    setLabels: (project, iid, { add = [], remove = [] }) =>
      call('PUT', mrPath(project, iid), { body: { ...(add.length ? { add_labels: add.join(',') } : {}), ...(remove.length ? { remove_labels: remove.join(',') } : {}) } }),
  };
}

/** Изменённые файлы и строки из ответа `/diffs`. */
export function diffFacts(diffs = []) {
  const files = [];
  let changedLines = 0;
  for (const d of diffs) {
    files.push(d.new_path || d.old_path);
    if (d.old_path && d.new_path && d.old_path !== d.new_path) files.push(d.old_path);
    for (const line of String(d.diff || '').split('\n')) {
      if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) changedLines += 1;
    }
  }
  return { files: [...new Set(files.filter(Boolean))], changedLines };
}

/** Текст diff для классификаторов, с ограничением размера. */
export function diffText(diffs = [], max = 60_000) {
  let out = '';
  for (const d of diffs) {
    const chunk = `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff || ''}\n`;
    if (out.length + chunk.length > max) {
      out += `\n[обрезано: diff больше ${max} символов]`;
      break;
    }
    out += chunk;
  }
  return out;
}

/** Создаёт или обновляет свой комментарий роли (маркер в теле) вместо нового на каждый прогон. */
export async function upsertNote(gitlab, project, iid, role, body) {
  const marker = NOTE_MARKER(role);
  const notes = await gitlab.getNotes(project, iid);
  const mine = notes.find((n) => !n.system && String(n.body || '').includes(marker));
  const text = `${body}\n\n${marker}`;
  if (mine) {
    await gitlab.updateNote(project, iid, mine.id, text);
    return { id: mine.id, updated: true };
  }
  const created = await gitlab.createNote(project, iid, text);
  return { id: created?.id, updated: false };
}
