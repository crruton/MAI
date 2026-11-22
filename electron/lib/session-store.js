/**
 * Хранилище чатов (бэклог A3.7, ADR 0034): файл на сессию и индекс.
 *
 *   <данные>/sessions/index.json   — список: id, заголовок, проект, даты, число запросов
 *   <данные>/sessions/<id>.json    — сессия целиком
 *
 * Раньше все чаты лежали в одном sessions.json, и каждое сохранение шага
 * переписывало все чаты сразу. Старый файл переносится один раз и
 * переименовывается в sessions.json.migrated — данные не удаляются.
 *
 * Запись атомарная: временный файл + rename.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Поля, которые меняются только своими функциями (setSessionMode,
 * addSessionRules). Прогон агента держит копию сессии со старыми значениями,
 * и без этого финальный saveSession откатил бы режим, выбранный посреди прогона.
 */
const OWNED_FIELDS = ['permissionMode', 'permissionRules', 'extraDirs', 'kind', 'run'];

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeId(id) {
  return String(id || '').replace(/[^\w.-]/g, '_');
}

function metaOf(session) {
  return {
    id: session.id,
    title: session.title,
    model: session.model,
    projectDir: session.projectDir || '',
    permissionMode: session.permissionMode || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    count: Array.isArray(session.messages) ? session.messages.filter((m) => m.role === 'user').length : 0,
    // Состояние прогона (CW5.2): running | done | error | stopped | interrupted.
    run: session.run?.status || '',
  };
}

