/**
 * Шифрование секретов в settings.json (ADR 0031), без Electron: фейковый шифр.
 */
import { createSecretBox, sealSettings, openSettings, keepUnreadable, plaintextSecrets, isSealed } from '../electron/lib/secrets.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// Обратимый «шифр» для теста: переворот байтов.
const fake = (ok = true) => ({
  available: () => ok,
  encrypt: (text) => Buffer.from(text, 'utf8').reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString('utf8'),
});
const box = createSecretBox(fake());

const settings = {
  providers: { mai: { apiKey: 'sk-mai-123', baseURL: 'x' }, empty: { apiKey: '' }, agentrouter: { apiKey: 'sk-ar-456' } },
  infra: { vaultToken: 'hvs.token' },
  mas: { token: 'mas-token' },
  temperature: 0.3,
};

console.log('\n[1] Запись на диск');
const sealed = sealSettings(settings, box);
check('ключ MAI зашифрован', isSealed(sealed.providers.mai.apiKey));
check('ключ AgentRouter зашифрован', isSealed(sealed.providers.agentrouter.apiKey));
check('токен Vault зашифрован', isSealed(sealed.infra.vaultToken));
check('токен MAS зашифрован', isSealed(sealed.mas.token));
check('пустой ключ остался пустым', sealed.providers.empty.apiKey === '');
check('в JSON нет открытых ключей', !/sk-mai|sk-ar|hvs\.token|mas-token/.test(JSON.stringify(sealed)));
check('остальные поля не тронуты', sealed.temperature === 0.3 && sealed.providers.mai.baseURL === 'x');
check('исходный объект не изменён', settings.providers.mai.apiKey === 'sk-mai-123');
check('повторное шифрование не двойное', sealSettings(sealed, box).providers.mai.apiKey === sealed.providers.mai.apiKey);
check('маска *** не шифруется', box.seal('***') === '***');
check('после записи открытых секретов нет', plaintextSecrets(sealed).length === 0);
check('до записи — 4 открытых секрета', plaintextSecrets(settings).length === 4, JSON.stringify(plaintextSecrets(settings)));

console.log('\n[2] Чтение');
const opened = openSettings(sealed, box);
check('ключ расшифрован', opened.settings.providers.mai.apiKey === 'sk-mai-123');
check('токены расшифрованы', opened.settings.infra.vaultToken === 'hvs.token' && opened.settings.mas.token === 'mas-token');
check('нечитаемых нет', opened.unreadable.length === 0);
check('открытый текст старого формата читается как есть', openSettings(settings, box).settings.providers.mai.apiKey === 'sk-mai-123');

console.log('\n[3] Хранилище ОС недоступно или сменилось');
const none = createSecretBox(fake(false));
check('без хранилища — открытый текст (и это видно)', none.seal('sk-x') === 'sk-x' && none.protection() === 'none');
const broken = createSecretBox({ available: () => true, encrypt: (t) => Buffer.from(t), decrypt: () => { throw new Error('другой пользователь ОС'); } });
const unreadable = openSettings(sealed, broken);
check('нерасшифрованный ключ — пусто, путь записан', unreadable.settings.providers.mai.apiKey === '' && unreadable.unreadable.includes('providers.mai.apiKey'), JSON.stringify(unreadable.unreadable));
const resealed = keepUnreadable(sealSettings(unreadable.settings, broken), sealed, unreadable.unreadable);
check('при сохранении ключ на диске не затёрт', resealed.providers.mai.apiKey === sealed.providers.mai.apiKey);
const replaced = keepUnreadable(sealSettings({ ...unreadable.settings, providers: { ...unreadable.settings.providers, mai: { apiKey: 'sk-new' } } }, broken), sealed, unreadable.unreadable);
check('новый ключ, введённый пользователем, сохраняется', replaced.providers.mai.apiKey !== sealed.providers.mai.apiKey);
check('weak распознан', createSecretBox({ ...fake(), weak: () => true }).protection() === 'weak');

// Каналы уведомлений (CW5.4): токены ботов и адреса webhook — шифруются.
const chans = sealSettings({ notifications: { channels: [{ id: 'tg', type: 'telegram', token: '123:ABC', chatId: '-1' }, { id: 'rc', type: 'rocketchat', url: 'https://rc/hooks/secret' }] } }, box);
check('токен бота и адрес webhook на диске зашифрованы, chat_id — нет', isSealed(chans.notifications.channels[0].token) && isSealed(chans.notifications.channels[1].url) && chans.notifications.channels[0].chatId === '-1');
check('и расшифровываются обратно', openSettings(chans, box).settings.notifications.channels[0].token === '123:ABC');
console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
