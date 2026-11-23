/** Дубли навыков (CC10.5, ADR 0080). Модуль не зависит от Electron. */

/**
 * Один навык на имя (CC10.5, ADR 0080): первый по приоритету — проект, пакеты,
 * глобальные. Остальные — в `shadowed` (откуда ещё есть навык с этим именем).
 */
export function uniqueSkills(skills) {
  const byName = new Map();
  for (const skill of skills) {
    const key = String(skill.name).toLowerCase();
    const first = byName.get(key);
    if (first) first.shadowed = [...(first.shadowed || []), skill.scope];
    else byName.set(key, { ...skill });
  }
  return [...byName.values()];
}

/**
 * Конфликты имён при установке (CC10.5): навыки `names` из источника `scope`
 * против уже установленных. Возвращает строки-предупреждения.
 */
export function skillConflicts(existing, names, scope) {
  const rank = (s) => (s === 'project' ? 0 : String(s).startsWith('package:') ? 1 : 2);
  const warnings = [];
  for (const name of names) {
    const other = existing.find((s) => s.name.toLowerCase() === String(name).toLowerCase() && s.scope !== scope);
    if (!other) continue;
    const wins = rank(other.scope) <= rank(scope) ? other.scope : scope;
    warnings.push(`Навык «${name}» уже есть (${other.scope}) — работать будет навык из «${wins}»: у проекта приоритет над пакетами, у пакетов — над глобальными.`);
  }
  return warnings;
}
