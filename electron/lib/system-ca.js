import tls from 'node:tls';

/**
 * Системные корневые сертификаты (F25, ADR 0095).
 *
 * Корпоративный корневой сертификат Windows нужен для api-ai.mai.ru. Раньше
 * приложение перезапускало себя с NODE_OPTIONS=--use-system-ca, но в собранном
 * Electron NODE_OPTIONS игнорируется — установленный EXE сертификаты ОС не видел
 * (нашла самопроверка). Теперь — прямо в процессе: встроенные + системные
 * корни по умолчанию для https, fetch и всего, что идёт через tls.
 *
 * Возвращает число корней или 0, если API нет (старый Electron — тогда запасной
 * путь с перезапуском).
 */
export function applySystemCa(api = tls) {
  try {
    if (typeof api.setDefaultCACertificates !== 'function' || typeof api.getCACertificates !== 'function') return 0;
    const merged = [...new Set([...api.getCACertificates('default'), ...api.getCACertificates('system')])];
    api.setDefaultCACertificates(merged);
    return merged.length;
  } catch {
    return 0;
  }
}
