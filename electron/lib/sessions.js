/**
 * Чаты в папке данных приложения. Само хранилище — session-store.js
 * (без Electron, проверяется обычным node).
 */
import { dataDir } from './config.js';
import { createSessionStore } from './session-store.js';

let store = null;
function current() {
  store ||= createSessionStore(dataDir());
  return store;
}

export const listSessions = (options) => current().listSessions(options);
export const getSession = (id) => current().getSession(id);
export const createSession = (data) => current().createSession(data);
export const setSessionMode = (id, mode) => current().setSessionMode(id, mode);
export const setSessionDirs = (id, dirs) => current().setSessionDirs(id, dirs);
export const setSessionKind = (id, kind) => current().setSessionKind(id, kind);
export const saveSession = (session) => current().saveSession(session);
export const addSessionRules = (id, kind, rules) => current().addSessionRules(id, kind, rules);
export const removeSessionRules = (id, rules) => current().removeSessionRules(id, rules);
export const deleteSession = (id) => current().deleteSession(id);
