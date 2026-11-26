#!/usr/bin/env node
/**
 * MAI Ship без окна (ADR 0108): роли агентов для GitLab CI.
 *
 *   node scripts/mai-ship.mjs approve [--project <id|путь>] [--mr <iid>] [--dry-run] [--gate]
 *
 * В CI проект и MR берутся из CI_PROJECT_ID и CI_MERGE_REQUEST_IID, адрес — из CI_SERVER_URL.
 * Переменные:
 *   GITLAB_TOKEN             токен бот-учётки mai-ship-approver (право апрува, без push)
 *   SHIP_APPROVER_BASE_URL   OpenAI-совместимый шлюз для классификаторов
 *   SHIP_APPROVER_API_KEY    ключ шлюза
 *   MAI_SHIP_DISABLED=true   выключить Ship
 *   MAI_SHIP_BOT_USERNAME    логин бота approver'а (по умолчанию mai-ship-approver)
 * Модель approver'а — providers.approver в .mai-code/ship.yaml target branch.
 * Код выхода: 0 — можно вливать или Ship только советует (observe), 1 — ошибка, 2 — заблокировано,
 * 3 — с --gate: нужен апрув человека (GitLab Free: джоба красная, пока человек не апрувнет и не
 * перезапустит её).
 */
import OpenAI from 'openai';
import { createGitlab } from '../electron/lib/ship/gitlab.js';
import { runApprove, createClassifier, gateExitCode } from '../electron/lib/ship/approve.js';

const args = process.argv.slice(2);
const role = args[0];
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] || '' : '';
};
const env = process.env;

async function main() {
  if (role !== 'approve') throw new Error('роль: approve (review и steward — следующие шаги, E3.D, E3.E)');
  const project = option('--project') || env.CI_PROJECT_ID;
  const iid = option('--mr') || env.CI_MERGE_REQUEST_IID;
  if (!project || !iid) throw new Error('нужны --project и --mr (или CI_PROJECT_ID и CI_MERGE_REQUEST_IID)');
  const gitlab = createGitlab({ url: env.GITLAB_URL || env.CI_SERVER_URL, token: env.GITLAB_TOKEN });
  const makeClassifier = (shipCfg) => {
    const approver = String(shipCfg.providers?.approver || '');
    const model = approver.includes('/') ? approver.slice(approver.indexOf('/') + 1) : approver;
    if (!env.SHIP_APPROVER_BASE_URL || !env.SHIP_APPROVER_API_KEY || !model) return null; // без модели классификаторы «не посчитаны» → человек
    return createClassifier({ client: new OpenAI({ baseURL: env.SHIP_APPROVER_BASE_URL, apiKey: env.SHIP_APPROVER_API_KEY, maxRetries: 2 }), model });
  };
  const out = await runApprove({ gitlab, project, iid, makeClassifier, env, dryRun: args.includes('--dry-run') });
  if (out.status === 'skipped') {
    console.log(`MAI Ship approver: пропуск — ${out.reason}`);
    return 0;
  }
  const r = out.result;
  console.log(`MAI Ship approver: ${r.decision} (${r.action}) — правило ${r.rule}: ${r.reason}`);
  if (out.note && args.includes('--dry-run')) console.log(`\n${out.note}`);
  if (out.status === 'stale') console.log(`Апрув не поставлен: ${out.reason}`);
  if (args.includes('--gate')) {
    const code = await gateExitCode(out, { gitlab, project, iid, botUsername: env.MAI_SHIP_BOT_USERNAME || 'mai-ship-approver', policyMode: out.policyMode });
    if (code === 3) console.log('Нужен апрув человека: апрувните MR и перезапустите джобу ship:approval.');
    return code;
  }
  return r.action === 'block' ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`MAI Ship approver: ${err.message}`);
    process.exit(1);
  },
);
