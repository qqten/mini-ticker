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
    alert: { enabled: false, time: '25:00' },
    autoExit: { enabled: true, time: '12:60' },
    autoStart: { enabled: true, time: '9:25' }
  });
  assert.deepEqual(result.patch.alert, { enabled: false, time: '14:30' });
  assert.deepEqual(result.patch.autoExit, { enabled: true, time: '15:05' });
  assert.deepEqual(result.patch.autoStart, { enabled: true, time: '09:25' });
});

test('applySettingsPatch 保留原有布尔字段语义', function () {
  const cur = current();
  const off = applySettingsPatch(cur, { symbols: ['sh000001'] });
  assert.equal(off.patch.backdrop, false);
  // 置顶 / 锁定：面板已不提供开关，缺省必须沿用当前值，不能被重置成 false
  assert.equal(off.patch.alwaysOnTop, !!cur.alwaysOnTop);
  assert.equal(off.patch.locked, !!cur.locked);
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

test('applySettingsPatch 校验聚焦图表位置', function () {
  const cur = current();
  const left = applySettingsPatch(cur, { symbols: ['sh000001'], focusChartSide: 'left' });
  assert.equal(left.patch.focusChartSide, 'left');

  const bad = applySettingsPatch(cur, { symbols: ['sh000001'], focusChartSide: 'middle' });
  assert.equal(bad.patch.focusChartSide, 'auto');
});

test('applySettingsPatch 顶部指数：没传时沿用当前，非法值回退', function () {
  const cur = current();
  const keep = applySettingsPatch(cur, { symbols: ['sh000001'] });
  assert.equal(keep.patch.showTopIndex, true);
  assert.equal(keep.patch.topIndex, 'sh000001');

  const off = applySettingsPatch(cur, {
    symbols: ['sh000001'], showTopIndex: false, topIndex: 'sz399001'
  });
  assert.equal(off.patch.showTopIndex, false);
  assert.equal(off.patch.topIndex, 'sz399001');

  const bad = applySettingsPatch(cur, { symbols: ['sh000001'], topIndex: 'sh600519' });
  assert.equal(bad.patch.topIndex, 'sh000001');
});

test('applySettingsPatch 规范化快捷键，并只在全局键变化时要求重注册', function () {
  const cur = current();
  const same = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { refresh: 'Ctrl+R', focus: 'Ctrl+Alt+F', showHide: 'Ctrl+Alt+H', clickThrough: 'Ctrl+Alt+T' }
  });
  assert.equal(same.effects.reRegisterHotkeys, false);
  assert.equal(same.patch.shortcuts.refresh, DEFAULT_CONFIG.shortcuts.refresh);
  assert.equal(same.patch.shortcuts.showHide, DEFAULT_CONFIG.shortcuts.showHide);
  assert.equal(same.patch.shortcuts.clickThrough, DEFAULT_CONFIG.shortcuts.clickThrough);

  const focus = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { focus: 'Ctrl+Shift+F' }
  });
  assert.equal(focus.effects.reRegisterHotkeys, true);
  assert.equal(focus.patch.shortcuts.focus, 'Ctrl+Shift+F');
  // 其它非法项回退默认
  assert.equal(focus.patch.shortcuts.refresh, DEFAULT_CONFIG.shortcuts.refresh);

  const showHide = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { showHide: 'Ctrl+Alt+S' }
  });
  assert.equal(showHide.effects.reRegisterHotkeys, true);
  assert.equal(showHide.patch.shortcuts.showHide, 'Ctrl+Alt+S');

  const through = applySettingsPatch(cur, {
    symbols: ['sh000001'],
    shortcuts: { clickThrough: 'Ctrl+Alt+P' }
  });
  assert.equal(through.effects.reRegisterHotkeys, true);
  assert.equal(through.patch.shortcuts.clickThrough, 'Ctrl+Alt+P');
});

