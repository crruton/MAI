/**
 * Границы данных (N2, ADR 0098) — по мотивам data-boundary scan OpenJarvis:
 * отчёт «куда уходят данные» по настройкам и подключениям.
 *
 * Уровни: fail — содержимое чатов уходит наружу (облачная модель чата, запасной
 * или ревизора, плановые задачи на облачной модели); warn — включено то, что
 * может отправить данные наружу (телеметрия, удалённые MCP и коннекторы, веб,
 * браузер, уведомления в мессенджеры, голос через провайдера, внешние рантаймы);
 * info — локальные сервисы. Чек-лист «строго локально» — по пунктам.
 *
 * Модуль не зависит от Electron.
 */

/** Адрес на этой машине или в частной сети? */
export function isLocalUrl(url = '') {
  let host = '';
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === 'host.docker.internal') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

const hostOf = (url) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url || '');
  }
};

/** Провайдер модели по ключу «провайдер/модель» (без префикса — mai). */
function providerFor(settings, key) {
  const value = String(key || '');
  if (!value) return null;
  const id = value.includes('/') ? value.slice(0, value.indexOf('/')) : 'mai';
  const p = settings.providers?.[id];
  return p ? { id, name: p.name || id, baseURL: p.baseURL || '', local: isLocalUrl(p.baseURL) } : { id, name: id, baseURL: '', local: false };
}

/**
 * Отчёт. `state` — то, чего нет в настройках: { mcp: [{name, transport, url}],
 * connectors: [{name, connected}], schedules: [{title, model, enabled}] }.
 */
