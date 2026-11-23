// Песочница (A2.5): из electron доступны только contextBridge, ipcRenderer, webUtils и подобные.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    exportFile: () => invoke('runtimes:export'),
    importFile: (replace = false) => invoke('runtimes:import', { replace }),
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
  ocr: {
    status: (payload) => invoke('ocr:status', payload),
    recognize: (payload) => invoke('ocr:recognize', payload),
  },
  // Слэш-команды и @файл (CC7.7–CC7.9).
  commands: {
    list: (projectDir) => invoke('commands:list', projectDir),
    expand: (projectDir, name, args) => invoke('commands:expand', { projectDir, name, args }),
  },
  files: {
    search: (projectDir, query) => invoke('files:search', { projectDir, query }),
  },
  // Доверие к папке проекта (ADR 0028).
  trust: {
    get: (projectDir) => invoke('trust:get', projectDir),
    set: (projectDir, state) => invoke('trust:set', { projectDir, state }),
    list: () => invoke('trust:list'),
    remove: (projectDir) => invoke('trust:remove', projectDir),
  },
  permissions: {
    modes: (sessionId) => invoke('permissions:modes', sessionId),
    set: (mode, sessionId) => invoke('permissions:set', { mode, sessionId }),
    rules: (payload) => invoke('permissions:rules', payload),
    explain: (payload) => invoke('permissions:explain', payload),
    audit: (limit) => invoke('permissions:audit', { limit }),
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
  // Ветка git для статусной строки (CC7.12).
  notify: {
    test: (channelId) => invoke('notify:test', channelId),
  },
  git: {
    branch: (projectDir) => invoke('git:branch', projectDir),
    worktrees: (projectDir) => invoke('worktree:list', projectDir),
    createWorktree: (projectDir, name) => invoke('worktree:create', { projectDir, name }),
    openWorktree: (dir) => invoke('worktree:open', dir),
    removeWorktree: (repo, dir) => invoke('worktree:remove', { repo, dir }),
  },
  sessions: {
    list: (options) => invoke('sessions:list', options),
    get: (id) => invoke('sessions:get', id),
    create: (data) => invoke('sessions:create', data),
    remove: (id) => invoke('sessions:delete', id),
    rename: (id, title) => invoke('sessions:rename', { id, title }),
    fork: (id, upTo = null) => invoke('sessions:fork', { id, upTo }),
    exportFile: (id) => invoke('sessions:exportFile', id),
    importFile: () => invoke('sessions:importFile'),
    shell: (sessionId, command) => invoke('shell:direct', { sessionId, command }),
  },
  chat: {
    start: (payload) => invoke('chat:start', payload),
    stop: () => invoke('chat:stop'),
    // extra: { remember: 'session'|'global', rules: [...], feedback: '...' } (ADR 0027)
    approve: (id, allow, extra = {}) => invoke('chat:approval', { id, allow, ...extra }),
    // Ответ на ask_user или карточку плана exit_plan (CC1.7, CC1.8).
    answer: (id, answer) => invoke('chat:answer', { id, answer }),
    // Очередь сообщений во время работы агента (CC7.5).
    queue: (text, displayText) => invoke('chat:queue', { text, displayText }),
    unqueue: (id) => invoke('chat:unqueue', { id }),
    // Контекст и компакция (CC5.2, CC5.3).
    compact: (sessionId, instructions) => invoke('chat:compact', { sessionId, instructions }),
    // Хуки (ADR 0035).
    hooks: (projectDir) => invoke('hooks:list', projectDir),
    // Типы субагентов (ADR 0036).
    agents: (projectDir) => invoke('agents:defs', projectDir),
    // Пакеты плагинов (ADR 0037).
    packages: (projectDir) => invoke('packages:list', projectDir),
    installPackage: (from, replace = false) => invoke('packages:install', { from, replace }),
    marketplaces: () => invoke('marketplace:list'),
    trash: () => invoke('trash:list'),
    projects: () => invoke('projects:list'),
    pickProjectDir: () => invoke('projects:pickDir'),
    saveProject: (project) => invoke('projects:save', project),
    removeProject: (id) => invoke('projects:remove', id),
    activateProject: (id) => invoke('projects:activate', id),
    schedule: () => invoke('schedule:list'),
    scheduleRuns: (id) => invoke('schedule:runs', id),
    saveSchedule: (task) => invoke('schedule:save', task),
    removeSchedule: (id) => invoke('schedule:remove', id),
    runSchedule: (id) => invoke('schedule:runNow', id),
    results: (sessionId) => invoke('results:list', sessionId),
    previewResult: (sessionId, file) => invoke('results:preview', { sessionId, file }),
    openResult: (sessionId, file) => invoke('results:open', { sessionId, file }),
    showResult: (sessionId, file) => invoke('results:show', { sessionId, file }),
    dirs: (sessionId) => invoke('session:dirs', sessionId),
    caps: (model) => invoke('models:caps', model),
    kind: (sessionId) => invoke('session:kind', sessionId),
    setKind: (sessionId, kind) => invoke('session:setKind', { sessionId, kind }),
    addDir: (sessionId) => invoke('session:addDir', sessionId),
    removeDir: (sessionId, dir) => invoke('session:removeDir', { sessionId, dir }),
    restoreTrash: (id, overwrite = false) => invoke('trash:restore', { id, overwrite }),
    purgeTrash: (payload) => invoke('trash:purge', payload),
    addMarketplace: (url, name) => invoke('marketplace:add', { url, name }),
    removeMarketplace: (name) => invoke('marketplace:remove', name),
    refreshMarketplaces: () => invoke('marketplace:refresh'),
    installFromMarketplace: (marketplace, name, replace = false) => invoke('marketplace:install', { marketplace, name, replace }),
    uninstallPackage: (name) => invoke('packages:uninstall', name),
    togglePackage: (name, enabled) => invoke('packages:toggle', { name, enabled }),
    roles: () => invoke('roles:list'),
    installRole: (id) => invoke('roles:install', id),
    context: (payload) => invoke('context:stats', payload),
    // Чекпоинты и откат (CC6.1).
    checkpoints: (sessionId) => invoke('checkpoints:turns', sessionId),
    rewindPlan: (sessionId, turn) => invoke('checkpoints:plan', { sessionId, turn }),
    rewind: (sessionId, turn, mode) => invoke('checkpoints:rewind', { sessionId, turn, mode }),
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
    write: (file, content, projectDir) => invoke('memory:write', { file, content, projectDir }),
    save: (payload) => invoke('memory:save', payload),
    // `# текст` в поле ввода → строка в память (CC4.3).
    append: (payload) => invoke('memory:append', payload),
    version: (payload) => invoke('memory:version', payload),
    restore: (payload) => invoke('memory:restore', payload),
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
    remove: (name, projectDir) => invoke('mcp:remove', name, projectDir),
    scopes: (projectDir) => invoke('mcp:scopes', projectDir),
    saveLocal: (payload) => invoke('mcp:saveLocal', payload),
    login: (name, projectDir) => invoke('mcp:login', name, projectDir),
    connectors: () => invoke('connectors:list'),
    resources: () => invoke('mcp:resources'),
    localConnectors: () => invoke('connectors:local'),
    toggleLocalConnector: (id, enabled) => invoke('connectors:localToggle', { id, enabled }),
    addConnector: (id, token) => invoke('connectors:add', { id, token }),
    removeConnector: (id) => invoke('connectors:remove', id),
    logout: (name) => invoke('mcp:logout', name),
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
  export: {
    message: (payload) => invoke('export:message', payload),
    chat: (payload) => invoke('export:chat', payload),
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
    diagramApply: (payload) => invoke('boards:diagramApply', payload),
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
    syncStatus: (payload) => invoke('infra:syncStatus', payload),
    syncNow: (payload) => invoke('infra:syncNow', payload),
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
    // navigator.clipboard на file:// в Electron часто запрещён, а модуля clipboard
    // в песочнице нет — пишем через main.
    writeText: (text) => invoke('app:clipboard', String(text ?? '')),
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