test('applySettingsPatch 支持多分组、空组，并派生当前组 symbols', function () {
  const result = applySettingsPatch(current(), {
    groups: [
      { id: 'a', name: '指数', symbols: ['sh000001', 'sz399001'] },
      { id: 'b', name: '外盘', symbols: ['hf_XAU', 'sh000001'] },
      { id: 'c', name: '空组', symbols: [] }
    ],
    activeGroupId: 'b',
    watchlist: ['sh000001', 'hf_XAU', 'sz399001']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch.groups.map(function (g) { return g.name; }),
    ['指数', '外盘', '空组']);
  assert.equal(result.patch.activeGroupId, 'b');
  assert.deepEqual(result.patch.symbols, ['hf_XAU', 'sh000001']);
  assert.deepEqual(result.patch.watchlist, ['sh000001', 'hf_XAU', 'sz399001']);
});

test('applySettingsPatch 当前组非法时回退第一个组，且至少保留一个组', function () {
  const result = applySettingsPatch(current(), {
    groups: [{ id: 'a', name: '指数', symbols: ['sh000001'] }],
    activeGroupId: 'missing'
  });
  assert.equal(result.patch.activeGroupId, 'a');

  const none = applySettingsPatch(current(), { groups: [] });
  assert.equal(none.ok, false);
  assert.equal(none.msg, '至少要保留一个分组');

  const allInvalid = applySettingsPatch(current(), {
    groups: [{ id: 'a', name: 'x', symbols: ['bad code'] }],
    activeGroupId: 'a'
  });
  assert.equal(allInvalid.ok, true);
  assert.deepEqual(allInvalid.patch.groups[0].symbols, []);
});

test('applySettingsPatch 只返回设置面板负责的字段', function () {
  const result = applySettingsPatch(current(), { symbols: ['sh000001'] });
  assert.deepEqual(Object.keys(result.patch).sort(), [
    'activeGroupId', 'alert', 'alwaysOnTop', 'autoExit', 'autoStart', 'backdrop', 'backdropOpacity',
    'baseline', 'focusChartSide', 'focusInterval', 'focusIntervals', 'groups', 'interval', 'locked',
    'period', 'probeIntervalMs', 'shortcuts', 'showName', 'showTopIndex', 'symbols',
    'textMode', 'topIndex', 'watchlist', 'width'
  ]);
});

test('applySettingsPatch 校验图表分时级别列表，缺省时沿用当前值', function () {
  const cur = current();
  const def = applySettingsPatch(cur, { symbols: ['sh000001'] });
  assert.deepEqual(def.patch.focusIntervals, [5, 15, 30, 60]);

  // 勾选了 5 和 15：下拉只有这两档，固定按 5/15/30/60 的顺序排
  const picked = applySettingsPatch(cur, { symbols: ['sh000001'], focusIntervals: [15, 5, 15, 7] });
  assert.deepEqual(picked.patch.focusIntervals, [5, 15]);

  // 老客户端不带这个字段：不能把用户配的列表打回默认
  const kept = applySettingsPatch(
    normalizeConfig(Object.assign({}, cur, { focusIntervals: [15, 30] })),
    { symbols: ['sh000001'] }
  );
  assert.deepEqual(kept.patch.focusIntervals, [15, 30]);

  // 全非法 / 空列表退回默认，下拉不能是空的
  assert.deepEqual(applySettingsPatch(cur, { symbols: ['sh000001'], focusIntervals: [] }).patch.focusIntervals,
    [5, 15, 30, 60]);
  assert.deepEqual(applySettingsPatch(cur, { symbols: ['sh000001'], focusIntervals: ['x'] }).patch.focusIntervals,
    [5, 15, 30, 60]);
});

test('选中级别必须落在勾选的列表里，否则退回第一项', function () {
  const cur = current();
  const ok = applySettingsPatch(cur, {
    symbols: ['sh000001'], focusIntervals: [5, 15, 60], focusInterval: 15
  });
  assert.equal(ok.patch.focusInterval, 15);

  // 15 被取消勾选了：当前的 15 不在新列表里，退回列表第一项
  const dropped = applySettingsPatch(
    normalizeConfig(Object.assign({}, cur, { focusIntervals: [5, 15, 30, 60], focusInterval: 15 })),
    { symbols: ['sh000001'], focusIntervals: [5, 30, 60] }
  );
  assert.deepEqual(dropped.patch.focusIntervals, [5, 30, 60]);
  assert.equal(dropped.patch.focusInterval, 5);

  // 切了几档之后下拉当前值也能被记住
  const kept = applySettingsPatch(
    normalizeConfig(Object.assign({}, cur, { focusIntervals: [5, 15, 30, 60], focusInterval: 30 })),
    { symbols: ['sh000001'] }
  );
  assert.equal(kept.patch.focusInterval, 30);
});

test('normalizeConfig 归一 focusIntervals 与 focusInterval 的配合', function () {
  const cfg = normalizeConfig({ focusIntervals: [15, 30], focusInterval: 30 });
  assert.deepEqual(cfg.focusIntervals, [15, 30]);
  assert.equal(cfg.focusInterval, 30);

  // 选中的级别不在列表里：退回列表第一项
  const mismatch = normalizeConfig({ focusIntervals: [15, 30], focusInterval: 5 });
  assert.equal(mismatch.focusInterval, 15);

  assert.deepEqual(normalizeConfig({}).focusIntervals, [5, 15, 30, 60]);
  assert.equal(normalizeConfig({}).focusInterval, 5);
  assert.deepEqual(normalizeConfig({ focusIntervals: [1, 60] }).focusIntervals, [1, 60]);
  // 空列表 / 全非法都退回默认四档
  assert.deepEqual(normalizeConfig({ focusIntervals: [] }).focusIntervals, [5, 15, 30, 60]);
  assert.deepEqual(normalizeConfig({ focusIntervals: [9, 'x'] }).focusIntervals, [5, 15, 30, 60]);
});
