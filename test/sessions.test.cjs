'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HK_CLOSE_EXIT,
  hmToMinutes,
  hasHkSymbols,
  autoExitTime
} = require('../electron/core/sessions.cjs');

test('hmToMinutes 校验格式和范围', function () {
  assert.equal(hmToMinutes('09:30'), 570);
  assert.equal(hmToMinutes('16:05'), 965);
  assert.equal(hmToMinutes('24:00'), null);
  assert.equal(hmToMinutes('12:60'), null);
  assert.equal(hmToMinutes('abc'), null);
});

test('hasHkSymbols 认 hk 前缀和港股主题的 em 指数', function () {
  const names = { em931787: '港股创新药', em930901: '动漫游戏' };
  assert.equal(hasHkSymbols(['sh000001', 'hkHSI'], names), true);
  assert.equal(hasHkSymbols(['sh000001', 'em931787'], names), true);
  assert.equal(hasHkSymbols(['sh000001', 'em930901'], names), false);
  // 名称还没学到时不当成港股，避免内地指数被顺延
  assert.equal(hasHkSymbols(['em931787'], {}), false);
  assert.equal(hasHkSymbols([], names), false);
});

test('autoExitTime 含港股时顺延到 16:05，设置更晚则保留', function () {
  const hk = { symbols: ['hkHSI'], names: {} };
  const a = { symbols: ['sh000001'], names: {} };
  assert.equal(autoExitTime('15:05', hk.symbols, hk.names), HK_CLOSE_EXIT);
  assert.equal(autoExitTime('15:05', a.symbols, a.names), '15:05');
  assert.equal(autoExitTime('16:30', hk.symbols, hk.names), '16:30');
  // 关闭 / 时间格式坏掉时保持原值，主进程会当成"不设置时间"
  assert.equal(autoExitTime('', hk.symbols, hk.names), '');
});
