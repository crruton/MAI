/**
 * Сессия Keycloak и корпоративный режим (F21, ADR 0093).
 *
 * Корпоративный режим включает организация в managed-settings.json:
 *   { "auth": { "required": true, "issuer": "https://sso…/realms/mai", "clientId": "mai-code-desktop" } }
 * Тогда без входа доступен только экран входа, локальной роли нет, issuer и
 * clientId берутся из файла организации. Без этого блока — прежний локальный
 * режим интерфейса (решение D1).
 *
 * Модуль не зависит от Electron: хранение и сеть передаёт вызывающий.
 */

/** Блок auth из управляемых настроек → политика входа. */
export function corporatePolicy(managedRaw) {
  const a = managedRaw?.auth;
  if (!a || typeof a !== 'object' || a.required !== true) return { required: false, issuer: '', clientId: '' };
  return {
    required: true,
    issuer: String(a.issuer || '').replace(/\/+$/, ''),
    clientId: String(a.clientId || 'mai-code-desktop'),
  };
}

/** Токены с моментом получения: от него считаются сроки. */
export const stampTokens = (tokens, now = Date.now()) => (tokens ? { ...tokens, obtained_at: now } : null);

/**
 * Состояние токенов: none — нет; valid — access действует; refreshable — access
 * истёк (или истекает за 30 с), но refresh жив; expired — истекло всё.
 */
export function tokenState(tokens, now = Date.now()) {
  if (!tokens?.access_token) return 'none';
  const at = Number(tokens.obtained_at) || 0;
  // Токены без отметки времени (сохранены до F21) считаем действующими до первой проверки refresh.
  if (!at) return tokens.refresh_token ? 'refreshable' : 'valid';
  const accessUntil = at + (Number(tokens.expires_in) || 300) * 1000;
  if (now < accessUntil - 30_000) return 'valid';
  const refreshIn = Number(tokens.refresh_expires_in);
  // refresh_expires_in = 0 у Keycloak — offline-токен без срока.
  const refreshUntil = refreshIn === 0 ? Infinity : at + (refreshIn || 1800) * 1000;
  if (tokens.refresh_token && now < refreshUntil) return 'refreshable';
  return 'expired';
}

export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** Роль и пользователь из access token: admin, если роль admin в realm или клиенте. */
export function identityFromToken(accessToken, clientId) {
  const payload = decodeJwt(accessToken);
  const roles = new Set([...(payload.realm_access?.roles || []), ...(payload.resource_access?.[clientId]?.roles || [])]);
  return {
    role: roles.has('admin') ? 'admin' : 'guest',
    user: { name: payload.name || payload.preferred_username || payload.email || 'Пользователь Keycloak', email: payload.email || '', sub: payload.sub || '' },
  };
}

/**
 * Обновление по refresh_token. `post(url, params)` — POST формы, бросает с
 * `code` (invalid_grant и т.п.). Возвращает новые токены с отметкой времени.
 */
export async function refreshTokens({ issuer, clientId, tokens, post, now = () => Date.now() }) {
  if (!tokens?.refresh_token) throw Object.assign(new Error('Нет refresh_token — нужен новый вход'), { code: 'no_refresh' });
  const next = await post(`${issuer}/protocol/openid-connect/token`, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
  if (!next?.access_token) throw Object.assign(new Error('Keycloak не вернул access_token'), { code: 'bad_response' });
  // Keycloak может не прислать новый refresh_token — оставляем прежний.
  return stampTokens({ ...next, refresh_token: next.refresh_token || tokens.refresh_token }, now());
}

/** Каналы, доступные без входа в корпоративном режиме: только экран входа. */
export const LOGIN_CHANNELS = new Set(['auth:status', 'auth:login', 'auth:logout', 'app:clipboard', 'app:focusMain']);

/** Отказ гейта сессии: '' — можно, иначе текст. */
export function sessionGate(channel, { required, loggedIn }) {
  if (!required || loggedIn || LOGIN_CHANNELS.has(channel)) return '';
  return 'Нужен вход через Keycloak: в корпоративном режиме приложение работает только после входа';
}