export function dataBoundaryReport(settings = {}, state = {}) {
  const findings = [];
  const checklist = [];
  const add = (level, area, title, detail, fix = '') => findings.push({ level, area, title, detail, fix });
  const item = (label, ok, detail = '') => checklist.push({ label, ok: Boolean(ok), detail });

  // Модели: содержимое чатов.
  const models = [
    ['чата', settings.activeModel],
    ['запасная', settings.fallbackModel],
    ...(settings.reviewer?.enabled ? [['ревизора', settings.reviewer.model || settings.activeModel]] : []),
  ].filter(([, k]) => k);
  let modelsLocal = true;
  for (const [role, key] of models) {
    const p = providerFor(settings, key);
    if (p.local) add('info', 'Модели', `Модель ${role} — локально`, `${key} → ${hostOf(p.baseURL)}`);
    else {
      modelsLocal = false;
      add('fail', 'Модели', `Модель ${role} — облако: ${p.name}`, `Запросы, файлы в контексте и результаты инструментов уходят на ${hostOf(p.baseURL) || p.name} (${key})`, 'Выберите локальную модель (Ollama, LM Studio, colibri) или примите, что провайдер видит данные чатов');
    }
  }
  item('модели чата, запасная и ревизор — локальные', modelsLocal && models.length > 0, models.map(([r, k]) => `${r}: ${k}`).join('; ') || 'модель не выбрана');

  const schedules = (state.schedules || []).filter((s) => s.enabled !== false);
  const cloudSchedules = schedules.filter((s) => !providerFor(settings, s.model || settings.activeModel)?.local);
  if (cloudSchedules.length) add('fail', 'Плановые задачи', `Плановые задачи на облачной модели: ${cloudSchedules.length}`, `Запускаются без вас и отправляют данные проекта: ${cloudSchedules.map((s) => s.title).slice(0, 5).join(', ')}`, 'Переведите задачи на локальную модель или выключите');
  item('плановые задачи — только на локальной модели', cloudSchedules.length === 0, `${schedules.length} включено`);

  // Телеметрия.
  const tel = settings.telemetry || {};
  if (tel.enabled && tel.endpoint && !isLocalUrl(tel.endpoint)) add('warn', 'Телеметрия', 'Телеметрия уходит наружу', `Спаны, логи и метрики (без аргументов инструментов, секреты маскируются) → ${hostOf(tel.endpoint)}`, 'Укажите локальный коллектор или выключите');
  else if (tel.enabled) add('info', 'Телеметрия', 'Телеметрия — локальный коллектор', hostOf(tel.endpoint));
  item('телеметрия выключена или локальная', !(tel.enabled && tel.endpoint && !isLocalUrl(tel.endpoint)));

  // MCP и коннекторы.
  const remoteMcp = (state.mcp || []).filter((m) => m.url && !isLocalUrl(m.url));
  for (const m of remoteMcp) add('warn', 'MCP', `Удалённый MCP-сервер «${m.name}»`, `Аргументы вызовов и ответы идут на ${hostOf(m.url)}`, 'Отключите сервер или замените локальным');
  const localMcp = (state.mcp || []).filter((m) => !m.url || isLocalUrl(m.url));
  if (localMcp.length) add('info', 'MCP', `Локальные MCP-серверы: ${localMcp.length}`, localMcp.map((m) => m.name).join(', '));
  item('MCP — только локальные процессы и адреса', remoteMcp.length === 0, `${remoteMcp.length} удалённых`);
  const connected = (state.connectors || []).filter((c) => c.connected);
  if (connected.length) add('warn', 'Коннекторы', `Подключены коннекторы: ${connected.map((c) => c.name).join(', ')}`, 'Агент читает и (после подтверждения) пишет в эти сервисы', 'Отключите ненужные в «Коннекторы»');
  item('облачные коннекторы не подключены', connected.length === 0);

  // Веб и браузер.
  if (settings.webTools !== false) {
    const ws = settings.webSearch || {};
    const search = ws.provider === 'searxng' && isLocalUrl(ws.url) ? 'поиск — локальный SearXNG' : `поиск — ${ws.provider || 'duckduckgo'}`;
    add('warn', 'Веб', 'Веб-инструменты включены', `web_fetch открывает страницы, ${search}: адреса и запросы видны сайтам и поисковику`, 'Выключите веб-инструменты, если нужна изоляция');
  }
  item('веб-инструменты выключены', settings.webTools === false);
  // Браузер агента включён по умолчанию (browserEnabled), выключается явно.
  const browser = settings.browserEnabled !== false;
  if (browser) add('warn', 'Браузер', 'Браузер агента включён', 'Агент открывает сайты и отправляет формы (после подтверждения)');
  item('браузер агента выключен', !browser);

  // Уведомления и голос.
  const channels = (settings.notifications?.channels || []).filter((c) => c && c.enabled !== false);
  const hook = settings.notifications?.webhookUrl;
  if (channels.length || (hook && hook !== '***')) add('warn', 'Уведомления', `Уведомления в мессенджеры: ${channels.map((c) => c.type || c.kind || 'канал').join(', ') || 'webhook'}`, 'Уходят заголовок и суть события, без файлов');
  item('уведомления только на этом компьютере', !channels.length && !(hook && hook !== '***'));
  const voice = settings.voice || {};
  if (voice.engine === 'provider') {
    const p = providerFor(settings, voice.model);
    if (p && !p.local) add('warn', 'Голос', `Голос распознаёт облачный провайдер ${p.name}`, 'Запись голоса уходит провайдеру', 'Выберите MAS — локальное распознавание');
  } else if (settings.mas?.url && !isLocalUrl(settings.mas.url)) add('warn', 'Голос', 'MAS на другом компьютере', `Запись голоса → ${hostOf(settings.mas.url)}`);
  item('голос распознаётся локально', !(voice.engine === 'provider' && !providerFor(settings, voice.model)?.local) && !(voice.engine !== 'provider' && settings.mas?.url && !isLocalUrl(settings.mas.url)));

  // Внешние рантаймы (Claude Code, Codex и т.п. ходят в своё облако).
  const runtimes = Object.entries(settings.runtimes || {}).filter(([, r]) => r && r.enabled !== false);
  if (runtimes.length) add('warn', 'Рантаймы', `Внешние рантаймы: ${runtimes.map(([id]) => id).join(', ')}`, 'CLI агентов отправляют задачу в свои облака по своим правилам');
  item('внешние рантаймы не используются', runtimes.length === 0);

  // Хранилище.
  const infra = settings.infra || {};
  for (const [label, url] of [['Postgres', infra.postgresUrl], ['SeaweedFS', infra.seaweedUrl], ['Vault', infra.vaultAddr]]) {
    if (!url) continue;
    const pg = label === 'Postgres' ? String(url).replace(/^postgres(ql)?:/, 'http:') : url;
    if (isLocalUrl(pg)) add('info', 'Хранилище', `${label} — локально`, hostOf(pg));
    else add('warn', 'Хранилище', `${label} на внешнем сервере`, `Артефакты${label === 'Vault' ? ' и ключи' : ''} уходят на ${hostOf(pg)}`);
  }
  item('Postgres, SeaweedFS и Vault — локальные или не заданы', ![infra.postgresUrl, infra.seaweedUrl, infra.vaultAddr].some((u) => u && !isLocalUrl(String(u).replace(/^postgres(ql)?:/, 'http:'))));

  const order = { fail: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const counts = { fail: findings.filter((f) => f.level === 'fail').length, warn: findings.filter((f) => f.level === 'warn').length, info: findings.filter((f) => f.level === 'info').length };
  return { strictLocal: checklist.every((c) => c.ok), counts, findings, checklist };
}
