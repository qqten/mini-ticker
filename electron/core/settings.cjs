'use strict';

const { PERIODS, TEXT_MODES, FOCUS_CHART_SIDES } = require('./constants.cjs');
const { isValidCode } = require('./symbols.cjs');
const { clampInt } = require('./utils.cjs');
const { isValidTime, normalizeShortcuts } = require('./config.cjs');

function patchTime(value, fallback) {
  return isValidTime(value) ? value : fallback;
}

// 设置面板保存的唯一入口：所有范围/格式校验只在这里做，
// main 只负责把结果写回 config 并执行副作用（重启探针、重装计划任务等）。
// 注意：保持和原 settings-save 一样的「全量 patch」语义——缺省的布尔字段按 false 处理。
function applySettingsPatch(current, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, msg: '数据无效' };
  }

  const symbols = (Array.isArray(raw.symbols) ? raw.symbols : []).filter(isValidCode);
  if (symbols.length === 0) {
    return { ok: false, msg: '至少要勾选一个标的' };
  }

  const watchlist = (Array.isArray(raw.watchlist) ? raw.watchlist : []).filter(isValidCode);
  symbols.forEach(function (code) {
    if (watchlist.indexOf(code) < 0) watchlist.push(code);
  });

  const shortcuts = normalizeShortcuts(raw.shortcuts);
  const patch = {
    symbols: symbols,
    watchlist: watchlist,
    period: PERIODS.indexOf(raw.period) >= 0 ? raw.period : current.period,
    interval: clampInt(raw.interval, current.interval, 1000, 60000),
    textMode: TEXT_MODES.indexOf(raw.textMode) >= 0 ? raw.textMode : current.textMode,
    focusChartSide: FOCUS_CHART_SIDES.indexOf(raw.focusChartSide) >= 0
      ? raw.focusChartSide
      : (current.focusChartSide || 'auto'),
    backdrop: !!raw.backdrop,
    backdropOpacity: clampInt(raw.backdropOpacity, current.backdropOpacity, 0, 95),
    probeIntervalMs: clampInt(raw.probeIntervalMs, current.probeIntervalMs, 1000, 15000),
    showName: raw.showName !== false,
    baseline: raw.baseline !== false,
    alwaysOnTop: !!raw.alwaysOnTop,
    locked: !!raw.locked,
    width: clampInt(raw.width, current.width, 220, 640),
    alert: {
      enabled: !(raw.alert && raw.alert.enabled === false),
      time: patchTime(raw.alert && raw.alert.time, current.alert.time)
    },
    autoExit: {
      enabled: !!(raw.autoExit && raw.autoExit.enabled),
      time: patchTime(raw.autoExit && raw.autoExit.time, current.autoExit.time)
    },
    autoStart: {
      enabled: !!(raw.autoStart && raw.autoStart.enabled),
      time: patchTime(raw.autoStart && raw.autoStart.time, current.autoStart.time)
    },
    shortcuts: shortcuts
  };

  const currentShortcuts = current.shortcuts || {};
  const globalKeys = ['focus', 'showHide', 'clickThrough'];
  return {
    ok: true,
    patch: patch,
    effects: {
      // 这三个是全局快捷键，任何一个变了都要重新注册
      reRegisterHotkeys: globalKeys.some(function (key) {
        return shortcuts[key] !== currentShortcuts[key];
      })
    }
  };
}

module.exports = { applySettingsPatch };
