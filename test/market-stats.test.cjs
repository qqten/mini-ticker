'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseTrends,
  mergeTrendDays,
  sameTimeAmount,
  projectFullDay,
  percentChange,
  tradeStatus,
  buildMarketSnapshot
} = require('../electron/core/market-stats.cjs');

// A 股一个交易日的 241 个分钟点：09:30-11:30 + 13:01-15:00。
const MINUTES = (function () {
  const out = [];
  function push(h, m) {
    out.push(String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
  }
  for (let h = 9; h <= 11; h++) {
    for (let m = 0; m < 60; m++) {
      if (h === 9 && m < 30) continue;
      if (h === 11 && m > 30) break;
      push(h, m);
    }
  }
  for (let h = 13; h <= 15; h++) {
    for (let m = 0; m < 60; m++) {
      if (h === 13 && m === 0) continue;
      if (h === 15 && m > 0) break;
      push(h, m);
    }
  }
  return out;
})();

function makeSeries(day, count, amount) {
  return MINUTES.slice(0, count).map(function (hm) {
    return { day: day, hm: hm, amount: amount };
  });
}

test('parseTrends 解析日期、分钟与成交额，坏行直接跳过', function () {
  const rows = parseTrends([
    '2026-11-13 09:30,3635.00,3636.00,3637.00,3634.00,100,123456.00,3635.50',
    '2026-11-13 09:31,3636.00,3636.50,3637.00,3635.00,120,654321.00,3636.10',
    '',
    'bad,line',
    '2026-11-13 09:32,1,1,1,1,1,oops,1'
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { day: '2026-11-13', hm: '09:30', amount: 123456 });
  assert.deepEqual(rows[1], { day: '2026-11-13', hm: '09:31', amount: 654321 });
});

test('mergeTrendDays 按同一天同一分钟把沪深两市相加，并按时间排序', function () {
  const sh = parseTrends([
    '2026-11-13 09:31,0,0,0,0,0,100,0',
    '2026-11-13 09:30,0,0,0,0,0,200,0',
    '2026-11-12 09:30,0,0,0,0,0,900,0'
  ]);
  const sz = parseTrends([
    '2026-11-13 09:30,0,0,0,0,0,50,0',
    '2026-11-13 09:31,0,0,0,0,0,60,0',
    '2026-11-12 09:30,0,0,0,0,0,80,0'
  ]);
  const days = mergeTrendDays([sh, sz]);
  assert.deepEqual(days.map(function (d) { return d.day; }), ['2026-11-12', '2026-11-13']);
  assert.deepEqual(days[1].points, [
    { day: '2026-11-13', hm: '09:30', amount: 250 },
    { day: '2026-11-13', hm: '09:31', amount: 160 }
  ]);
  assert.equal(days[0].points[0].amount, 980);
});

test('sameTimeAmount 只累计不晚于当前分钟的点', function () {
  const points = makeSeries('2026-11-12', 5, 10);
  points[0].hm = '09:30';
  points[1].hm = '09:31';
  points[2].hm = '09:32';
  points[3].hm = '09:33';
  points[4].hm = '09:34';
  assert.equal(sameTimeAmount(points, '09:31'), 20);
  assert.equal(sameTimeAmount(points, '09:59'), 50);
  assert.equal(sameTimeAmount(points, '09:00'), 0);
});

test('projectFullDay 按已走分钟线性外推到 241 点', function () {
  assert.equal(projectFullDay(190 * 2, 190), 482);
  assert.equal(projectFullDay(10, 0), NaN);
  assert.equal(projectFullDay(NaN, 10), NaN);
});

test('percentChange 基准缺失或为 0 时返回 NaN', function () {
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(80, 100), -20);
  assert.equal(percentChange(80, 0), NaN);
  assert.equal(percentChange(NaN, 100), NaN);
});

test('tradeStatus 区分盘前 / 早期 / 盘中 / 收盘', function () {
  const now = new Date(2026, 10, 13, 10, 0);
  assert.equal(tradeStatus('2026-11-13', '09:35', 6, now), 'early');
  assert.equal(tradeStatus('2026-11-13', '09:45', 15, now), 'open');
  assert.equal(tradeStatus('2026-11-13', '15:00', 241, now), 'closed');
  assert.equal(tradeStatus('2026-11-12', '15:00', 241, now), 'closed');
  assert.equal(tradeStatus('2026-11-12', '15:00', 241, new Date(2026, 10, 13, 9, 0)), 'pre');
  assert.equal(tradeStatus('', '', 0, now), 'pre');
});

test('buildMarketSnapshot 盘中给出较昨同期与全天预测', function () {
  const now = new Date(2026, 10, 13, 14, 9);
  const today = makeSeries('2026-11-13', 190, 2e9);
  const yesterday = makeSeries('2026-11-12', 241, 1e9);
  const snap = buildMarketSnapshot({
    now: now,
    overview: { up: 410, down: 1916, flat: 30, amount: 1.37e12 },
    trends: [today, yesterday]
  });

  assert.equal(snap.status, 'open');
  assert.equal(snap.tradeTime, '14:09');
  assert.equal(snap.up, 410);
  assert.equal(snap.down, 1916);
  assert.equal(snap.flat, 30);
  assert.equal(snap.amount, 1.37e12);
  assert.equal(snap.todayAmount, 190 * 2e9);
  assert.equal(snap.prevAmount, 190 * 1e9);
  assert.equal(snap.prevFullAmount, 241 * 1e9);
  assert.equal(snap.vsAmount, 190 * 1e9);
  assert.equal(snap.vsPct, 100);
  assert.equal(snap.projAmount, 190 * 2e9 / 190 * 241);
  assert.equal(snap.projDelta, 241 * 1e9);
  assert.equal(snap.projPct, 100);
});

test('buildMarketSnapshot 开盘不足 15 分钟不外推全天', function () {
  const snap = buildMarketSnapshot({
    now: new Date(2026, 10, 13, 9, 40),
    overview: { up: 300, down: 500, flat: 10, amount: 50e9 },
    trends: [makeSeries('2026-11-13', 10, 1e9), makeSeries('2026-11-12', 241, 1e9)]
  });
  assert.equal(snap.status, 'early');
  assert.equal(snap.prevAmount, 10 * 1e9);
  assert.ok(isNaN(snap.projAmount));
  assert.ok(isNaN(snap.projPct));
});

test('buildMarketSnapshot 收盘后较昨改用昨日全天，且不再预测', function () {
  const snap = buildMarketSnapshot({
    now: new Date(2026, 10, 13, 15, 10),
    overview: { up: 2000, down: 2800, flat: 40, amount: 1.5e12 },
    trends: [makeSeries('2026-11-13', 241, 2e9), makeSeries('2026-11-12', 241, 1e9)]
  });
  assert.equal(snap.status, 'closed');
  assert.equal(snap.prevAmount, 241 * 1e9);
  assert.equal(snap.vsAmount, 241 * 1e9);
  assert.equal(snap.vsPct, 100);
  assert.ok(isNaN(snap.projAmount));
  assert.ok(isNaN(snap.projDelta));
  assert.ok(isNaN(snap.projPct));
});

test('buildMarketSnapshot 盘前不显示较昨与预测', function () {
  const snap = buildMarketSnapshot({
    now: new Date(2026, 10, 13, 9, 0),
    overview: { up: 0, down: 0, flat: 0, amount: 0 },
    trends: [makeSeries('2026-11-12', 241, 1e9)]
  });
  assert.equal(snap.status, 'pre');
  assert.ok(isNaN(snap.prevAmount));
  assert.ok(isNaN(snap.vsPct));
  assert.ok(isNaN(snap.projAmount));
});

test('buildMarketSnapshot 数据缺失时字段为 NaN，不伪造 0', function () {
  const snap = buildMarketSnapshot({ now: new Date(2026, 10, 13, 14, 0) });
  assert.equal(snap.status, 'pre');
  assert.ok(isNaN(snap.up));
  assert.ok(isNaN(snap.down));
  assert.ok(isNaN(snap.amount));
  assert.ok(isNaN(snap.vsPct));
  assert.ok(isNaN(snap.projPct));
});
