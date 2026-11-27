#!/usr/bin/env node
/**
 * MAI Ship без окна (ADR 0108): роли агентов для GitLab CI.
 *
 *   node scripts/mai-ship.mjs review  [--project <id|путь>] [--mr <iid>] [--dry-run]
 *   node scripts/mai-ship.mjs approve [--project <id|путь>] [--mr <iid>] [--dry-run] [--gate] [--journal <файл.jsonl>]
 *   node scripts/mai-ship.mjs report  [--project <id|путь>] [--days 30] [--json]
 *   node scripts/mai-ship.mjs steward [--project <id|путь>] [--mr <iid>] [--dry-run]
 *     MAI_SHIP_STEWARD_TOKEN — токен бота mai-ship-steward (push в ветки MR, без апрува);
 *     SHIP_STEWARD_BASE_URL, SHIP_STEWARD_API_KEY — шлюз модели providers.steward;
 *     рабочая копия — CI_PROJECT_DIR (ветка MR), push — в source branch MR.
 *
 * В CI проект и MR берутся из CI_PROJECT_ID и CI_MERGE_REQUEST_IID, адрес — из CI_SERVER_URL.
 * Переменные:
 *   GITLAB_TOKEN             токен бот-учётки mai-ship-approver (право апрува, без push)
 *   SHIP_APPROVER_BASE_URL   OpenAI-совместимый шлюз для классификаторов
 *   SHIP_APPROVER_API_KEY    ключ шлюза
 *   SHIP_REVIEWER_BASE_URL   шлюз модели ревьюера (providers.reviewer), SHIP_REVIEWER_API_KEY — ключ
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
import { runReview, createReviewModel } from '../electron/lib/ship/review.js';
import { collectDecisions, agreementReport, formatReport, flowMetrics, formatFlow } from '../electron/lib/ship/report.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runSteward, createAgentRunner } from '../electron/lib/ship/steward.js';

const args = process.argv.slice(2);
const role = args[0];
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] || '' : '';
};
const env = process.env;

async function main() {
  if (!['approve', 'review', 'report', 'steward'].includes(role)) throw new Error('роль: review, approve, steward или report');
  const project = option('--project') || env.CI_PROJECT_ID;
  if (role === 'report') {
    if (!project) throw new Error('нужен --project (или CI_PROJECT_ID)');
    const gitlab = createGitlab({ url: env.GITLAB_URL || env.CI_SERVER_URL, token: env.GITLAB_TOKEN });
    const days = Number(option('--days') || 30);
    const entries = await collectDecisions(gitlab, project, { days, botUsername: env.MAI_SHIP_BOT_USERNAME || 'mai-ship-approver' });
    const report = agreementReport(entries);
    const flow = flowMetrics(entries);
    console.log(args.includes('--json') ? JSON.stringify({ ...report, flow }, null, 2) : `${formatReport(report, { days })}

${formatFlow(flow)}`);
    return 0;
  }
  const iid = option('--mr') || env.CI_MERGE_REQUEST_IID;
  if (!project || !iid) throw new Error('нужны --project и --mr (или CI_PROJECT_ID и CI_MERGE_REQUEST_IID)');
  const gitlab = createGitlab({ url: env.GITLAB_URL || env.CI_SERVER_URL, token: env.GITLAB_TOKEN });
  const modelId = (value) => (String(value || '').includes('/') ? String(value).slice(String(value).indexOf('/') + 1) : String(value || ''));
  if (role === 'steward') {
    const stewardToken = env.MAI_SHIP_STEWARD_TOKEN || env.GITLAB_TOKEN;
    const stewardGitlab = createGitlab({ url: env.GITLAB_URL || env.CI_SERVER_URL, token: stewardToken });
    const cwd = env.CI_PROJECT_DIR || process.cwd();
    const git = (gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8' });
    const push = (branch) => {
      const server = new URL(env.CI_SERVER_URL || env.GITLAB_URL);
      const repoPath = env.CI_MERGE_REQUEST_SOURCE_PROJECT_PATH || env.CI_PROJECT_PATH;
      if (!repoPath) throw new Error('не известен путь проекта (CI_PROJECT_PATH)');
      // Токен — через credential helper из переменной окружения: в аргументах git и в тексте
      // ошибки его нет, поэтому он не попадёт в лог CI.
      const remote = `${server.protocol}//${server.host}/${repoPath}.git`;
      const helper = '!f() { echo username=oauth2; echo "password=$MAI_SHIP_PUSH_TOKEN"; }; f';
      try {
        execFileSync('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'push', remote, `HEAD:refs/heads/${branch}`], {
          cwd,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, MAI_SHIP_PUSH_TOKEN: stewardToken, GIT_TERMINAL_PROMPT: '0' },
        });
      } catch (err) {
        throw new Error(`git push в ${branch} не удался: ${String(err.stderr || '').trim().slice(0, 300)}`);
      }
    };
    const runAgentTask = async (task, { rules }) => {
      const { runAgent } = await import('../electron/lib/agent.js');
      const mr = await stewardGitlab.getMr(project, iid);
      const shipCfg = (await import('yaml')).parse((await stewardGitlab.getFile(project, '.mai-code/ship.yaml', mr.target_branch)) || '') || {};
      const model = modelId(shipCfg.providers?.steward || shipCfg.providers?.executor);
      if (!env.SHIP_STEWARD_BASE_URL || !env.SHIP_STEWARD_API_KEY || !model) throw new Error('модель steward не настроена: providers.steward, SHIP_STEWARD_BASE_URL, SHIP_STEWARD_API_KEY');
      const runner = createAgentRunner({
        runAgent,
        provider: { baseURL: env.SHIP_STEWARD_BASE_URL, apiKey: env.SHIP_STEWARD_API_KEY, name: 'steward' },
        model,
        projectDir: cwd,
        maxIterations: Number(shipCfg.steward?.max_iterations || 30),
        log: (name) => console.log(`  · ${name}`),
      });
      return runner(task, { rules });
    };
    const mrForModel = await stewardGitlab.getMr(project, iid);
    const cfg = (await import('yaml')).parse((await stewardGitlab.getFile(project, '.mai-code/ship.yaml', mrForModel.target_branch)) || '') || {};
    const out = await runSteward({ gitlab: stewardGitlab, project, iid, git, runAgentTask, push, model: String(cfg.providers?.steward || cfg.providers?.executor || ''), env, dryRun: args.includes('--dry-run') });
    for (const r of out.replies || []) console.log(`MAI Ship steward: ${r}`);
    console.log(`MAI Ship steward: ${out.status}${out.reason ? ` — ${out.reason}` : ''}${out.sha ? ` — коммит ${out.sha.slice(0, 12)}` : ''}`);
    if (out.task && args.includes('--dry-run')) console.log(`\n${out.task}`);
    return 0;
  }
  if (role === 'review') {
    const makeModel = (shipCfg, meter) => {
      const model = modelId(shipCfg.providers?.reviewer);
      if (!env.SHIP_REVIEWER_BASE_URL || !env.SHIP_REVIEWER_API_KEY || !model) return null;
      const client = new OpenAI({ baseURL: env.SHIP_REVIEWER_BASE_URL, apiKey: env.SHIP_REVIEWER_API_KEY, maxRetries: 2 });
      return createReviewModel({ client: meter ? meter.wrap(client, model) : client, model });
    };
    const out = await runReview({ gitlab, project, iid, makeModel, env, dryRun: args.includes('--dry-run') });
    if (out.status !== 'done' && out.status !== 'planned') {
      console.log(`MAI Ship ревью: ${out.status === 'error' ? 'ошибка' : 'пропуск'} — ${out.reason}`);
      return out.status === 'error' ? 1 : 0;
    }
    console.log(`MAI Ship ревью: находок ${out.findings.length} (blocking: ${out.findings.filter((f) => f.severity === 'blocking').length}), отброшено проверкой ${out.dropped}`);
    if (out.summary) console.log(`
${out.summary}`);
    return 0;
  }
  const makeClassifier = (shipCfg, meter) => {
    const approver = String(shipCfg.providers?.approver || '');
    const model = approver.includes('/') ? approver.slice(approver.indexOf('/') + 1) : approver;
    if (!env.SHIP_APPROVER_BASE_URL || !env.SHIP_APPROVER_API_KEY || !model) return null; // без модели классификаторы «не посчитаны» → человек
    const client = new OpenAI({ baseURL: env.SHIP_APPROVER_BASE_URL, apiKey: env.SHIP_APPROVER_API_KEY, maxRetries: 2 });
    return createClassifier({ client: meter ? meter.wrap(client, model) : client, model });
  };
  const out = await runApprove({ gitlab, project, iid, makeClassifier, env, dryRun: args.includes('--dry-run') });
  if (out.status === 'skipped') {
    console.log(`MAI Ship approver: пропуск — ${out.reason}`);
    return 0;
  }
  const r = out.result;
  console.log(`MAI Ship approver: ${r.decision} (${r.action}) — правило ${r.rule}${r.reason && r.reason !== `правило ${r.rule}` ? `: ${r.reason}` : ""}`);
  // JSONL-журнал для артефакта CI (E3.F6).
  const journal = option('--journal');
  if (journal && out.record) fs.appendFileSync(journal, `${JSON.stringify(out.record)}\n`);
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
    console.error(`MAI Ship ${role || ""}: ${err.message}`);
    process.exit(1);
  },
);
