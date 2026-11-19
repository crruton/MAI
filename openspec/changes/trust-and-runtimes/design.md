# Design

Решения описаны в [ADR 0028](../../../docs/adr/0028-doverie-k-papke-i-matrica-ipc.md)
и [ADR 0029](../../../docs/adr/0029-rezhim-razreshenij-dlya-cli.md).

- `trust.js`, `ipc-permissions.js`, `project-lock.js`, `vision.js`, `usage.js` не
  зависят от Electron и проверяются обычным node.
- `guardIpc` вызывается до первого `ipcMain.handle` в `main.js`.
- Доверие проверяется в main: `needTrust`, `isTrusted`, `loadPluginsFor`, `mcpConfigs`.
