'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CONFIG } = require('../electron/core/constants.cjs');
const { normalizeConfig } = require('../electron/core/config.cjs');
const { applySettingsPatch } = require('../electron/core/settings.cjs');

function current() {
  return normalizeConfig({
    symbols: ['sh000001'],
    watchlist: ['sh000001', 'sz399001'],
    interval: 3000,
    width: 320,
    backdropOpacity: 40,
    probeIntervalMs: 4000,
    alert: { enabled: true, time: '14:30' },
    autoExit: { enabled: true, time: '15:05' },
    autoStart: { enabled: false, time: '09:25' }
  });
}

test('applySettingsPatch 拒绝无效数据 / 空自选', function () {
  assert.equal(applySettingsPatch(current(), null).ok, false);
  assert.equal(applySettingsPatch(current(), []).ok, false);
  const empty = applySettingsPatch(current(), { symbols: ['bad code'] });
  assert.equal(empty.ok, false);
  assert.equal(empty.msg, '至少要勾选一个标的');
});

test('applySettingsPatch 过滤非法代码并把自选并进 watchlist', function () {
  const result = applySettingsPatch(current(), {
    symbols: ['sh600519', 'not a code', '001186'],
    watchlist: ['sz000001', 'sh600519', 'oops']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.symbols, ['sh600519', '001186']);
  assert.deepEqual(result.patch.watchlist, ['sz000001', 'sh600519', '001186']);
});

test('applySettingsPatch 对周期/配色/数值做回退和夹取', function () {
  const cur = current();
  const result = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    period: 'week',
    textMode: 'blue',
    interval: 5,
    width: 10,
    backdropOpacity: 200,
    probeIntervalMs: 99999
  });
  assert.equal(result.patch.period, cur.period);
  assert.equal(result.patch.textMode, cur.textMode);
  assert.equal(result.patch.interval, 1000);
  assert.equal(result.patch.width, 220);
  assert.equal(result.patch.backdropOpacity, 95);
  assert.equal(result.patch.probeIntervalMs, 15000);

  const high = applySettingsPatch(cur, {
    symbols: ['sh000001'], interval: 999999, width: 9999,
    backdropOpacity: -1, probeIntervalMs: 1
  });
  assert.equal(high.patch.interval, 60000);
  assert.equal(high.patch.width, 640);
  assert.equal(high.patch.backdropOpacity, 0);
  assert.equal(high.patch.probeIntervalMs, 1000);
});

test('applySettingsPatch 缺省数值沿用当前值', function () {
  const cur = current();
  const result = applySettingsPatch(cur, { symbols: ['sh000001'] });
  assert.equal(result.patch.interval, 3000);
  assert.equal(result.patch.width, 320);
  assert.equal(result.patch.backdropOpacity, 40);
  assert.equal(result.patch.probeIntervalMs, 4000);
  assert.equal(result.patch.period, 'minute');
  assert.equal(result.patch.textMode, 'auto');
});

test('applySettingsPatch 的时间字段非法时回退当前值', function () {
  const cur = current();
  const result = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    alert: { enabled: false, time: '9:5' },
    autoExit: { enabled: true, time: '9:5' },
    autoStart: { enabled: true, time: '09:25' }
  });
  assert.deepEqual(result.patch.alert, { enabled: false, time: '14:30' });
  assert.deepEqual(result.patch.autoExit, { enabled: true, time: '15:05' });
  assert.deepEqual(result.patch.autoStart, { enabled: true, time: '09:25' });
});

test('applySettingsPatch 保留原有布尔字段语义', function () {
  const cur = current();
  const off = applySettingsPatch(cur, { symbols: ['sh000001'] });
  assert.equal(off.patch.backdrop, false);
  assert.equal(off.patch.alwaysOnTop, false);
  assert.equal(off.patch.locked, false);
  assert.equal(off.patch.showName, true);
  assert.equal(off.patch.baseline, true);
  assert.equal(off.patch.alert.enabled, true);

  const on = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    backdrop: 1, alwaysOnTop: 1, locked: 'yes',
    showName: false, baseline: false,
    alert: { enabled: false, time: '14:30' }
  });
  assert.equal(on.patch.backdrop, true);
  assert.equal(on.patch.alwaysOnTop, true);
  assert.equal(on.patch.locked, true);
  assert.equal(on.patch.showName, false);
  assert.equal(on.patch.baseline, false);
  assert.equal(on.patch.alert.enabled, false);
});

test('applySettingsPatch 规范化快捷键，并只在聚焦键变化时要求重注册', function () {
  const cur = current();
  const same = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { refresh: 'Ctrl+R', focus: 'Ctrl+Alt+F' }
  });
  assert.equal(same.effects.reRegisterHotkey, false);
  assert.equal(same.patch.shortcuts.refresh, DEFAULT_CONFIG.shortcuts.refresh);

  const changed = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { focus: 'Ctrl+Shift+F' }
  });
  assert.equal(changed.effects.reRegisterHotkey, true);
  assert.equal(changed.patch.shortcuts.focus, 'Ctrl+Shift+F');
  // 其它非法项回退默认
  assert.equal(changed.patch.shortcuts.refresh, DEFAULT_CONFIG.shortcuts.refresh);
});

test('applySettingsPatch 只返回设置面板负责的字段', function () {
  const result = applySettingsPatch(current(), { symbols: ['sh000001'] });
  assert.deepEqual(Object.keys(result.patch).sort(), [
    'alert', 'alwaysOnTop', 'autoExit', 'autoStart', 'backdrop', 'backdropOpacity',
    'baseline', 'interval', 'locked', 'period', 'probeIntervalMs', 'shortcuts',
    'showName', 'symbols', 'textMode', 'watchlist', 'width'
  ]);
});
