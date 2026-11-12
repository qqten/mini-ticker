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
  setGroup: function (id) { ipcRenderer.send('set-group', id); },
  save: function (patch) { ipcRenderer.send('save-config', patch); },
  onForceRefresh: function (fn) { ipcRenderer.on('force-refresh', fn); },
  onRefitHeight: function (fn) { ipcRenderer.on('refit-height', function () { fn(); }); },
  onStateChanged: function (fn) { ipcRenderer.on('state-changed', function (e, cfg) { fn(cfg); }); },
  // 自动配色变化：只换外观，不重拉行情（和 state-changed 分开，避免整表闪一下）
  onTheme: function (fn) { ipcRenderer.on('theme-changed', function (e, t) { fn(t); }); },

  // 聚焦图表（在原窗口里展开，不另开窗口）
  focusOpen: function (code) { ipcRenderer.send('focus-open', code); },
  focusToggle: function () { ipcRenderer.send('focus-toggle'); },
  focusClose: function () { ipcRenderer.send('focus-close'); },
  focusGet: function () { return ipcRenderer.invoke('focus-state'); },
  focusData: function () { return ipcRenderer.invoke('focus-data'); },
  focusStep: function (dir) { ipcRenderer.send('focus-step', dir); },
  focusSelect: function (code) { ipcRenderer.send('focus-select', code); },
  focusTab: function (tab) { ipcRenderer.send('focus-tab', tab); },
  focusSplit: function (leftW) { ipcRenderer.send('focus-split', leftW); },
  onFocusState: function (fn) { ipcRenderer.on('focus-state', function (e, s) { fn(s); }); },

  // 设置面板
  getSettings: function () { return ipcRenderer.invoke('settings-get'); },
  saveSettings: function (patch) { return ipcRenderer.invoke('settings-save', patch); },
  validateSymbol: function (code) { return ipcRenderer.invoke('validate-symbol', code); },
  searchSymbol: function (q) { return ipcRenderer.invoke('search-symbol', q); },
  testAlert: function () { ipcRenderer.send('test-alert'); },
  closeSettings: function () { ipcRenderer.send('settings-close'); },
  previewWidth: function (w) { ipcRenderer.send('preview-width', w); },
  setPinned: function (on) { ipcRenderer.send('set-pinned', on); },
  setPinZone: function (on) { ipcRenderer.send('set-pin-zone', on); },
  // 面板打开后的补充数据（名称 / 计划任务状态），晚一点到，不挡首屏渲染
  onSettingsNames: function (fn) { ipcRenderer.on('settings-names', function (e, m) { fn(m); }); },
  onAutostartStatus: function (fn) { ipcRenderer.on('autostart-status', function (e, v) { fn(v); }); },
  // 首屏画完的通知：主进程收到才把设置窗口显示出来
  settingsReady: function () { ipcRenderer.send('settings-ready'); },

  // 更新
  checkUpdate: function () { ipcRenderer.send('check-update'); },
  installUpdate: function () { ipcRenderer.send('install-update'); },
  onUpdateState: function (fn) { ipcRenderer.on('update-state', function (e, s) { fn(s); }); }
});
