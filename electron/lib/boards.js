import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';
import { listArtifacts, readArtifact, artifactsRoot } from './artifacts.js';
import { renameWithRetry } from './file-lock.js';
import { listSkills } from './skills.js';
import { pluginDirs } from './plugins.js';

/**
 * Четыре доски + хранилище. Данные лежат в проекте, поэтому версионируются
 * вместе с кодом: <проект>/.mai-code/boards.json.
 */

export function boardsFile(projectDir) {
  return path.join(projectDir || '', '.mai-code', 'boards.json');
}

const uid = () => crypto.randomUUID();

function seedModel(name) {
  return {
    system: {
      name,
      description: 'Десктопный агент для разработки: чат, инструменты, артефакты и внешние рантаймы.',
      actors: ['Разработчик', 'Пользователь'],
      externals: ['LLM-шлюз', 'Git-хостинг', 'MCP-серверы'],
    },
    containers: [
      { id: 'desktop', name: 'Desktop UI', tech: 'Electron / HTML', description: 'Чат, панели, доски' },
      { id: 'main', name: 'Main process', tech: 'Node.js', description: 'IPC, агент, инструменты' },
      { id: 'store', name: 'Artifact store', tech: 'Files + Postgres', description: 'Версии артефактов' },
      { id: 'infra', name: 'Infra', tech: 'Vault / SeaweedFS', description: 'Секреты и блобы' },
    ],
    components: [
      { id: 'ui', container: 'desktop', name: 'Chat UI', description: 'Поток ответов и подтверждения' },
      { id: 'agent', container: 'main', name: 'Agent loop', description: 'Цикл модели и инструментов' },
      { id: 'providers', container: 'main', name: 'Provider registry', description: 'MAI, AgentRouter, OpenAI-compatible' },
      { id: 'mcp', container: 'main', name: 'MCP manager', description: 'stdio и HTTP серверы' },
      { id: 'runtimes', container: 'main', name: 'Runtime runner', description: 'OpenCode, herdr и другие CLI' },
      { id: 'boards', container: 'main', name: 'Boards engine', description: 'Задачи, ADR, качество, деплой' },
      { id: 'artifacts', container: 'store', name: 'Artifact versions', description: 'Blobs + index.json' },
      { id: 'vault', container: 'infra', name: 'Secrets', description: 'Vault KV v2' },
      { id: 'blobs', container: 'infra', name: 'Blob storage', description: 'SeaweedFS filer' },
    ],
    relations: [
      { from: 'ui', to: 'agent', label: 'IPC', tech: 'contextBridge' },
      { from: 'agent', to: 'providers', label: 'chat/completions', tech: 'HTTPS' },
      { from: 'agent', to: 'mcp', label: 'tools', tech: 'MCP' },
      { from: 'agent', to: 'runtimes', label: 'spawn', tech: 'child_process' },
      { from: 'boards', to: 'artifacts', label: 'versions', tech: 'fs' },
      { from: 'artifacts', to: 'blobs', label: 'sync', tech: 'HTTP' },
      { from: 'providers', to: 'vault', label: 'keys', tech: 'KV v2' },
    ],
    sequence: {
      title: 'Запрос к агенту',
      participants: ['Пользователь', 'Chat UI', 'Agent loop', 'LLM-шлюз', 'Artifact store'],
      messages: [
        { from: 'Пользователь', to: 'Chat UI', text: 'Задача', kind: 'sync' },
        { from: 'Chat UI', to: 'Agent loop', text: 'chat:start', kind: 'sync' },
        { from: 'Agent loop', to: 'LLM-шлюз', text: 'chat/completions', kind: 'sync' },
        { from: 'LLM-шлюз', to: 'Agent loop', text: 'tool_calls', kind: 'return' },
        { from: 'Agent loop', to: 'Artifact store', text: 'сохранить версию', kind: 'sync' },
        { from: 'Agent loop', to: 'Chat UI', text: 'поток ответа', kind: 'return' },
      ],
    },
    er: {
      entities: [
        { name: 'Project', attributes: [{ name: 'id', type: 'text', pk: true }, { name: 'name', type: 'text' }] },
        { name: 'Artifact', attributes: [{ name: 'id', type: 'text', pk: true }, { name: 'kind', type: 'text' }, { name: 'projectId', type: 'text', fk: true }] },
        { name: 'ArtifactVersion', attributes: [{ name: 'id', type: 'text', pk: true }, { name: 'artifactId', type: 'text', fk: true }, { name: 'hash', type: 'text' }] },
        { name: 'Task', attributes: [{ name: 'id', type: 'text', pk: true }, { name: 'status', type: 'text' }, { name: 'projectId', type: 'text', fk: true }] },
        { name: 'Adr', attributes: [{ name: 'id', type: 'text', pk: true }, { name: 'status', type: 'text' }] },
      ],
      relations: [
        { from: 'Project', to: 'Artifact', label: 'содержит', cardinality: 'one-many' },
        { from: 'Artifact', to: 'ArtifactVersion', label: 'версии', cardinality: 'one-many' },
        { from: 'Project', to: 'Task', label: 'задачи', cardinality: 'one-many' },
      ],
    },
    deployment: {
      nodes: [
        { id: 'laptop', name: 'Рабочая станция', kind: 'vm', vm: 'Windows 11', cpu: '8 vCPU', ram: '32 GB', gpu: '0', region: 'local' },
        { id: 'docker', name: 'Docker Desktop', kind: 'container', vm: 'WSL2', cpu: '4 vCPU', ram: '12 GB', gpu: '0', region: 'local' },
        { id: 'pg', name: 'Postgres + pgvector', kind: 'container', vm: 'container', cpu: '2 vCPU', ram: '4 GB', gpu: '0', region: 'local' },
        { id: 'vault', name: 'Vault', kind: 'container', vm: 'container', cpu: '1 vCPU', ram: '1 GB', gpu: '0', region: 'local' },
        { id: 'seaweed', name: 'SeaweedFS', kind: 'container', vm: 'container', cpu: '2 vCPU', ram: '2 GB', gpu: '0', region: 'local' },
      ],
      links: [
        { from: 'laptop', to: 'docker' },
        { from: 'docker', to: 'pg' },
        { from: 'docker', to: 'vault' },
        { from: 'docker', to: 'seaweed' },
      ],
    },
    openapi: {
      info: { title: `${name} API`, version: '0.1.0' },
      paths: {
        '/v1/chat/completions': { post: { summary: 'Чат с агентом', tags: ['agent'] } },
        '/v1/models': { get: { summary: 'Список моделей', tags: ['models'] } },
        '/v1/artifacts': { get: { summary: 'Список артефактов', tags: ['storage'] } },
      },
    },
  };
}

