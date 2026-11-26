/**
 * MAI Ship: политика апрува (ADR 0109).
 *
 * `evaluate(policy, facts)` — чистая функция без модели и сети: одинаковый вход даёт
 * одинаковое решение. Классификаторы считаются заранее и приходят в `facts.classifiers`
 * как `{ имя: boolean }`. Политика приходит уже разобранной из `.mai-code/approval-policy.yaml`
 * target branch — разбор YAML здесь не делается.
 */
import { globToRegExp } from '../tools/fs.js';
import { checkIndependence } from '../model-families.js';

export const DECISIONS = ['approve', 'require_human', 'block'];
const STRICTNESS = { approve: 0, require_human: 1, block: 2 };

/** Файлы, которые MR не может изменить без человека (ADR 0109, п. 2). Политика это не отменяет. */
export const SELF_PROTECTED = [
  '.mai-code/ship.yaml',
  '.mai-code/approval-policy.yaml',
  '.gitlab-ci.yml',
  '**/.gitlab-ci.yml',
  'CODEOWNERS',
  '.gitlab/CODEOWNERS',
  'docs/CODEOWNERS',
  'ci/mai-ship.gitlab-ci.yml',
];

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOP_KEYS = new Set(['version', 'mode', 'enforce_classes', 'gates', 'rules', 'classifiers', 'default', 'human']);
const GATE_KEYS = new Set(['pipeline', 'max_blocking_findings', 'max_changed_lines', 'max_changed_files', 'require_not_draft']);
const MATCH_KEYS = new Set(['paths', 'any_path', 'labels', 'author', 'max_changed_lines']);
const HUMAN_KEYS = new Set(['min_approvals', 'min_role', 'use_codeowners']);

/** Одинаково на Windows и в Linux-CI: регистр путей значим, кроме защищённых файлов. */
function pathRe(glob, { ignoreCase = false } = {}) {
  return new RegExp(globToRegExp(glob).source, ignoreCase ? 'i' : '');
}

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

const isPositiveInt = (v) => Number.isInteger(v) && v >= 0;
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0);

