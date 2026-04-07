const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tcm', {
    getState: () => ipcRenderer.invoke('tcm:get-state'),
    consumeToken: (token) => ipcRenderer.invoke('tcm:consume-token', token),
    reissue: (email) => ipcRenderer.invoke('tcm:reissue', email),
    logout: () => ipcRenderer.invoke('tcm:logout'),
    resyncMail: () => ipcRenderer.invoke('tcm:resync-mail'),
    loginFlowStart: (serverUrl) => ipcRenderer.invoke('tcm:login-flow-start', serverUrl),
    loginFlowPoll: (opts) => ipcRenderer.invoke('tcm:login-flow-poll', opts),
    manualLogin: (creds) => ipcRenderer.invoke('tcm:manual-login', creds),
    onSetupToken: (cb) => {
        ipcRenderer.removeAllListeners('tcm:setup-token');
        ipcRenderer.on('tcm:setup-token', (_e, token) => cb(token));
    },
    onTriggerLogout: (cb) => {
        ipcRenderer.removeAllListeners('tcm:trigger-logout');
        ipcRenderer.on('tcm:trigger-logout', () => cb());
    },
});
