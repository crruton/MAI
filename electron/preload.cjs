const { contextBridge, ipcRenderer, clipboard } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mai', {
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  models: (force) => invoke('models:list', force),
  providers: {
    list: () => invoke('providers:list'),
    save: (id, provider) => invoke('providers:save', { id, provider }),
    remove: (id) => invoke('providers:remove', id),
    test: (id) => invoke('providers:test', id),
  },
  runtimes: {
    list: () => invoke('runtimes:list'),
    save: (runtimes) => invoke('runtimes:save', runtimes),
    run: (payload) => invoke('runtimes:run', payload),
    stop: () => invoke('runtimes:stop'),
  },
  project: {
    pick: () => invoke('project:pick'),
  },
  sessions: {
    list: () => invoke('sessions:list'),
    get: (id) => invoke('sessions:get', id),
    create: (data) => invoke('sessions:create', data),
    remove: (id) => invoke('sessions:delete', id),
  },
  chat: {
    start: (payload) => invoke('chat:start', payload),
    stop: () => invoke('chat:stop'),
    approve: (id, allow) => invoke('chat:approval', { id, allow }),
    onEvent: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on('chat:event', listener);
      return () => ipcRenderer.removeListener('chat:event', listener);
    },
  },
  agents: {
    read: (projectDir) => invoke('agents:read', projectDir),
    write: (file, content) => invoke('agents:write', { file, content }),
  },
  skills: {
    list: (projectDir) => invoke('skills:list', projectDir),
    create: (data) => invoke('skills:create', data),
    remove: (file) => invoke('skills:delete', file),
  },
  mcp: {
    status: () => invoke('mcp:status'),
    sync: () => invoke('mcp:sync'),
    connect: (name) => invoke('mcp:connect', name),
    remove: (name) => invoke('mcp:remove', name),
  },
  plugins: {
    list: (projectDir) => invoke('plugins:list', projectDir),
    openFolder: (projectDir) => invoke('plugins:openFolder', projectDir),
    createExample: (projectDir) => invoke('plugins:createExample', projectDir),
  },
  artifacts: {
    list: (payload) => invoke('artifacts:list', payload),
    get: (payload) => invoke('artifacts:get', payload),
    save: (payload) => invoke('artifacts:save', payload),
    history: (payload) => invoke('artifacts:history', payload),
    version: (payload) => invoke('artifacts:version', payload),
    restore: (payload) => invoke('artifacts:restore', payload),
    remove: (payload) => invoke('artifacts:delete', payload),
    diff: (payload) => invoke('artifacts:diff', payload),
    search: (payload) => invoke('artifacts:search', payload),
    import: (payload) => invoke('artifacts:import', payload),
    stats: (payload) => invoke('artifacts:stats', payload),
    openFolder: (payload) => invoke('artifacts:openFolder', payload),
    export: (payload) => invoke('artifacts:export', payload),
    applyToFile: (payload) => invoke('artifacts:applyToFile', payload),
  },
  boards: {
    open: (board, focus) => invoke('boards:open', { board, focus }),
    load: (payload) => invoke('boards:load', payload),
    save: (payload) => invoke('boards:save', payload),
    views: (payload) => invoke('boards:views', payload),
    baseline: (payload) => invoke('boards:baseline', payload),
    scan: (payload) => invoke('boards:scan', payload),
    git: (payload) => invoke('boards:git', payload),
    diff: (payload) => invoke('boards:diff', payload),
    stageRun: (payload) => invoke('boards:stageRun', payload),
    stageStop: () => invoke('boards:stageStop'),
    runtimeStatus: () => invoke('boards:runtimeStatus'),
    errors: () => invoke('boards:errors'),
    clearErrors: () => invoke('boards:clearErrors'),
    correction: (payload) => invoke('boards:correction', payload),
    correctionStop: () => invoke('boards:correctionStop'),
    exportView: (payload) => invoke('boards:exportView', payload),
    saveView: (payload) => invoke('boards:saveView', payload),
    onEvent: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on('board:event', listener);
      return () => ipcRenderer.removeListener('board:event', listener);
    },
    onFocus: (handler) => {
      const listener = (_event, data) => handler(data);
      ipcRenderer.on('board:focus', listener);
      return () => ipcRenderer.removeListener('board:focus', listener);
    },
  },
  infra: {
    status: () => invoke('infra:status'),
    sync: (payload) => invoke('infra:sync', payload),
    pushSecrets: () => invoke('infra:pushSecrets'),
    pullSecrets: () => invoke('infra:pullSecrets'),
    search: (payload) => invoke('infra:search', payload),
    upload: (payload) => invoke('infra:upload', payload),
    download: (payload) => invoke('infra:download', payload),
  },
  repowise: {
    status: (payload) => invoke('repowise:status', payload),
    install: () => invoke('repowise:install'),
    init: (payload) => invoke('repowise:init', payload),
    update: (payload) => invoke('repowise:update', payload),
    doctor: (payload) => invoke('repowise:doctor', payload),
    ask: (payload) => invoke('repowise:ask', payload),
    search: (payload) => invoke('repowise:search', payload),
    context: (payload) => invoke('repowise:context', payload),
    risk: (payload) => invoke('repowise:risk', payload),
    distill: (payload) => invoke('repowise:distill', payload),
    connectMcp: (payload) => invoke('repowise:connectMcp', payload),
    serve: (payload) => invoke('repowise:serve', payload),
    stopServe: (payload) => invoke('repowise:stopServe', payload),
  },
  clipboard: {
    // navigator.clipboard на file:// в Electron часто запрещён — используем нативный модуль.
    writeText: (text) => {
      clipboard.writeText(String(text ?? ''));
      return true;
    },
  },
  openPath: (target) => invoke('app:openPath', target),
  openExternal: (url) => invoke('app:openExternal', url),
  showItem: (target) => invoke('app:showItem', target),
  focusMain: () => invoke('app:focusMain'),
  dataDir: () => invoke('app:dataDir'),
});
