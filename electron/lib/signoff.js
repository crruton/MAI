import fs from 'node:fs';
import path from 'node:path';

/**
 * Signoff (N1, ADR 0097) — по мотивам basecamp/gh-signoff: «тесты проходят у
 * меня» → статус коммита `signoff` (или `signoff/<контекст>`) на HEAD в GitHub.
 * Только статусы: правила ветки (ruleset) MAI не меняет (решение гриллинга).
 *
 * Модуль не зависит от Electron: git, тесты и GitHub передаёт вызывающий:
 *   git(args) → { code, stdout }      exec(command) → { code, output, ms }
 *   post({ owner, repo, sha, state, context, description, targetUrl }) → { ok, error }
 */

const CONTEXT_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

/** Имя статуса: signoff или signoff/<контекст>. */
export function statusContext(context = '') {
  const c = String(context || '').trim();
  if (!c) return 'signoff';
  if (!CONTEXT_RE.test(c)) throw new Error(`Контекст «${c}»: латиница, цифры, «.», «_», «-», до 40 символов`);
  return `signoff/${c}`;
}

/** Аргументы команды: «fail», «ci», «fail lint» → { fail, context }. */
export function parseSignoffArgs(text = '') {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const fail = parts[0]?.toLowerCase() === 'fail';
  return { fail, context: (fail ? parts[1] : parts[0]) || '' };
}

/** origin → { owner, repo } для github.com (https и ssh) или null. */
export function parseGithubRemote(url = '') {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Команда тестов: signoff.testCommand, иначе scripts.test из package.json → npm test. */
export function testCommandFor(projectDir, settings = {}) {
  const own = String(settings.signoff?.testCommand || '').trim();
  if (own) return own;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test';
  } catch {
    /* нет package.json */
  }
  return '';
}

/** Ссылка Details: шаблон signoff.detailsUrl с {sha} {owner} {repo} {context}. */
export function detailsUrl(template, vars) {
  const t = String(template || '').trim();
  if (!t) return '';
  const url = t.replace(/\{(sha|owner|repo|context)\}/g, (_, k) => encodeURIComponent(vars[k] || ''));
  return /^https?:\/\//i.test(url) ? url : '';
}

/** Состояние репозитория: HEAD, чистота, запушен ли, GitHub-репозиторий. */
export function gitState(git) {
  const head = git(['rev-parse', 'HEAD']);
  if (head.code !== 0) return { ok: false, error: 'Это не git-репозиторий или в нём нет коммитов' };
  const sha = head.stdout.trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout.trim();
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remoteName = upstream.code === 0 ? upstream.stdout.trim().split('/')[0] : 'origin';
  const remote = git(['remote', 'get-url', remoteName]);
  const gh = remote.code === 0 ? parseGithubRemote(remote.stdout) : null;
  const contains = git(['branch', '-r', '--contains', sha]);
  const pushed = contains.code === 0 && contains.stdout.trim().length > 0;
  return { ok: true, sha, dirty: Boolean(dirty), upstream: upstream.code === 0 ? upstream.stdout.trim() : '', pushed, github: gh, remoteName };
}

/**
 * Подписать HEAD. Порядок: git (HEAD запушен, нет незакоммиченных правок,
 * GitHub) → тесты (кроме fail) → статус. Возвращает { ok, state, context, sha, log, error }.
 */
export async function runSignoff({ projectDir, context = '', fail = false, settings = {}, git, exec, post, onLog = () => {} }) {
  const log = [];
  const say = (line) => {
    log.push(line);
    onLog(line);
  };
  const done = (extra) => ({ log, ...extra });
  let name;
  try {
    name = statusContext(context);
  } catch (err) {
    return done({ ok: false, error: err.message });
  }
  const st = gitState(git);
  if (!st.ok) return done({ ok: false, error: st.error });
  const short = st.sha.slice(0, 7);
  say(`HEAD ${short}${st.upstream ? ` (${st.upstream})` : ''}`);
  if (!st.github) return done({ ok: false, sha: st.sha, error: `Удалённый репозиторий «${st.remoteName}» — не GitHub: статусу некуда уйти` });
  if (!st.pushed) return done({ ok: false, sha: st.sha, error: `Коммит ${short} не запушен — сначала git push: статус ставится на коммит в GitHub` });
  if (st.dirty && !fail) return done({ ok: false, sha: st.sha, error: 'Есть незакоммиченные изменения: тесты проверили бы не то, что в HEAD. Закоммитьте или спрячьте (git stash)' });

  let description;
  let state;
  if (fail) {
    state = 'failure';
    description = 'Отклонено вручную в MAI Code';
    say('Тесты не запускаются: отметка «fail»');
  } else {
    const command = testCommandFor(projectDir, settings);
    if (!command) return done({ ok: false, sha: st.sha, error: 'Не найдена команда тестов: нет scripts.test в package.json — задайте signoff.testCommand в настройках' });
    say(`Тесты: ${command}`);
    const res = await exec(command);
    const secs = Math.round((res.ms || 0) / 1000);
    if (res.code !== 0) {
      say(`Тесты не прошли (код ${res.code}, ${secs} с) — статус не ставится`);
      return done({ ok: false, sha: st.sha, testsFailed: true, output: String(res.output || '').slice(-4000), error: `Тесты не прошли (код ${res.code}) — signoff не поставлен` });
    }
    say(`Тесты прошли за ${secs} с`);
    state = 'success';
    description = `Тесты прошли локально: ${command} (${secs} с)`.slice(0, 140);
  }
  const targetUrl = detailsUrl(settings.signoff?.detailsUrl, { sha: st.sha, owner: st.github.owner, repo: st.github.repo, context: name });
  const res = await post({ owner: st.github.owner, repo: st.github.repo, sha: st.sha, state, context: name, description, targetUrl });
  if (!res?.ok) return done({ ok: false, sha: st.sha, error: `GitHub не принял статус: ${res?.error || 'нет ответа'}` });
  say(`Статус ${name} = ${state} на ${st.github.owner}/${st.github.repo}@${short}`);
  return done({ ok: true, state, context: name, sha: st.sha, repo: `${st.github.owner}/${st.github.repo}` });
}
