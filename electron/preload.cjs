const { contextBridge, ipcRenderer } = require('electron');

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
  openPath: (target) => invoke('app:openPath', target),
  openExternal: (url) => invoke('app:openExternal', url),
  showItem: (target) => invoke('app:showItem', target),
  dataDir: () => invoke('app:dataDir'),
});