export function defaultBoards(projectDir) {
  const name = path.basename(projectDir || '') || 'Проект';
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    delivery: {
      columns: [
        { id: 'backlog', name: 'Бэклог' },
        { id: 'doing', name: 'В работе' },
        { id: 'review', name: 'Ревью' },
        { id: 'done', name: 'Готово' },
      ],
      tasks: [],
      multica: { url: '' },
    },
    architecture: { adrs: [], model: seedModel(name), baseline: null },
    runners: {
      stages: [
        { id: 'build', name: 'Сборка', command: 'npm.cmd run build', status: 'idle', log: '', lastExit: null, lastRunAt: '' },
        { id: 'test', name: 'Тесты', command: 'npm.cmd test', status: 'idle', log: '', lastExit: null, lastRunAt: '' },
        { id: 'package', name: 'Пакет', command: 'npm.cmd run package', status: 'idle', log: '', lastExit: null, lastRunAt: '' },
        { id: 'deploy', name: 'Деплой', command: '', status: 'idle', log: '', lastExit: null, lastRunAt: '' },
      ],
      runs: [],
    },
    quality: { issues: [], lastScanAt: '', corrections: [] },
  };
}

export function loadBoards(projectDir) {
  const file = boardsFile(projectDir);
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = null;
  }
  if (!data) data = defaultBoards(projectDir);
  data.delivery ??= defaultBoards(projectDir).delivery;
  data.architecture ??= defaultBoards(projectDir).architecture;
  data.runners ??= defaultBoards(projectDir).runners;
  data.quality ??= defaultBoards(projectDir).quality;
  return data;
}

