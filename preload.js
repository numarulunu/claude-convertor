const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        const allowed = ['minimize', 'close', 'stop-encoding'];
        if (allowed.includes(channel)) ipcRenderer.send(channel, data);
    },
    invoke: (channel, data) => {
        const allowed = ['detect-system', 'scan-files', 'start-encoding', 'pick-folder', 'read-settings', 'write-settings', 'delete-files'];
        if (allowed.includes(channel)) return ipcRenderer.invoke(channel, data);
    },
    on: (channel, callback) => {
        const allowed = ['encoding-progress', 'encoding-file-done', 'encoding-batch-done', 'encoding-error'];
        if (allowed.includes(channel)) {
            ipcRenderer.on(channel, (_, data) => callback(data));
        }
    },
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },
    openExternal: (url) => {
        shell.openExternal(url);
    },
});
