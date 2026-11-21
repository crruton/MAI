/**
 * Шифрование ключей настоящим safeStorage (ADR 0031).
 * Запуск: npx electron scripts/test-secrets-electron.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-secrets-'));
app.setPath('userData', sandbox);

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

app.whenReady().then(async () => {
  try {
    const { loadSettings, saveSettings, migrateSecrets, publicSettings, settingsPath } = await import('../electron/lib/config.js');
    const file = settingsPath();
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { mai: { name: 'MAI', baseURL: 'https://x/v1', apiKey: 'sk-plain-0123456789', models: [{ id: 'm', vision: true }] } }, infra: { vaultToken: 'hvs.plain' } }),
      'utf8',
    );
    console.log(`  хранилище: available=${safeStorage.isEncryptionAvailable()} backend=${safeStorage.getSelectedStorageBackend?.() || 'n/a'}`);
    // В CI и контейнере нет keyring. Чтобы проверить сам путь шифрования, тест
    // включает слабый шифр Linux (basic_text); приложение этого не делает.
    const forcedWeak = !safeStorage.isEncryptionAvailable() && process.platform === 'linux';
    if (forcedWeak) safeStorage.setUsePlainTextEncryption(true);

    console.log('\n[1] Перенос открытых ключей старого формата');
    const result = migrateSecrets();
    const raw = fs.readFileSync(file, 'utf8');
    if (safeStorage.isEncryptionAvailable()) {
      check('секреты зашифрованы', result.migrated === 2, JSON.stringify(result));
      check('в файле нет ключа', !raw.includes('sk-plain') && !raw.includes('hvs.plain'));
      check('в файле формат enc:v1', raw.includes('enc:v1:'));
    } else {
      check('без хранилища ключ остался и это видно', result.protection === 'none' && raw.includes('sk-plain'));
    }

    console.log('\n[2] Чтение и запись');
    const settings = loadSettings();
    check('ключ расшифрован в памяти', settings.providers.mai.apiKey === 'sk-plain-0123456789');
    check('флаг vision у модели сохранён', settings.providers.mai.models[0].vision === true);
    saveSettings({ temperature: 0.5 });
    const after = fs.readFileSync(file, 'utf8');
    check('после сохранения ключ на диске не открыт', !safeStorage.isEncryptionAvailable() || !after.includes('sk-plain'));
    check('после сохранения ключ читается', loadSettings().providers.mai.apiKey === 'sk-plain-0123456789');
    saveSettings({ providers: { mai: { name: 'MAI', baseURL: 'https://x/v1', apiKey: '***' } } });
    check('*** из окна не затирает ключ', loadSettings().providers.mai.apiKey === 'sk-plain-0123456789');

    console.log('\n[3] Наружу');
    const pub = publicSettings();
    check('в окно ключ не отдаётся', pub.providers.mai.apiKey === '***' && !JSON.stringify(pub).includes('sk-plain-0123'));
    check('уровень защиты виден', ['os', 'weak', 'none'].includes(pub.secretsProtection), pub.secretsProtection);
    if (forcedWeak) check('шифр без ключа ОС помечен weak', pub.secretsProtection === 'weak', pub.secretsProtection);
    if (process.platform === 'win32') check('Windows: ключи защищены DPAPI (уровень os)', pub.secretsProtection === 'os', pub.secretsProtection);
    console.log(`  защита: ${pub.secretsProtection}`);

    console.log('\n[4] Токены MCP-серверов (ADR 0052)');
    saveSettings({ mcpServers: { github: { url: 'https://api.example/mcp', headers: { Authorization: 'Bearer ghp_TOKEN123' }, connector: 'github' }, local: { command: 'node', env: { API_TOKEN: 'env-secret-1' } } } });
    const onDisk = fs.readFileSync(file, 'utf8');
    check('заголовок и env MCP на диске не открыты', !safeStorage.isEncryptionAvailable() || (!onDisk.includes('ghp_TOKEN123') && !onDisk.includes('env-secret-1')));
    check('для main — расшифрованы', loadSettings().mcpServers.github.headers.Authorization === 'Bearer ghp_TOKEN123' && loadSettings().mcpServers.local.env.API_TOKEN === 'env-secret-1');
    const pub2 = publicSettings();
    check('в окно — только ***', pub2.mcpServers.github.headers.Authorization === '***' && pub2.mcpServers.local.env.API_TOKEN === '***' && !JSON.stringify(pub2).includes('ghp_TOKEN123'));
    // Окно сохраняет список серверов целиком, со звёздочками и новым сервером.
    saveSettings({ mcpServers: { ...pub2.mcpServers, extra: { url: 'https://extra.example/mcp' } } });
    check('*** из окна не затирает токены MCP', loadSettings().mcpServers.github.headers.Authorization === 'Bearer ghp_TOKEN123' && loadSettings().mcpServers.local.env.API_TOKEN === 'env-secret-1' && loadSettings().mcpServers.extra.url === 'https://extra.example/mcp');
  } catch (err) {
    fail += 1;
    console.log(`  FAIL исключение: ${err?.stack || err}`);
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* кеш Electron */
  }
  console.log(`\nИтог: ${pass} OK, ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