export const BOARD_SECTIONS = ['delivery', 'architecture', 'runners', 'quality'];

/**
 * Атомарная запись (F9, ADR 0062): временный файл и rename — окно, читающее
 * доску, не увидит её наполовину записанной. Номер версии растёт только у
 * изменившихся секций: правки разных секций из разных окон не конфликтуют.
 */
export function saveBoards(projectDir, data) {
  const file = boardsFile(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    stored = null;
  }
  const revs = { ...(stored?.revs || {}) };
  for (const section of BOARD_SECTIONS) {
    if (JSON.stringify(stored?.[section] ?? null) !== JSON.stringify(data[section] ?? null)) revs[section] = (revs[section] || 0) + 1;
  }
  data.revs = revs;
  data.updatedAt = new Date().toISOString();
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  renameWithRetry(temp, file);
  return data;
}

/**
 * Сохранение секции из окна: `rev` — версия, которую окно видело. Другое окно
 * успело сохранить эту секцию — конфликт и свежие данные вместо перезаписи.
 */
export function saveBoardSection(projectDir, section, value, rev) {
  if (!BOARD_SECTIONS.includes(section)) throw new Error('Неизвестная секция доски');
  const current = loadBoards(projectDir);
  const now = current.revs?.[section] || 0;
  if (rev !== undefined && rev !== null && Number(rev) !== now) {
    return { conflict: true, section, boards: current };
  }
  current[section] = value;
  return saveBoards(projectDir, current);
}

/* ---------- PlantUML (ADR 0127: вместо Mermaid) ---------- */

