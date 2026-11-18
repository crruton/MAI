# Design: PolicyEngine

Решение описано в [ADR 0027](../../../docs/adr/0027-policy-engine.md).

```
tool_call → toolEntry (класс) → precheck → evaluate → [approve] → run → audit
```

- `toolEntry(schema, meta)` — описание инструмента для цикла: источник, класс, `run`, `precheck`.
- `evaluate({ tool, cls, subject, mode, rules, guardrails, role })` — чистая функция.
- `runToolCall(...)` — единственное место, где вызывается `approve`.
- `policyFor(sessionId)` в `main.js` читает режим и правила на каждый вызов.
- `saveSession` не перезаписывает `permissionMode` и `permissionRules`: их
  меняют только свои функции, а прогон держит устаревшую копию сессии.
