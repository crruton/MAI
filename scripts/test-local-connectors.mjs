/**
 * Локальные коннекторы (CW3.3, ADR 0072): карточки из проверок сервисов.
 */
import { localConnectors } from '../electron/lib/local-connectors.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`);
  }
}
const byId = (cards) => Object.fromEntries(cards.map((c) => [c.id, c]));

console.log('[1] ничего не настроено');
let cards = byId(localConnectors({ repowise: { installed: false }, multica: { available: false, error: 'CLI «multica» не найден в PATH' }, infra: { postgres: { ok: false, error: 'URL не задан' }, vault: { ok: false, error: 'Адрес не задан' }, seaweed: { ok: false, error: 'Адрес не задан' } } }));
check('пять карточек, все «Локальные»', Object.keys(cards).join() === 'repowise,multica,postgres,vault,seaweed' && Object.values(cards).every((c) => c.category === 'Локальные' && c.local));
check('всё «не настроено» с действием настройки', Object.values(cards).every((c) => c.status === 'missing' && c.action.kind === 'open'), JSON.stringify(Object.values(cards).map((c) => c.status)));
check('Repowise — установить во вкладке «Хранилища»', cards.repowise.action.target === 'storage:repowise' && cards.repowise.action.label === 'Установить');
check('Multica — панель', cards.multica.action.target === 'panel:multica' && /не найден/.test(cards.multica.detail));
check('хранилище — вкладка infra', cards.postgres.action.target === 'storage:infra');

console.log('[2] всё работает');
cards = byId(
  localConnectors({
    repowise: { installed: true, version: 'repowise 1.2' },
    repowiseEnabled: true,
    multica: { available: true, version: 'multica 0.5' },
    infra: { postgres: { ok: true, version: 'PostgreSQL 16.2', pgvector: '0.7.0' }, vault: { ok: true, version: '1.15' }, seaweed: { ok: true } },
    config: { postgresUrl: 'postgres://x', vaultAddr: 'http://v', seaweedUrl: 'http://s' },
  }),
);
check('все «работает»', Object.values(cards).every((c) => c.status === 'ready'), JSON.stringify(Object.values(cards).map((c) => c.status)));
check('Repowise включён — кнопка «Выключить» и «Индекс»', cards.repowise.action.kind === 'toggle' && cards.repowise.action.enabled === true && cards.repowise.action.label === 'Выключить' && cards.repowise.extra?.target === 'storage:repowise');
check('версии в подробностях', cards.postgres.detail === 'PostgreSQL 16.2' && cards.multica.detail === 'multica 0.5');

console.log('[3] частично');
cards = byId(
  localConnectors({
    repowise: { installed: true },
    repowiseEnabled: false,
    multica: { available: true, error: 'не отвечает' },
    infra: { postgres: { ok: true, version: 'PostgreSQL 16', pgvector: null }, vault: { ok: false, error: 'Vault запечатан' }, seaweed: { ok: false, error: 'ECONNREFUSED' } },
    config: { postgresUrl: 'postgres://x', vaultAddr: 'http://v', seaweedUrl: 'http://s' },
  }),
);
check('Repowise выключен — «Включить»', cards.repowise.status === 'off' && cards.repowise.action.label === 'Включить' && cards.repowise.action.enabled === false);
check('Postgres без pgvector — отмечено', cards.postgres.status === 'ready' && /без pgvector/.test(cards.postgres.detail), cards.postgres.detail);
check('Vault и SeaweedFS — «не отвечает» с причиной', cards.vault.status === 'error' && /запечатан/.test(cards.vault.detail) && cards.seaweed.status === 'error' && /ECONNREFUSED/.test(cards.seaweed.detail));
check('Multica с ошибкой — error', cards.multica.status === 'error');
check('проверка не успела (null) — «не настроено», без падения', localConnectors({ repowise: null, multica: null, infra: null }).length === 5);

console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