const mid = (value) => String(value || 'x').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, 'n$1');
/** Строка для макроса C4-PlantUML: без двойных кавычек и переводов строк. */
const q = (value) =>
  String(value ?? '')
    .replace(/"/g, "'")
    .replace(/\r?\n/g, ' ')
    .trim();

/** Связи между элементами уровня: компонент поднимается до своего контейнера (C2). */
function levelEdges(model, ids, lift = new Map()) {
  const edges = new Map();
  for (const rel of model.relations || []) {
    const from = ids.has(rel.from) ? rel.from : lift.get(rel.from);
    const to = ids.has(rel.to) ? rel.to : lift.get(rel.to);
    if (!from || !to || !ids.has(from) || !ids.has(to) || from === to) continue;
    const key = `${from}->${to}`;
    if (!edges.has(key)) edges.set(key, { from, to, labels: [], tech: [] });
    const e = edges.get(key);
    if (rel.label && !e.labels.includes(q(rel.label))) e.labels.push(q(rel.label));
    if (rel.tech && !e.tech.includes(q(rel.tech))) e.tech.push(q(rel.tech));
  }
  return [...edges.values()].map((e) => `Rel(${mid(e.from)}, ${mid(e.to)}, "${e.labels.join(', ')}"${e.tech.length ? `, "${e.tech.join(', ')}"` : ''})`);
}

const isDb = (c) => /postgres|mysql|mongo|redis|sqlite|clickhouse|database|\bdb\b|бд|хранилищ/i.test(`${c.tech || ''} ${c.name || ''}`);
const isQueue = (c) => /kafka|rabbit|nats|queue|очеред|sqs/i.test(`${c.tech || ''} ${c.name || ''}`);

function pumlC1(model) {
  const actors = model.system?.actors || [];
  const externals = model.system?.externals || [];
  const lines = ['@startuml', '!include <C4/C4_Context>', 'LAYOUT_LEFT_RIGHT()', ''];
  actors.forEach((actor, i) => lines.push(`Person(actor_${i}, "${q(actor)}")`));
  lines.push(`System(sys, "${q(model.system?.name || 'Система')}", "${q(model.system?.description || '')}")`);
  externals.forEach((ext, i) => lines.push(`System_Ext(ext_${i}, "${q(ext)}")`));
  lines.push('');
  actors.forEach((_a, i) => lines.push(`Rel(actor_${i}, sys, "работает")`));
  externals.forEach((_e, i) => lines.push(`Rel(sys, ext_${i}, "использует")`));
  lines.push('', 'SHOW_LEGEND()', '@enduml');
  return lines.join('\n');
}

function pumlC2(model) {
  const containers = model.containers || [];
  const lines = ['@startuml', '!include <C4/C4_Container>', 'LAYOUT_TOP_DOWN()', ''];
  lines.push(`System_Boundary(sys, "${q(model.system?.name || 'Система')}") {`);
  for (const c of containers) {
    const macro = isDb(c) ? 'ContainerDb' : isQueue(c) ? 'ContainerQueue' : 'Container';
    lines.push(`  ${macro}(${mid(c.id)}, "${q(c.name)}", "${q(c.tech)}", "${q(c.description)}")`);
  }
  lines.push('}');
  const ids = new Set(containers.map((c) => c.id));
  const lift = new Map((model.components || []).filter((c) => c.container).map((c) => [c.id, c.container]));
  lines.push('', ...levelEdges(model, ids, lift), '', 'SHOW_LEGEND()', '@enduml');
  return lines.join('\n');
}

function pumlC3(model) {
  const components = model.components || [];
  const lines = ['@startuml', '!include <C4/C4_Component>', 'LAYOUT_TOP_DOWN()', ''];
  for (const container of model.containers || []) {
    const own = components.filter((c) => c.container === container.id);
    if (!own.length) continue;
    lines.push(`Container_Boundary(${mid(container.id)}, "${q(container.name)}") {`);
    for (const c of own) lines.push(`  Component(${mid(c.id)}, "${q(c.name)}", "${q(c.tech)}", "${q(c.description)}")`);
    lines.push('}');
  }
  const ids = new Set(components.map((c) => c.id));
  lines.push('', ...levelEdges(model, ids), '', 'SHOW_LEGEND()', '@enduml');
  return lines.join('\n');
}

function pumlC4(model) {
  const components = model.components || [];
  const lines = ['@startuml', 'hide empty members', 'skinparam classAttributeIconSize 0'];
  for (const c of components) {
    lines.push(`class "${q(c.name)}" as ${mid(c.id)} {`);
    if (c.description) lines.push(`  ${q(c.description)}`);
    lines.push('}');
  }
  const ids = new Set(components.map((c) => c.id));
  for (const rel of model.relations || []) {
    if (ids.has(rel.from) && ids.has(rel.to)) lines.push(`${mid(rel.from)} --> ${mid(rel.to)} : ${q(rel.label || 'uses')}`);
  }
  lines.push('@enduml');
  return lines.join('\n');
}

function pumlSequence(model) {
  const seq = model.sequence || {};
  const participants = seq.participants || [];
  const lines = ['@startuml', 'autonumber', `title ${q(seq.title || 'Сценарий')}`];
  participants.forEach((p, i) => lines.push(`participant "${q(p)}" as P${i}`));
  const idx = (name) => Math.max(0, participants.indexOf(name));
  for (const m of seq.messages || []) {
    const arrow = m.kind === 'return' ? '-->' : m.kind === 'async' ? '->>' : '->';
    lines.push(`P${idx(m.from)} ${arrow} P${idx(m.to)} : ${q(m.text)}`);
  }
  lines.push('@enduml');
  return lines.join('\n');
}

const CARD = { 'one-one': '||--||', 'one-many': '||--o{', 'many-one': '}o--||', 'many-many': '}o--o{' };

function pumlEr(model) {
  const lines = ['@startuml', 'hide circle', 'skinparam linetype ortho'];
  for (const entity of model.er?.entities || []) {
    lines.push(`entity "${q(entity.name)}" as ${mid(entity.name)} {`);
    const attrs = entity.attributes || [];
    for (const a of attrs.filter((x) => x.pk)) lines.push(`  * ${q(a.name)} : ${q(a.type || 'text')} <<PK>>`);
    if (attrs.some((x) => x.pk)) lines.push('  --');
    for (const a of attrs.filter((x) => !x.pk)) lines.push(`  ${q(a.name)} : ${q(a.type || 'text')}${a.fk ? ' <<FK>>' : ''}`);
    lines.push('}');
  }
  for (const rel of model.er?.relations || []) lines.push(`${mid(rel.from)} ${CARD[rel.cardinality] || '||--o{'} ${mid(rel.to)} : ${q(rel.label || 'related')}`);
  lines.push('@enduml');
  return lines.join('\n');
}

function pumlDeployment(model) {
  const lines = ['@startuml', '!include <C4/C4_Deployment>', 'LAYOUT_TOP_DOWN()', ''];
  for (const node of model.deployment?.nodes || []) {
    const sizing = [node.vm, node.cpu, node.ram, node.gpu && node.gpu !== '0' ? `GPU ${node.gpu}` : 'GPU 0'].filter(Boolean).join(' · ');
    lines.push(`Deployment_Node(${mid(node.id)}, "${q(node.name)}", "${q(sizing)}")`);
  }
  for (const link of model.deployment?.links || []) lines.push(`Rel(${mid(link.from)}, ${mid(link.to)}, "${q(link.label || '')}")`);
  lines.push('', '@enduml');
  return lines.join('\n');
}

function openapiView(model) {
  const spec = model.openapi || {};
  const endpoints = [];
  for (const [route, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods || {})) {
      endpoints.push({
        method: method.toUpperCase(),
        path: route,
        summary: op.summary || '',
        tags: op.tags || [],
      });
    }
  }
  return { info: spec.info || {}, endpoints, spec };
}