/** Проверка политики. Повторяет `schemas/approval-policy.schema.json`. @returns {string[]} ошибки */
export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['политика — не объект'];
  for (const key of Object.keys(policy)) if (!TOP_KEYS.has(key)) errors.push(`неизвестный ключ: ${key}`);
  if (policy.version !== 1) errors.push('version должен быть 1');
  if (!['observe', 'enforce'].includes(policy.mode)) errors.push('mode: observe или enforce');
  if (!['require_human', 'block'].includes(policy.default)) errors.push('default: require_human или block');
  if (policy.enforce_classes !== undefined && !(Array.isArray(policy.enforce_classes) && policy.enforce_classes.every((s) => typeof s === 'string'))) {
    errors.push('enforce_classes — список имён правил');
  }
  const gates = policy.gates;
  if (gates !== undefined) {
    if (!gates || typeof gates !== 'object') errors.push('gates — объект');
    else {
      for (const key of Object.keys(gates)) if (!GATE_KEYS.has(key)) errors.push(`gates: неизвестный ключ ${key}`);
      if (gates.pipeline !== undefined && !['success', 'any'].includes(gates.pipeline)) errors.push('gates.pipeline: success или any');
      for (const key of ['max_blocking_findings', 'max_changed_lines', 'max_changed_files']) {
        if (gates[key] !== undefined && !isPositiveInt(gates[key])) errors.push(`gates.${key} — целое ≥ 0`);
      }
      if (gates.require_not_draft !== undefined && typeof gates.require_not_draft !== 'boolean') errors.push('gates.require_not_draft — boolean');
    }
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) errors.push('rules — непустой список');
  const names = new Set();
  for (const [i, rule] of (Array.isArray(policy.rules) ? policy.rules : []).entries()) {
    const at = `rules[${i}]`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${at} — объект`);
      continue;
    }
    if (!NAME_RE.test(rule.name || '')) errors.push(`${at}.name: латиница, цифры, дефис`);
    else if (names.has(rule.name)) errors.push(`${at}.name повторяется: ${rule.name}`);
    else names.add(rule.name);
    if (!DECISIONS.includes(rule.decision)) errors.push(`${at}.decision: approve, require_human или block`);
    const match = rule.match;
    if (!match || typeof match !== 'object' || Object.keys(match).length === 0) {
      errors.push(`${at}.match — непустой объект`);
      continue;
    }
    for (const key of Object.keys(match)) if (!MATCH_KEYS.has(key)) errors.push(`${at}.match: неизвестный ключ ${key}`);
    for (const key of ['paths', 'any_path', 'labels']) if (match[key] !== undefined && !isStringList(match[key])) errors.push(`${at}.match.${key} — непустой список строк`);
    if (match.author !== undefined && !['human', 'agent', 'any'].includes(match.author)) errors.push(`${at}.match.author: human, agent или any`);
    if (match.max_changed_lines !== undefined && !(Number.isInteger(match.max_changed_lines) && match.max_changed_lines >= 1)) errors.push(`${at}.match.max_changed_lines — целое ≥ 1`);
  }
  for (const [i, c] of (Array.isArray(policy.classifiers) ? policy.classifiers : []).entries()) {
    const at = `classifiers[${i}]`;
    if (!c || !NAME_RE.test(c.name || '')) errors.push(`${at}.name: латиница, цифры, дефис`);
    if (!c || typeof c.question !== 'string' || c.question.length < 10) errors.push(`${at}.question — вопрос да/нет`);
    if (!c || !['require_human', 'block'].includes(c.when_true)) errors.push(`${at}.when_true: require_human или block`);
  }
  if (policy.classifiers !== undefined && !Array.isArray(policy.classifiers)) errors.push('classifiers — список');
  if (policy.human !== undefined) {
    for (const key of Object.keys(policy.human || {})) if (!HUMAN_KEYS.has(key)) errors.push(`human: неизвестный ключ ${key}`);
  }
  return errors;
}

/** Совпадает ли правило с MR. Все условия `match` должны выполниться. */
export function ruleMatches(rule, facts) {
  const files = (facts.files || []).map(normalizePath);
  const match = rule.match || {};
  if (match.paths) {
    const res = match.paths.map((g) => pathRe(g));
    if (files.length === 0 || !files.every((f) => res.some((re) => re.test(f)))) return false;
  }
  if (match.any_path) {
    const res = match.any_path.map((g) => pathRe(g));
    if (!files.some((f) => res.some((re) => re.test(f)))) return false;
  }
  if (match.labels) {
    const labels = new Set(facts.labels || []);
    if (!match.labels.every((l) => labels.has(l))) return false;
  }
  if (match.author && match.author !== 'any') {
    if ((facts.authorIsAgent ? 'agent' : 'human') !== match.author) return false;
  }
  if (match.max_changed_lines !== undefined) {
    if (!Number.isFinite(facts.changedLines) || facts.changedLines > match.max_changed_lines) return false;
  }
  return true;
}

function stricter(a, b) {
  return STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a;
}

function result(decision, rule, reason, extra = {}) {
  return { decision, rule, reason, ...extra };
}

/**
 * Решение по MR.
 *
 * @param {object} policy  разобранная политика из target branch
 * @param {object} facts   { files, changedLines, labels, authorIsAgent, draft, pipeline,
 *                           blockingFindings, classifiers, models: { approver, reviewer, executors },
 *                           families, cost: { mr, month }, budget: { per_mr_usd, monthly_usd }, disabled }
 * @returns {{ decision, rule, reason, action, trace }}
 *   action: approve — поставить approve; comment — только комментарий (observe);
 *           needs_human — метка ship::needs-human; block — метка ship::blocked; skip — Ship выключен.
 */
export function evaluate(policy, facts = {}) {
  const trace = [];
  const finish = (r) => ({ ...r, action: actionFor(policy, r), trace });

  if (facts.disabled) return { decision: 'require_human', rule: 'disabled', reason: 'Ship выключен', action: 'skip', trace };

  const errors = validatePolicy(policy);
  if (errors.length) return finish(result('block', 'policy-invalid', `политика не разобрана: ${errors.slice(0, 3).join('; ')}`));

  const files = (facts.files || []).map(normalizePath);
  const protectedRes = SELF_PROTECTED.map((g) => pathRe(g, { ignoreCase: true }));
  const touched = files.filter((f) => protectedRes.some((re) => re.test(f)));
  if (touched.length) {
    trace.push(`self-protection: ${touched.join(', ')}`);
    return finish(result('require_human', 'self-protection', `MR меняет конфигурацию Ship или CI: ${touched[0]}`));
  }

  const budget = facts.budget || {};
  const cost = facts.cost || {};
  if (budget.per_mr_usd && cost.mr > budget.per_mr_usd) return finish(result('require_human', 'budget', `бюджет MR исчерпан: $${cost.mr} из $${budget.per_mr_usd}`));
  if (budget.monthly_usd && cost.month > budget.monthly_usd) return finish(result('require_human', 'budget', `месячный бюджет исчерпан: $${cost.month} из $${budget.monthly_usd}`));

  const gates = { pipeline: 'success', max_blocking_findings: 0, require_not_draft: true, ...(policy.gates || {}) };
  if (gates.require_not_draft && facts.draft) return finish(result('block', 'gate-draft', 'MR в статусе Draft'));
  if (gates.pipeline === 'success' && facts.pipeline !== 'success') return finish(result('block', 'gate-pipeline', `pipeline не зелёный: ${facts.pipeline || 'нет'}`));
  if ((facts.blockingFindings || 0) > gates.max_blocking_findings) return finish(result('block', 'gate-findings', `blocking-находок ревью: ${facts.blockingFindings}`));
  if (gates.max_changed_files && files.length > gates.max_changed_files) return finish(result('require_human', 'gate-size', `изменено файлов: ${files.length} > ${gates.max_changed_files}`));
  if (gates.max_changed_lines && facts.changedLines > gates.max_changed_lines) return finish(result('require_human', 'gate-size', `изменено строк: ${facts.changedLines} > ${gates.max_changed_lines}`));
  trace.push('gates: ok');

  let current = null;
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, facts)) continue;
    trace.push(`rule ${rule.name}: ${rule.decision}`);
    const candidate = result(rule.decision, rule.name, rule.reason || `правило ${rule.name}`);
    current = current ? stricter(current, candidate) : candidate;
  }
  if (!current) {
    trace.push(`default: ${policy.default}`);
    current = result(policy.default, 'default', 'ни одно правило не совпало');
  }

  const answers = facts.classifiers || {};
  for (const c of policy.classifiers || []) {
    const value = answers[c.name];
    if (value === undefined || value === null) {
      trace.push(`classifier ${c.name}: нет ответа`);
      current = stricter(current, result('require_human', c.name, `классификатор ${c.name} не посчитан`));
    } else if (value === true) {
      trace.push(`classifier ${c.name}: true → ${c.when_true}`);
      current = stricter(current, result(c.when_true, c.name, c.question));
    } else {
      trace.push(`classifier ${c.name}: false`);
    }
  }

  if (current.decision === 'approve') {
    const models = facts.models || {};
    const independence = checkIndependence({
      approver: models.approver,
      reviewer: models.reviewer,
      executors: models.executors || [],
      authorIsAgent: Boolean(facts.authorIsAgent),
      families: facts.families,
    });
    if (!independence.ok) {
      trace.push(`independence: ${independence.reason}`);
      current = result('require_human', 'independence', independence.reason);
    }
  }
  return finish(current);
}

/** Что делает бот при решении: observe никогда не ставит approve; enforce — только классам из enforce_classes. */
export function actionFor(policy, { decision, rule }) {
  if (decision === 'block') return 'block';
  if (decision === 'require_human') return 'needs_human';
  if (!policy || policy.mode !== 'enforce') return 'comment';
  return (policy.enforce_classes || []).includes(rule) ? 'approve' : 'needs_human';
}
