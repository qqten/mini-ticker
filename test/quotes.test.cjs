'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildItem,
  sortItems,
  buildFundItem,
  fundSeriesForPeriod
} = require('../electron/core/quotes.cjs');

const NAMES = { sh000001: '上证指数' };

test('buildItem 优先用快照，分时不做区间涨跌', function () {
  const item = buildItem('sh000001', {
    name: '上证指数', price: 3000, prevClose: 2990, pct: 0.33, change: 10
  }, [2995, 3000], { period: 'minute', names: NAMES });

  assert.equal(item.name, '上证指数');
  assert.equal(item.price, 3000);
  assert.equal(item.prevClose, 2990);
  assert.equal(item.pct, 0.33);
  assert.equal(item.change, 10);
  assert.equal(item.ok, true);
  assert.equal(item.fund, false);
  assert.equal(item.range, undefined);
});

test('buildItem 日线按折线区间算涨跌', function () {
  const item = buildItem('sh000001', {
    name: '上证指数', price: 110, prevClose: 100, pct: 10, change: 10
  }, [100, 105, 110], { period: 'day', names: NAMES });

  assert.equal(item.pct, 10);
  assert.equal(item.change, 10);
  assert.equal(item.range, true);
});

test('buildItem 没快照时用折线补齐价格和昨收', function () {
  const item = buildItem('sh000001', null, [9, 10], { period: 'minute', names: NAMES });
  assert.equal(item.name, '上证指数');
  assert.equal(item.price, 10);
  assert.equal(item.prevClose, 9);
  assert.ok(Math.abs(item.pct - 100 / 9) < 1e-9);
  assert.equal(item.change, 1);
  assert.equal(item.ok, true);
});

test('buildItem 识别场内 ETF / LOF 的小数位标记', function () {
  assert.equal(buildItem('sh510300', null, [], {}).fund, true);
  assert.equal(buildItem('sz159915', null, [], {}).fund, true);
  assert.equal(buildItem('sh600519', null, [], {}).fund, false);
});

test('buildItem 没有任何价格时 ok=false', function () {
  const item = buildItem('sh000001', null, [], { period: 'minute', names: NAMES });
  assert.equal(item.ok, false);
});

test('sortItems 按涨跌排，取数失败的永远沉底', function () {
  const items = [
    { code: 'a', pct: 1 },
    { code: 'b', pct: NaN },
    { code: 'c', pct: 5 },
    { code: 'd', pct: -2 },
    { code: 'e', pct: NaN }
  ];

  assert.deepEqual(sortItems(items, 'pct-desc').map(function (x) { return x.code; }), ['c', 'a', 'd', 'b', 'e']);
  assert.deepEqual(sortItems(items, 'pct-asc').map(function (x) { return x.code; }), ['d', 'a', 'c', 'b', 'e']);
  assert.deepEqual(sortItems(items, 'off').map(function (x) { return x.code; }), ['a', 'b', 'c', 'd', 'e']);
});

test('buildFundItem 分时使用本地攒的估值曲线', function () {
  const item = buildFundItem('001186', {
    name: '国泰基金', price: 1.5, prevClose: 1.4, pct: 7.14, time: '15:00'
  }, null, {
    period: 'minute',
    names: {},
    minuteSeries: function () { return { values: [1.4, 1.5], x: [1, 2] }; }
  });

  assert.equal(item.fund, true);
  assert.equal(item.name, '国泰基金');
  assert.equal(item.estTime, '15:00');
  assert.deepEqual(item.points, [1.4, 1.5]);
  assert.deepEqual(item.xIndex, [1, 2]);
  assert.equal(item.ok, true);
});

test('buildFundItem 日线用净值并按区间算涨跌', function () {
  const nav = {
    name: '国泰基金',
    rows: [['2026-01-01', 1.0], ['2026-01-02', 1.1], ['2026-01-03', 1.2]],
    last: 1.2,
    prev: 1.1
  };
  const item = buildFundItem('001186', null, nav, {
    period: 'day',
    names: {},
    minuteSeries: function () { return { values: [], x: [] }; }
  });

  assert.equal(item.name, '国泰基金');
  assert.deepEqual(item.points, [1.0, 1.1, 1.2]);
  assert.equal(item.price, 1.2);
  assert.equal(item.prevClose, 1.1);
  assert.ok(Math.abs(item.pct - 20) < 1e-9);
  assert.equal(item.range, true);
});

test('fundSeriesForPeriod 日 / 月 / 年聚合', function () {
  const rows = [
    ['2024-01-02', 1.0], ['2024-02-01', 1.1], ['2024-02-20', 1.2],
    ['2025-01-02', 1.3], ['2025-03-01', 1.4]
  ];

  assert.deepEqual(fundSeriesForPeriod(rows, 'day'), [1.0, 1.1, 1.2, 1.3, 1.4]);
  // 同一周期取最后一个净值
  assert.deepEqual(fundSeriesForPeriod(rows, 'month'), [1.0, 1.2, 1.3, 1.4]);
  assert.deepEqual(fundSeriesForPeriod(rows, 'year'), [1.2, 1.4]);
  assert.deepEqual(fundSeriesForPeriod([], 'day'), []);
});
