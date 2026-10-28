'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFocusService,
  FOCUS_TABS,
  FOCUS_TTL,
  sessionMinutes,
  parseMinuteLines
} = require('../electron/data/focus.cjs');
const { HEADERS } = require('../electron/data/market.cjs');

function minuteBlock(code, date, lines, qt) {
  const data = {};
  data[code] = {
    data: { date: date, data: lines },
    qt: {}
  };
  data[code].qt[code] = qt || [];
  return { data: data };
}

function makeService(overrides) {
  const calls = { snapshots: [], tencent: [], kline: [], em: [] };
  const market = {
    fetchSnapshots: async function (codes) {
      calls.snapshots.push(codes);
      return { sh600519: { name: '贵州茅台', price: 1700.5, prevClose: 1690, pct: 0.62 } };
    },
    fetchTencentJson: async function (pathAndQuery) {
      calls.tencent.push(pathAndQuery);
      if (pathAndQuery.indexOf('/minute/') >= 0) {
        const qt = [];
        qt[1] = '贵州茅台';
        qt[4] = '1688.00';
        qt[31] = '7.00';
        qt[32] = '0.42';
        return minuteBlock('sh600519', '20261028', [
          '0930 1690.00 100 169000',
          '0931 1692.00 260 609400',
          'bad line',
          '0932 1695.00 300 700500'
        ], qt);
      }
      return {
        data: {
          sh600519: {
            data: [
              { date: '20261027', prec: 1600, data: ['0930 1601 10 16010', '0931 1602 20 48040'] },
              { date: '20261024', prec: 1590, data: ['0930 1591 5 7955', '0931 1592 10 23880'] },
              { date: '20261028', prec: 1690, data: ['0930 1690 100 169000', '0931 1692 260 609400', '0932 1695 300 700500'] }
            ]
          }
        }
      };
    },
    fetchKlineRaw: async function (code, interval, count) {
      calls.kline.push([code, interval, count]);
      return [
        ['2026-10-24', '1590', '1600', '1610', '1580', '1000'],
        ['2026-10-27', '1600', '1690', '1700', '1595', '1200'],
        ['2026-10-28', '1690', '1705', '1710', '1688', '900'],
        ['bad', 'x', 'y', 'z', 'w', 'v']
      ];
    }
  };
  const http = {
    fetchJson: async function (url, opts) {
      calls.em.push([url, opts]);
      return {
        data: {
          date: '20261028',
          trends: [
            '09:30,2400,0,0,10',
            '09:31,2405,5,0.2,25',
            '09:32,2402,-3,-0.1,40'
          ]
        }
      };
    }
  };
  const service = createFocusService(Object.assign({ market: market, http: http }, overrides || {}));
  return { service, calls };
}

test('parseMinuteLines 差分累计量、计算 VWAP 并过滤坏行', function () {
  const pts = parseMinuteLines([
    '0930 10.0 100 1000',
    '0931 12.0 250 4000',
    '0932 11.0 250 5100',
    'oops 1 1 1',
    '0933 bad 300 6000'
  ]);
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0], { t: '0930', price: 10, vol: 100, avg: 10 });
  assert.equal(pts[1].vol, 150);
  assert.equal(pts[1].avg, (10 * 100 + 12 * 150) / 250);
  assert.equal(pts[2].vol, 0);
  assert.equal(pts[2].avg, pts[1].avg);
});

test('sessionMinutes 按市场返回分钟数', function () {
  assert.equal(sessionMinutes('sh600519'), 242);
  assert.equal(sessionMinutes('hk00700'), 332);
  assert.equal(sessionMinutes('usAAPL'), 392);
  assert.equal(sessionMinutes('hf_XAU'), 1440);
  assert.equal(sessionMinutes('usDXY'), 1440);
});

test('分时 payload 走腾讯分钟接口并补充快照信息', async function () {
  const { service, calls } = makeService({ now: function () { return 1000; } });
  const data = await service.payload('sh600519', 'minute');
  assert.equal(data.name, '贵州茅台');
  assert.equal(data.tab, 'minute');
  assert.equal(data.session, 242);
  assert.equal(data.price, 1695);
  assert.equal(data.prevClose, 1688);
  assert.equal(data.change, 7);
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].points.length, 3);
  assert.equal(data.hasData, true);
  assert.equal(data.at, 1000);
  assert.deepEqual(calls.snapshots, [['sh600519']]);
  assert.ok(calls.tencent[0].indexOf('/appstock/app/minute/query?code=sh600519') >= 0);
});

test('5日 payload 按日期正序并计算涨跌', async function () {
  const { service } = makeService();
  const data = await service.payload('sh600519', 'five');
  assert.equal(data.days.length, 3);
  assert.deepEqual(data.days.map(function (d) { return d.date; }), ['20261024', '20261027', '20261028']);
  assert.equal(data.days[2].prec, 1690);
  assert.equal(data.price, 1695);
  assert.equal(data.change, 5);
  assert.ok(Math.abs(data.pct - (5 / 1690) * 100) < 1e-9);
  assert.equal(data.hasData, true);
});

test('日K payload 取 160 根并过滤坏行', async function () {
  const { service, calls } = makeService();
  const data = await service.payload('sh600519', 'day');
  assert.deepEqual(calls.kline, [['sh600519', 'day', 160]]);
  assert.equal(data.candles.length, 3);
  assert.equal(data.price, 1705);
  assert.equal(data.prevClose, 1690);
  assert.equal(data.change, 15);
  assert.equal(data.hasData, true);
});

test('外盘聚焦走东财 trends2，并用快照补昨收', async function () {
  const { service, calls } = makeService({
    market: {
      fetchSnapshots: async function () { return { hf_XAU: { name: '黄金', price: 2402, prevClose: 2400, pct: 0.08 } }; },
      fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    }
  });
  const data = await service.payload('hf_XAU', 'minute');
  assert.equal(data.session, 1440);
  assert.equal(data.name, '黄金');
  assert.equal(data.prevClose, 2400);
  assert.equal(data.pct, 0.08);
  assert.equal(data.days[0].points.length, 3);
  assert.equal(data.days[0].points[1].vol, 15);
  assert.equal(data.hasData, true);
  assert.ok(calls.em[0][0].indexOf('trends2/get?secid=') >= 0);
  assert.equal(calls.em[0][1].headers, HEADERS);
});

test('payload 命中缓存直到 TTL 过期，peek 只读缓存', async function () {
  let clock = 5000;
  const { service, calls } = makeService({ now: function () { return clock; } });
  assert.equal(service.peek('sh600519', 'minute'), null);

  const first = await service.payload('sh600519', 'minute');
  assert.equal(calls.tencent.length, 1);
  assert.equal(service.peek('sh600519', 'minute').at, 5000);

  clock += FOCUS_TTL.minute - 1;
  const cached = await service.payload('sh600519', 'minute');
  assert.equal(cached, first);
  assert.equal(calls.tencent.length, 1);

  clock += 2;
  await service.payload('sh600519', 'minute');
  assert.equal(calls.tencent.length, 2);

  service.clear();
  assert.equal(service.peek('sh600519', 'minute'), null);
});

test('FOCUS_TABS 与 TTL 保持原有口径', function () {
  assert.deepEqual(FOCUS_TABS, ['minute', 'five', 'day']);
  assert.deepEqual(FOCUS_TTL, { minute: 15000, five: 60000, day: 60000 });
});
