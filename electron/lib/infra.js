import crypto from 'node:crypto';
import { loadSettings, saveSettings } from './config.js';
import { artifactHistory, listArtifacts, readArtifact, readVersion } from './artifacts.js';

/**
 * Опциональная инфраструктура: Postgres + pgvector, Vault KV v2, SeaweedFS.
 * Приложение полностью работает и без неё; все функции возвращают понятную
 * ошибку, если сервис не поднят.
 */

function infra() {
  const settings = loadSettings();
  return {
    ...(settings.infra || {}),
    embeddingProvider: settings.infra?.embeddingProvider || 'mai',
    embeddingModel: settings.infra?.embeddingModel || 'bge-m3',
    dimension: Number(settings.infra?.dimension || 1024),
  };
}

async function loadPg() {
  try {
    const mod = await import('pg');
    const Client = mod.Client || mod.default?.Client;
    if (!Client) throw new Error('pg не установлен');
    return Client;
  } catch (err) {
    throw new Error(`Драйвер Postgres недоступен: ${err?.message || err}. Выполните: npm.cmd install pg`);
  }
}

async function withPg(fn) {
  const cfg = infra();
  if (!cfg.postgresUrl) throw new Error('Не задан postgresUrl в настройках инфраструктуры');
  const Client = await loadPg();
  const client = new Client({ connectionString: cfg.postgresUrl, connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    return await fn(client, cfg);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function probe() {
  const cfg = infra();
  const result = {
    postgres: { ok: false, error: 'не проверялся' },
    vault: { ok: false, error: 'не проверялся' },
    seaweed: { ok: false, error: 'не проверялся' },
    config: {
      postgresUrl: cfg.postgresUrl ? cfg.postgresUrl.replace(/:[^:@/]+@/, ':***@') : '',
      vaultAddr: cfg.vaultAddr || '',
      seaweedUrl: cfg.seaweedUrl || '',
      embeddingProvider: cfg.embeddingProvider,
      embeddingModel: cfg.embeddingModel,
      dimension: cfg.dimension,
    },
  };

  if (cfg.postgresUrl) {
    try {
      await withPg(async (client) => {
        const version = await client.query('select version() as v');
        let vector = null;
        try {
          const ext = await client.query("select extversion from pg_extension where extname = 'vector'");
          vector = ext.rows[0]?.extversion || null;
        } catch {
          vector = null;
        }
        result.postgres = {
          ok: true,
          version: String(version.rows[0]?.v || '').split(' ').slice(0, 2).join(' '),
          pgvector: vector,
        };
      });
    } catch (err) {
      result.postgres = { ok: false, error: err?.message || String(err) };
    }
  } else {
    result.postgres = { ok: false, error: 'URL не задан' };
  }

  if (cfg.vaultAddr) {
    try {
      const res = await fetch(`${cfg.vaultAddr.replace(/\/$/, '')}/v1/sys/health`, {
        signal: AbortSignal.timeout(4000),
      });
      const body = await res.json().catch(() => ({}));
      result.vault = {
        ok: res.status === 200 || res.status === 429,
        status: res.status,
        sealed: Boolean(body.sealed),
        version: body.version || '',
        error: body.sealed ? 'Vault запечатан' : '',
      };
    } catch (err) {
      result.vault = { ok: false, error: err?.message || String(err) };
    }
  } else {
    result.vault = { ok: false, error: 'Адрес не задан' };
  }

  if (cfg.seaweedUrl) {
    try {
      const res = await fetch(`${cfg.seaweedUrl.replace(/\/$/, '')}/`, {
        signal: AbortSignal.timeout(4000),
      });
      result.seaweed = { ok: res.ok || res.status === 404, status: res.status };
    } catch (err) {
      result.seaweed = { ok: false, error: err?.message || String(err) };
    }
  } else {
    result.seaweed = { ok: false, error: 'Адрес не задан' };
  }

  return result;
}

async function ensureSchema(client, dimension) {
  const dim = Math.max(1, Math.min(4096, Number(dimension) || 1024));
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query(`
    CREATE TABLE IF NOT EXISTS mai_artifacts (
      project text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL,
      name text NOT NULL,
      title text,
      current integer NOT NULL DEFAULT 0,
      hash text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project, id)
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mai_artifact_versions (
      project text NOT NULL,
      id text NOT NULL,
      version integer NOT NULL,
      hash text NOT NULL,
      content text NOT NULL,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      embedding vector(${dim}),
      PRIMARY KEY (project, id, version)
    )`);
  await client.query(
    'CREATE INDEX IF NOT EXISTS mai_versions_fts ON mai_artifact_versions USING gin (to_tsvector(\'simple\', content))',
  );
  try {
    await client.query(
      'CREATE INDEX IF NOT EXISTS mai_versions_embedding ON mai_artifact_versions USING hnsw (embedding vector_cosine_ops)',
    );
  } catch {
    /* hnsw может быть недоступен в старом pgvector */
  }
}

async function embedText(text) {
  const settings = loadSettings();
  const cfg = settings.infra || {};
  const provider = settings.providers?.[cfg.embeddingProvider || 'mai'];
  if (!provider?.baseURL || !provider?.apiKey) throw new Error('Провайдер эмбеддингов не настроен');
  const res = await fetch(`${provider.baseURL.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.embeddingModel || 'bge-m3',
      input: String(text).slice(0, 8000),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Эмбеддинги: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('Провайдер не вернул embedding');
  return vector;
}

const vectorLiteral = (vec) => `[${vec.map((n) => Number(n).toFixed(7)).join(',')}]`;

/** Заливает артефакты и текущие версии в Postgres; эмбеддинги — если включены. */
export async function syncArtifacts(projectDir, { embed = true, limit = 300 } = {}) {
  const cfg = infra();
  const artifacts = listArtifacts(projectDir);
  const project = projectDir;

  return withPg(async (client) => {
    await ensureSchema(client, cfg.dimension);
    let versions = 0;
    let embedded = 0;
    let skippedEmbedding = 0;

    for (const artifact of artifacts.slice(0, limit)) {
      await client.query(
        `INSERT INTO mai_artifacts (project, id, kind, name, title, current, hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (project, id) DO UPDATE SET
           kind = EXCLUDED.kind, name = EXCLUDED.name, title = EXCLUDED.title,
           current = EXCLUDED.current, hash = EXCLUDED.hash, updated_at = now()`,
        [project, artifact.id, artifact.kind, artifact.name, artifact.title, artifact.current, artifact.hash],
      );

      for (const version of artifactHistory(projectDir, artifact.id)) {
        const content = readVersion(projectDir, artifact.id, version.version);
        await client.query(
          `INSERT INTO mai_artifact_versions (project, id, version, hash, content, note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()))
           ON CONFLICT (project, id, version) DO UPDATE SET
             hash = EXCLUDED.hash, content = EXCLUDED.content, note = EXCLUDED.note`,
          [project, artifact.id, version.version, version.hash, content, version.note || '', version.at || null],
        );
        versions += 1;

        if (!embed || version.version !== artifact.current) continue;
        const existing = await client.query(
          'SELECT embedding IS NOT NULL AS has FROM mai_artifact_versions WHERE project=$1 AND id=$2 AND version=$3',
          [project, artifact.id, version.version],
        );
        if (existing.rows[0]?.has) continue;
        try {
          const vector = await embedText(`${artifact.name}\n${artifact.title}\n${content}`);
          await client.query(
            'UPDATE mai_artifact_versions SET embedding = $4::vector WHERE project=$1 AND id=$2 AND version=$3',
            [project, artifact.id, version.version, vectorLiteral(vector)],
          );
          embedded += 1;
        } catch {
          skippedEmbedding += 1;
        }
      }
    }

    return {
      ok: true,
      artifacts: Math.min(artifacts.length, limit),
      versions,
      embedded,
      skippedEmbedding,
      dimension: cfg.dimension,
      model: cfg.embeddingModel,
    };
  });
}

export async function remoteSearch(projectDir, query) {
  const cfg = infra();
  let vector = null;
  try {
    vector = await embedText(query);
  } catch {
    vector = null;
  }

  return withPg(async (client) => {
    await ensureSchema(client, cfg.dimension);
    if (vector) {
      const res = await client.query(
        `SELECT v.id, a.kind, a.name, v.version, left(v.content, 600) AS snippet,
                1 - (v.embedding <=> $2::vector) AS score
         FROM mai_artifact_versions v
         JOIN mai_artifacts a ON a.project = v.project AND a.id = v.id
         WHERE v.project = $1 AND v.embedding IS NOT NULL
         ORDER BY v.embedding <=> $2::vector
         LIMIT 20`,
        [projectDir, vectorLiteral(vector)],
      );
      return { ok: true, mode: 'vector', results: res.rows };
    }
    const res = await client.query(
      `SELECT v.id, a.kind, a.name, v.version, left(v.content, 600) AS snippet,
              ts_rank(to_tsvector('simple', v.content), plainto_tsquery('simple', $2)) AS score
       FROM mai_artifact_versions v
       JOIN mai_artifacts a ON a.project = v.project AND a.id = v.id
       WHERE v.project = $1 AND to_tsvector('simple', v.content) @@ plainto_tsquery('simple', $2)
       ORDER BY score DESC
       LIMIT 20`,
      [projectDir, query],
    );
    return { ok: true, mode: 'fulltext', results: res.rows };
  });
}

function vaultConfig() {
  const cfg = infra();
  const token = process.env.VAULT_TOKEN || cfg.vaultToken || '';
  if (!cfg.vaultAddr) throw new Error('Не задан vaultAddr');
  if (!token) throw new Error('Не задан Vault token (поле или VAULT_TOKEN)');
  return { addr: cfg.vaultAddr.replace(/\/$/, ''), token };
}

export async function pushSecrets() {
  const { addr, token } = vaultConfig();
  const settings = loadSettings();
  const payload = {
    data: {
      providers: settings.providers || {},
      updatedAt: new Date().toISOString(),
    },
  };
  const res = await fetch(`${addr}/v1/secret/data/mai-code`, {
    method: 'POST',
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vault: HTTP ${res.status} ${body.errors?.join('; ') || ''}`);
  return { ok: true, version: body.data?.version };
}

export async function pullSecrets() {
  const { addr, token } = vaultConfig();
  const res = await fetch(`${addr}/v1/secret/data/mai-code`, {
    headers: { 'X-Vault-Token': token },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vault: HTTP ${res.status} ${body.errors?.join('; ') || ''}`);
  const providers = body.data?.data?.providers;
  if (!providers || typeof providers !== 'object') throw new Error('В Vault нет providers');
  saveSettings({ providers });
  return { ok: true, providers: Object.keys(providers) };
}

function projectSlug(projectDir) {
  return crypto.createHash('sha1').update(projectDir).digest('hex').slice(0, 10);
}

export async function uploadArtifacts(projectDir) {
  const cfg = infra();
  if (!cfg.seaweedUrl) throw new Error('Не задан seaweedUrl');
  const base = `${cfg.seaweedUrl.replace(/\/$/, '')}/mai-code/${projectSlug(projectDir)}`;
  let uploaded = 0;
  for (const artifact of listArtifacts(projectDir)) {
    const full = readArtifact(projectDir, artifact.id);
    const key = `${base}/${artifact.kind}/${artifact.slug}/${artifact.hash}`;
    const res = await fetch(key, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: full.content,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SeaweedFS: HTTP ${res.status} на ${artifact.id}`);
    uploaded += 1;
  }
  return { ok: true, uploaded, base };
}

export async function downloadArtifact(projectDir, id) {
  const cfg = infra();
  if (!cfg.seaweedUrl) throw new Error('Не задан seaweedUrl');
  const artifact = readArtifact(projectDir, id);
  const base = `${cfg.seaweedUrl.replace(/\/$/, '')}/mai-code/${projectSlug(projectDir)}`;
  const res = await fetch(`${base}/${artifact.kind}/${artifact.slug}/${artifact.hash}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`SeaweedFS: HTTP ${res.status}`);
  return { ok: true, content: await res.text(), artifact };
}

export async function syncAll(projectDir, { embed = true } = {}) {
  const status = await probe();
  const report = { status, postgres: null, seaweed: null, vault: null };
  if (status.postgres.ok) {
    try {
      report.postgres = await syncArtifacts(projectDir, { embed });
    } catch (err) {
      report.postgres = { ok: false, error: err?.message || String(err) };
    }
  }
  if (status.seaweed.ok) {
    try {
      report.seaweed = await uploadArtifacts(projectDir);
    } catch (err) {
      report.seaweed = { ok: false, error: err?.message || String(err) };
    }
  }
  if (status.vault.ok && (process.env.VAULT_TOKEN || infra().vaultToken)) {
    try {
      report.vault = await pushSecrets();
    } catch (err) {
      report.vault = { ok: false, error: err?.message || String(err) };
    }
  }
  return report;
}
