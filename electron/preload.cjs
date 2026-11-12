const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mai', {
  settings: {
    get: () => invoke('settings:get'),
    save: (patch) => invoke('settings:save', patch),
  },
  telemetry: {
    status: () => invoke('telemetry:status'),
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
    probe: (payload) => invoke('runtimes:probe', payload),
    run: (payload) => invoke('runtimes:run', payload),
    runMany: (payload) => invoke('runtimes:runMany', payload),
    stop: () => invoke('runtimes:stop'),
  },
  project: {
    pick: () => invoke('project:pick'),
  },
  attachments: {
    add: (payload) => invoke('attachments:add', payload),
    addImage: (payload) => invoke('attachments:addImage', payload),
    pick: (payload) => invoke('attachments:pick', payload),
    remove: (payload) => invoke('attachments:remove', payload),
    open: (payload) => invoke('attachments:open', payload),
  },
  permissions: {
    modes: (sessionId) => invoke('permissions:modes', sessionId),
    set: (mode, sessionId) => invoke('permissions:set', { mode, sessionId }),
  },
  workspace: {
    root: () => invoke('workspace:root'),
    list: () => invoke('workspace:list'),
    create: (payload) => invoke('workspace:create', payload),
  },
  auth: {
    status: () => invoke('auth:status'),
    configure: (payload) => invoke('auth:configure', payload),
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
    setRole: (role) => invoke('auth:setRole', role),
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
  memory: {
    read: (projectDir) => invoke('memory:read', projectDir),
    write: (file, content) => invoke('memory:write', { file, content }),
  },
  skills: {
    list: (projectDir) => invoke('skills:list', projectDir),
    create: (data) => invoke('skills:create', data),
    remove: (file) => invoke('skills:delete', file),
  },
  docs: {
    list: () => invoke('docs:list'),
    read: (relative) => invoke('docs:read', relative),
    search: (query) => invoke('docs:search', query),
  },
  multica: {
    status: () => invoke('multica:status'),
    install: () => invoke('multica:install'),
    auth: () => invoke('multica:auth'),
    issues: (limit) => invoke('multica:issues', limit),
    syncDocs: (projectDir) => invoke('multica:syncDocs', projectDir),
  },
  sandbox: {
    status: () => invoke('sandbox:status'),
    list: () => invoke('sandbox:list'),
    start: (payload) => invoke('sandbox:start', payload),
    stop: (payload) => invoke('sandbox:stop', payload),
    logs: (payload) => invoke('sandbox:logs', payload),
    exec: (payload) => invoke('sandbox:exec', payload),
  },
  mcp: {
    status: () => invoke('mcp:status'),
    configs: (projectDir) => invoke('mcp:configs', projectDir),
    sync: (projectDir) => invoke('mcp:sync', projectDir),
    connect: (name, projectDir) => invoke('mcp:connect', name, projectDir),
    remove: (name) => invoke('mcp:remove', name),
  },
  mas: {
    status: () => invoke('mas:status'),
    config: () => invoke('mas:config'),
    transcribe: (payload) => invoke('mas:transcribe', payload),
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
    exportDiagram: (payload) => invoke('boards:exportDiagram', payload),
    rasterize: (payload) => invoke('boards:rasterize', payload),
    diagramChat: (payload) => invoke('boards:diagramChat', payload),
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
  // В Electron 38 у File больше нет свойства path: путь даёт только webUtils.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  openExternal: (url) => invoke('app:openExternal', url),
  showItem: (target) => invoke('app:showItem', target),
  focusMain: () => invoke('app:focusMain'),
  dataDir: () => invoke('app:dataDir'),
});