/** Хранилище в папке `root` (в приложении — папка данных). Отдельная функция — для тестов. */
export function createSessionStore(root) {
  const dir = path.join(root, 'sessions');
  const indexFile = path.join(dir, 'index.json');
  const fileOf = (id) => path.join(dir, `${safeId(id)}.json`);
  let migrated = false;

  function migrate() {
    if (migrated) return;
    migrated = true;
    const legacy = path.join(root, 'sessions.json');
    if (!fs.existsSync(legacy) || fs.existsSync(indexFile)) return;
    const all = readJson(legacy, []);
    const index = [];
    for (const session of Array.isArray(all) ? all : []) {
      if (!session?.id) continue;
      writeJson(fileOf(session.id), session);
      index.push(metaOf(session));
    }
    writeJson(indexFile, index);
    fs.renameSync(legacy, `${legacy}.migrated`);
  }

  function readIndex() {
    migrate();
    const index = readJson(indexFile, []);
    return Array.isArray(index) ? index : [];
  }

  function updateIndex(meta, { remove = false } = {}) {
    const index = readIndex().filter((m) => m.id !== meta.id);
    if (!remove) index.push(meta);
    writeJson(indexFile, index);
  }

  function getSession(id) {
    migrate();
    if (!id) return null;
    const session = readJson(fileOf(id), null);
    return session?.id === id ? session : null;
  }

  function write(session) {
    writeJson(fileOf(session.id), session);
    updateIndex(metaOf(session));
    return session;
  }

  return {
    /**
     * Список чатов, новые первыми. `projectDir` — только чаты этой папки (CC6.6),
     * `query` — поиск по заголовку и тексту сообщений (CC6.7).
     */
    listSessions({ projectDir = '', query = '' } = {}) {
      let list = readIndex();
      if (projectDir) {
        const key = path.resolve(projectDir);
        list = list.filter((m) => m.projectDir && path.resolve(m.projectDir) === key);
      }
      const q = String(query || '').trim().toLowerCase();
      if (q) {
        list = list
          .map((meta) => {
            if (String(meta.title || '').toLowerCase().includes(q)) return { ...meta, match: '' };
            const session = getSession(meta.id);
            const hit = (session?.messages || []).find(
              (m) => (m.role === 'user' || m.role === 'assistant') && String(m.display || m.content || '').toLowerCase().includes(q),
            );
            if (!hit) return null;
            const text = String(hit.display || hit.content || '');
            const at = text.toLowerCase().indexOf(q);
            return { ...meta, match: text.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\s+/g, ' ') };
          })
          .filter(Boolean);
      }
      return list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },

    getSession,

    createSession({ title, model, projectDir, permissionMode, kind }) {
      const now = new Date().toISOString();
      return write({
        id: crypto.randomUUID(),
        title: title || 'Новый чат',
        model: model || '',
        projectDir: projectDir || '',
        // Пустой режим — «взять значение по умолчанию из настроек».
        permissionMode: permissionMode || '',
        permissionRules: { allow: [], ask: [], deny: [] },
        kind: kind === 'task' ? 'task' : 'code',
        createdAt: now,
        updatedAt: now,
        messages: [],
      });
    },

    setSessionMode(id, mode) {
      const session = getSession(id);
      if (!session) return null;
      session.permissionMode = mode || '';
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    /** Состояние прогона чата (CW5.2, ADR 0051). */
    setSessionRun(id, run) {
      const session = getSession(id);
      if (!session) return null;
      session.run = run ? { ...run } : null;
      return write(session);
    },

    /**
     * После запуска приложения: прогоны со статусом running не могли пережить
     * закрытие — помечаются interrupted. Возвращает их id.
     */
    markInterrupted() {
      const ids = readIndex().filter((m) => m.run === 'running').map((m) => m.id);
      for (const id of ids) {
        const session = getSession(id);
        if (session?.run?.status === 'running') {
          session.run = { ...session.run, status: 'interrupted', endedAt: new Date().toISOString() };
          write(session);
        }
      }
      return ids;
    },

    /** Вид чата: code | task (CW1.1, ADR 0046). */
    setSessionKind(id, kind) {
      const session = getSession(id);
      if (!session) return null;
      session.kind = kind === 'task' ? 'task' : 'code';
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    /** Дополнительные рабочие папки чата (CW1.2, ADR 0045). */
    setSessionDirs(id, dirs) {
      const session = getSession(id);
      if (!session) return null;
      session.extraDirs = [...new Set((dirs || []).map(String).filter(Boolean))].slice(0, 20);
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    saveSession(session) {
      const stored = getSession(session.id);
      session.updatedAt = new Date().toISOString();
      if (stored) {
        for (const field of OWNED_FIELDS) {
          if (stored[field] !== undefined) session[field] = stored[field];
        }
        // Имя, данное пользователем во время прогона (CC6.8), не затирается копией в main.
        if (stored.titleManual) {
          session.title = stored.title;
          session.titleManual = true;
        }
      }
      return write(session);
    },

    addSessionRules(id, kind, rules) {
      const session = getSession(id);
      if (!session) return null;
      const key = ['allow', 'ask', 'deny'].includes(kind) ? kind : 'allow';
      session.permissionRules ||= { allow: [], ask: [], deny: [] };
      session.permissionRules[key] ||= [];
      for (const rule of rules || []) {
        if (rule && !session.permissionRules[key].includes(rule)) session.permissionRules[key].push(rule);
      }
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    removeSessionRules(id, rules) {
      const session = getSession(id);
      if (!session?.permissionRules) return session || null;
      const drop = new Set(rules || []);
      for (const key of ['allow', 'ask', 'deny']) {
        session.permissionRules[key] = (session.permissionRules[key] || []).filter((rule) => !drop.has(rule));
      }
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    deleteSession(id) {
      fs.rmSync(fileOf(id), { force: true });
      updateIndex({ id }, { remove: true });
      return true;
    },

    /**
     * Переименование (CC6.8). `auto` — заголовок от модели: не трогает чат,
     * который пользователь уже назвал сам.
     */
    renameSession(id, title, { auto = false } = {}) {
      const session = getSession(id);
      const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!session || !clean) return null;
      if (auto && session.titleManual) return session;
      session.title = clean;
      if (!auto) session.titleManual = true;
      session.updatedAt = new Date().toISOString();
      return write(session);
    },

    /**
     * Форк (CC6.5): новый чат с той же историей (или до сообщения `upTo`
     * не включительно), режимом, папками и видом. Состояние прогона и
     * разрешения «на сессию» не копируются; чекпоинты остаются у исходного.
     */
    forkSession(id, { upTo = null } = {}) {
      const source = getSession(id);
      if (!source) return null;
      const now = new Date().toISOString();
      const messages = (source.messages || []).slice(0, Number.isInteger(upTo) && upTo >= 0 ? upTo : undefined);
      return write({
        id: crypto.randomUUID(),
        title: `${String(source.title || 'Чат').slice(0, 70)} (копия)`,
        model: source.model || '',
        projectDir: source.projectDir || '',
        permissionMode: source.permissionMode || '',
        permissionRules: { allow: [], ask: [], deny: [] },
        kind: source.kind === 'task' ? 'task' : 'code',
        ...(Array.isArray(source.extraDirs) ? { extraDirs: [...source.extraDirs] } : {}),
        forkedFrom: { id: source.id, at: now, messages: messages.length },
        createdAt: now,
        updatedAt: now,
        messages: JSON.parse(JSON.stringify(messages)),
      });
    },

    /**
     * Импорт (CC6.9) из файла экспорта: всегда новый id, только известные поля,
     * сообщения — роли user/assistant/tool/system с текстом.
     */
    importSession(data) {
      const raw = data?.session || data;
      if (!raw || !Array.isArray(raw.messages)) throw new Error('В файле нет чата MAI (нет messages)');
      const roles = new Set(['user', 'assistant', 'tool', 'system']);
      const messages = raw.messages
        .filter((m) => m && roles.has(m.role))
        .map((m) => {
          const out = { role: m.role, content: typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content) };
          for (const key of ['display', 'name', 'tool_call_id']) if (typeof m[key] === 'string') out[key] = m[key];
          if (Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls;
          return out;
        });
      const now = new Date().toISOString();
      return write({
        id: crypto.randomUUID(),
        title: `${String(raw.title || 'Импорт').slice(0, 70)}`,
        model: String(raw.model || ''),
        projectDir: String(raw.projectDir || ''),
        permissionMode: '',
        permissionRules: { allow: [], ask: [], deny: [] },
        kind: raw.kind === 'task' ? 'task' : 'code',
        importedAt: now,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
        updatedAt: now,
        messages,
      });
    },

    /** Чаты, которые не менялись дольше `days` дней (CC6.9); идущие — не трогаем. */
    expiredSessions(days, now = Date.now()) {
      const limit = Number(days);
      if (!Number.isFinite(limit) || limit <= 0) return [];
      const edge = now - limit * 24 * 60 * 60 * 1000;
      return readIndex()
        .filter((m) => m.run !== 'running' && Date.parse(m.updatedAt || m.createdAt || '') < edge)
        .map((m) => m.id);
    },
  };
}

