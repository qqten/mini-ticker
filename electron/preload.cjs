const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ticker', {
  // 浮窗
  getState: function () { return ipcRenderer.invoke('get-state'); },
  getQuotes: function () { return ipcRenderer.invoke('get-quotes'); },
  setHeight: function (h) { ipcRenderer.send('set-height', h); },
  startDrag: function () { ipcRenderer.send('drag-start'); },
  endDrag: function () { ipcRenderer.send('drag-end'); },
  openMenu: function () { ipcRenderer.send('open-menu'); },
  openSettings: function () { ipcRenderer.send('open-settings'); },
  setPeriod: function (p) { ipcRenderer.send('set-period', p); },
  save: function (patch) { ipcRenderer.send('save-config', patch); },
  onForceRefresh: function (fn) { ipcRenderer.on('force-refresh', fn); },
  onRefitHeight: function (fn) { ipcRenderer.on('refit-height', function () { fn(); }); },
  onStateChanged: function (fn) { ipcRenderer.on('state-changed', function (e, cfg) { fn(cfg); }); },

  // 设置面板
  getSettings: function () { return ipcRenderer.invoke('settings-get'); },
  saveSettings: function (patch) { return ipcRenderer.invoke('settings-save', patch); },
  validateSymbol: function (code) { return ipcRenderer.invoke('validate-symbol', code); },
  searchSymbol: function (q) { return ipcRenderer.invoke('search-symbol', q); },
  testAlert: function () { ipcRenderer.send('test-alert'); },
  closeSettings: function () { ipcRenderer.send('settings-close'); }
});
