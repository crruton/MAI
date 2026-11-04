import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { shell, safeStorage } from 'electron';
import { dataDir } from './config.js';

/**
 * Роли и вход.
 *
 * Локальный режим: роль хранится в auth.json, по умолчанию admin.
 * Режим Keycloak: OIDC Device Authorization Grant, роли admin/guest берутся
 * из realm_access.roles и resource_access[clientId].roles.
 *
 * Важно: в локальном режиме это разграничение интерфейса, а не защита от
 * владельца машины. Настоящая граница появляется только в серверном режиме.
 */

const ROLES = new Set(['admin', 'guest']);

function authFile() {
  return path.join(dataDir(), 'auth.json');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(authFile(), 'utf8'));
  } catch {
    return null;
  }
}

function decryptTokens(value) {
  if (!value) return null;
  try {
    if (value.enc) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const raw = safeStorage.decryptString(Buffer.from(value.enc, 'base64'));
      return JSON.parse(raw);
    }
    if (value.plain) return JSON.parse(value.plain);
  } catch {
    return null;
  }
  return null;
}

function readAuth() {
  const raw = readRaw();
  const tokens = decryptTokens(raw?.tokens);
  return {
    mode: raw?.mode === 'keycloak' ? 'keycloak' : 'local',
    role: ROLES.has(raw?.role) ? raw.role : 'admin',
    user: raw?.user || { name: 'Локальный администратор' },
    issuer: raw?.issuer || '',
    clientId: raw?.clientId || 'mai-code-desktop',
    tokens,
  };
}

function writeAuth(data) {
  const next = {
    mode: data.mode === 'keycloak' ? 'keycloak' : 'local',
    role: ROLES.has(data.role) ? data.role : 'guest',
    user: data.user || null,
    issuer: data.issuer || '',
    clientId: data.clientId || 'mai-code-desktop',
  };
  if (data.tokens) {
    const raw = JSON.stringify(data.tokens);
    if (safeStorage.isEncryptionAvailable()) {
      next.tokens = { enc: safeStorage.encryptString(raw).toString('base64') };
    }
    // Без шифрования токены не сохраняем: роль останется, но сессия не продлится.
  }
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  fs.writeFileSync(authFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function authStatus() {
  const auth = readAuth();
  return {
    mode: auth.mode,
    role: auth.role,
    user: auth.user,
    issuer: auth.issuer,
    clientId: auth.clientId,
    loggedIn: Boolean(auth.tokens?.access_token),
    encryption: safeStorage.isEncryptionAvailable(),
    keycloakConfigured: Boolean(auth.issuer),
  };
}

export function requireAdmin() {
  const { role } = readAuth();
  if (role !== 'admin') throw new Error('Недостаточно прав: требуется роль admin');
  return true;
}

export function configureAuth({ issuer, clientId }) {
  const current = readAuth();
  const next = writeAuth({
    ...current,
    issuer: String(issuer || '').replace(/\/$/, ''),
    clientId: String(clientId || current.clientId || 'mai-code-desktop'),
  });
  return authStatus();
}

export function setLocalRole(role) {
  if (!ROLES.has(role)) throw new Error(`Неизвестная роль: ${role}`);
  const current = readAuth();
  if (current.mode === 'keycloak' && current.tokens) {
    throw new Error('Роль задаётся в Keycloak; сначала выйдите из аккаунта');
  }
  writeAuth({ ...current, mode: 'local', role, user: { name: role === 'admin' ? 'Локальный администратор' : 'Гость' } });
  return authStatus();
}

export function logout() {
  const current = readAuth();
  writeAuth({
    mode: 'local',
    role: 'admin',
    user: { name: 'Локальный администратор' },
    issuer: current.issuer,
    clientId: current.clientId,
    tokens: null,
  });
  return authStatus();
}

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
    err.code = data.error || `http_${res.status}`;
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Device Authorization Grant + PKCE (S256). Клиент в realm включает
// pkce.code.challenge.method=S256, поэтому Keycloak требует code_challenge
// уже на шаге device, а code_verifier — при обмене device_code на токен.
function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function loginKeycloak() {
  const auth = readAuth();
  if (!auth.issuer) throw new Error('Сначала укажите issuer Keycloak, например http://localhost:8080/realms/mai-code');

  const base = auth.issuer.replace(/\/$/, '');
  const clientId = auth.clientId || 'mai-code-desktop';
  const pkce = createPkce();

  const device = await postForm(`${base}/protocol/openid-connect/auth/device`, {
    client_id: clientId,
    scope: 'openid profile email',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });

  const url = device.verification_uri_complete || device.verification_uri;
  if (url) await shell.openExternal(url);

  const deadline = Date.now() + Math.min(Number(device.expires_in) || 300, 300) * 1000;
  let interval = Math.max(2, Number(device.interval) || 5) * 1000;
  let token = null;

  while (Date.now() < deadline) {
    await sleep(interval);
    try {
      token = await postForm(`${base}/protocol/openid-connect/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: clientId,
        code_verifier: pkce.verifier,
      });
      break;
    } catch (err) {
      if (err.code === 'authorization_pending') continue;
      if (err.code === 'slow_down') {
        interval += 2000;
        continue;
      }
      throw err;
    }
  }

  if (!token?.access_token) throw new Error('Keycloak не подтвердил вход за отведённое время');

  const payload = decodeJwt(token.access_token);
  const roles = new Set([
    ...(payload.realm_access?.roles || []),
    ...(payload.resource_access?.[clientId]?.roles || []),
  ]);
  const role = roles.has('admin') ? 'admin' : 'guest';

  writeAuth({
    mode: 'keycloak',
    role,
    user: {
      name: payload.name || payload.preferred_username || payload.email || 'Пользователь Keycloak',
      email: payload.email || '',
      sub: payload.sub || '',
    },
    issuer: base,
    clientId,
    tokens: token,
  });

  return {
    ...authStatus(),
    verificationUri: device.verification_uri,
    userCode: device.user_code,
  };
}