const VIEWS = ['c1', 'c2', 'c3', 'c4', 'sequence', 'er', 'deployment', 'openapi'];

const hash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);

export function generateViews(projectDir, gitHead = '') {
  const data = loadBoards(projectDir);
  const model = data.architecture.model || {};
  const baseline = data.architecture.baseline || null;
  const views = {
    c1: { title: 'C1 · Контекст', puml: pumlC1(model) },
    c2: { title: 'C2 · Контейнеры', puml: pumlC2(model) },
    c3: { title: 'C3 · Компоненты', puml: pumlC3(model) },
    c4: { title: 'C4 · Код', puml: pumlC4(model) },
    sequence: { title: 'Sequence', puml: pumlSequence(model) },
    er: { title: 'ER-диаграмма', puml: pumlEr(model) },
    deployment: { title: 'Deployment + sizing', puml: pumlDeployment(model) },
  };
  for (const view of Object.values(views)) view.hash = hash(view.puml);
  const openapi = openapiView(model);
  openapi.title = 'OpenAPI';
  openapi.hash = hash(JSON.stringify(openapi.spec));
  views.openapi = openapi;

  const drift = {};
  for (const key of VIEWS) {
    drift[key] = Boolean(baseline?.hashes?.[key] && baseline.hashes[key] !== views[key].hash);
  }
  const gitDrift = Boolean(baseline?.gitHead && gitHead && baseline.gitHead !== gitHead);

  return {
    views,
    drift,
    gitDrift,
    baseline,
    gitHead,
    updatedAt: data.updatedAt,
  };
}

export function saveBaseline(projectDir, gitHead = '') {
  const data = loadBoards(projectDir);
  const { views } = generateViews(projectDir, gitHead);
  data.architecture.baseline = {
    at: new Date().toISOString(),
    gitHead: gitHead || '',
    hashes: Object.fromEntries(VIEWS.map((key) => [key, views[key].hash])),
  };
  saveBoards(projectDir, data);
  return data.architecture.baseline;
}

/* ---------- качество ---------- */

function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function issueKey(type, artifactId, title) {
  return crypto.createHash('sha1').update(`${type}|${artifactId}|${title}`).digest('hex').slice(0, 12);
}

function readErrorLog() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dataDir(), 'errors.json'), 'utf8'));
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

export async function scanQuality(projectDir, { loadPlugins } = {}) {
  const data = loadBoards(projectDir);
  const issues = [];
  const push = (type, severity, title, detail, extra = {}) => {
    issues.push({
      id: issueKey(type, extra.artifactId || '', title),
      type,
      severity,
      title,
      detail,
      status: 'open',
      createdAt: new Date().toISOString(),
      ...extra,
    });
  };

  const artifacts = listArtifacts(projectDir);
  const withContent = artifacts.map((a) => {
    let content = '';
    try {
      content = readArtifact(projectDir, a.id).content;
    } catch {
      content = '';
    }
    return { ...a, content };
  });

  // Дубли имён в одном типе.
  const byName = new Map();
  for (const a of withContent) {
    const key = `${a.kind}|${a.name.trim().toLowerCase()}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(a);
  }
  for (const group of byName.values()) {
    if (group.length > 1) {
      push('duplicate-name', 'warn', `Дубли имени: ${group[0].name}`, group.map((g) => g.id).join(', '), {
        artifactId: group[0].id,
        related: group.map((g) => g.id),
      });
    }
  }

  // Почти одинаковое содержимое (один тип).
  const checked = withContent.filter((a) => a.content.length > 120).slice(0, 160);
  for (let i = 0; i < checked.length; i += 1) {
    for (let j = i + 1; j < checked.length; j += 1) {
      if (checked[i].kind !== checked[j].kind) continue;
      const score = jaccard(tokens(checked[i].content), tokens(checked[j].content));
      if (score >= 0.82) {
        push(
          'duplicate-content',
          'warn',
          `Похожие артефакты: ${checked[i].name} / ${checked[j].name}`,
          `Совпадение ${(score * 100).toFixed(0)}%. Возможно, один из них устарел.`,
          { artifactId: checked[i].id, related: [checked[i].id, checked[j].id], score },
        );
      }
    }
  }

  // Навыки: одинаковые имена в проекте и глобально.
  const skills = listSkills(projectDir);
  const skillNames = new Map();
  for (const skill of skills) {
    if (!skillNames.has(skill.name)) skillNames.set(skill.name, []);
    skillNames.get(skill.name).push(skill);
  }
  for (const [name, group] of skillNames) {
    if (group.length > 1) {
      push('skill-conflict', 'error', `Навык «${name}» объявлен ${group.length} раза`, group.map((g) => `${g.scope}: ${g.file}`).join('\n'), {
        artifactId: `skill:${name}`,
      });
    }
  }
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      if (skills[i].name === skills[j].name) continue;
      const score = jaccard(tokens(skills[i].body), tokens(skills[j].body));
      if (score >= 0.8) {
        push('skill-duplicate', 'warn', `Навыки «${skills[i].name}» и «${skills[j].name}» почти совпадают`, `Совпадение ${(score * 100).toFixed(0)}%`, {
          related: [skills[i].file, skills[j].file],
          score,
        });
      }
    }
  }

  // AGENTS.md: повторы и противоречия между проектным и глобальным.
  const projectAgents = withContent.find((a) => a.id === 'agents:project')?.content || '';
  const globalAgents = withContent.find((a) => a.id === 'agents:global')?.content || '';
  const norm = (line) => line.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!;]+$/, '');
  const projectLines = projectAgents.split(/\r?\n/).map(norm).filter((l) => l.length > 12 && !l.startsWith('#'));
  const globalLines = globalAgents.split(/\r?\n/).map(norm).filter((l) => l.length > 12 && !l.startsWith('#'));
  const dup = projectLines.filter((line) => globalLines.includes(line));
  if (dup.length) {
    push('agents-duplicate', 'warn', 'AGENTS.md: одинаковые инструкции в проектном и глобальном файле', dup.slice(0, 10).join('\n'), {
      artifactId: 'agents:project',
    });
  }
  const conflicts = [];
  for (const line of projectLines) {
    const flipped = line
      .replace(/\bвсегда\b/g, 'никогда')
      .replace(/\bникогда\b/g, 'всегда')
      .replace(/\balways\b/g, 'never')
      .replace(/\bnever\b/g, 'always');
    if (globalLines.includes(flipped)) conflicts.push(`${line}\n↔ ${flipped}`);
  }
  if (conflicts.length) {
    push('agents-conflict', 'error', 'AGENTS.md: противоречащие инструкции', conflicts.slice(0, 10).join('\n\n'), {
      artifactId: 'agents:project',
    });
  }

  // Плагины: коллизии имён инструментов.
  if (loadPlugins) {
    try {
      const { tools } = await loadPlugins(projectDir);
      const seen = new Map();
      for (const tool of tools) {
        const name = tool.schema?.function?.name;
        if (!name) continue;
        if (!seen.has(name)) seen.set(name, []);
        seen.get(name).push(name);
      }
      for (const [name, group] of seen) {
        if (group.length > 1) push('plugin-conflict', 'error', `Инструмент «${name}» объявлен несколькими плагинами`, `${group.length} объявлений`, {});
      }
    } catch {
      /* плагин мог не загрузиться — это отдельная ошибка */
    }
  }

  // Ошибки агента и рантаймов из журнала.
  const errors = readErrorLog().slice(-100);
  const grouped = new Map();
  for (const entry of errors) {
    const signature = String(entry.message || '').slice(0, 160);
    if (!signature) continue;
    if (!grouped.has(signature)) grouped.set(signature, []);
    grouped.get(signature).push(entry);
  }
  for (const [signature, group] of grouped) {
    if (group.length < 2) continue;
    push('agent-error', 'error', `Повторяющаяся ошибка агента (${group.length} раз)`, signature, {
      related: group.slice(-3).map((g) => g.at),
    });
  }

  // Битые ссылки задач и ADR.
  for (const task of data.delivery.tasks || []) {
    for (const link of task.links?.artifacts || []) {
      if (!artifacts.some((a) => a.id === link)) {
        push('broken-link', 'warn', `Задача «${task.title}» ссылается на отсутствующий артефакт`, link, { taskId: task.id });
      }
    }
  }

  const previous = new Map((data.quality.issues || []).map((issue) => [issue.id, issue.status]));
  for (const issue of issues) {
    if (previous.get(issue.id) === 'ignored') issue.status = 'ignored';
  }
  data.quality.issues = issues;
  data.quality.lastScanAt = new Date().toISOString();
  saveBoards(projectDir, data);

  const summary = { total: issues.length, open: issues.filter((i) => i.status === 'open').length };
  for (const issue of issues) summary[issue.severity] = (summary[issue.severity] || 0) + 1;
  return { issues, summary, scannedAt: data.quality.lastScanAt, root: artifactsRoot(projectDir) };
}

export function correctionPrompt(projectDir, issues) {
  const selected = issues.slice(0, 8);
  const data = loadBoards(projectDir);
  const tasks = (data.delivery.tasks || []).filter((t) => t.status !== 'done').slice(0, 10);
  return [
    'Ты — инженер по качеству в MAI Code. Нужно устранить проблемы в артефактах проекта.',
    '',
    'Проблемы:',
    ...selected.map((issue, i) => `${i + 1}. [${issue.type}] ${issue.title}\n   ${String(issue.detail || '').replace(/\n/g, '\n   ')}`),
    '',
    tasks.length ? `Открытые задачи доски доставки:\n${tasks.map((t) => `- ${t.title}`).join('\n')}` : '',
    '',
    'Правила:',
    '- Сначала прочитай затронутые файлы и артефакты инструментами.',
    '- Правки делай точечно, не удаляй содержимое без необходимости.',
    '- Не дублируй навыки и инструкции: лучше объедини или сошлись на существующий.',
    '- После правок перечисли, что изменено и какие проблемы остались.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function recordCorrection(projectDir, { issueIds, sessionId, status, summary }) {
  const data = loadBoards(projectDir);
  data.quality.corrections ??= [];
  data.quality.corrections.unshift({
    id: uid(),
    issueIds,
    sessionId,
    status,
    summary,
    startedAt: new Date().toISOString(),
    finishedAt: status === 'done' ? new Date().toISOString() : '',
  });
  saveBoards(projectDir, data);
  return data.quality.corrections[0];
}

export function updateCorrection(projectDir, id, patch) {
  const data = loadBoards(projectDir);
  const item = (data.quality.corrections || []).find((c) => c.id === id);
  if (item) Object.assign(item, patch);
  saveBoards(projectDir, data);
  return item;
}
