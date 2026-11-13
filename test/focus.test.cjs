'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFocusService,
  FOCUS_TABS,
  FOCUS_TTL,
  FOCUS_MIN_TAB,
  FOCUS_INTERVALS,
  sessionMinutes,
  parseMinuteLines,
  parseLeadTrends,
  applyLeadValues
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
            '09:30,2400.5,2400,2401,2399,10,0,2400',
            '09:31,2400,2405,2406,2399,15,0,2403',
            '09:32,2405,2402,2406,2401,12,0,2402.5'
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

test('外盘 5 日走东财 5 分钟数据，横轴按最大点数并沿用快照昨收', async function () {
  const { service, calls } = makeService({
    market: {
      fetchSnapshots: async function () {
        return { hf_XAU: { name: '黄金', price: 3900, prevClose: 3950, pct: -1.27 } };
      },
      fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); },
      fetchFiveDay: async function (code) {
        calls.five = code;
        return [
          { date: '2026-10-30', prec: 4000, points: [
            { t: '07:00', price: 4010, vol: 1 },
            { t: '07:05', price: 4020, vol: 2 }
          ] },
          { date: '2026-11-03', prec: 4050, points: [
            { t: '07:00', price: 3930, vol: 3 },
            { t: '07:05', price: 3910, vol: 4 },
            { t: '07:10', price: 3900, vol: 5 }
          ] }
        ];
      }
    }
  });
  const data = await service.payload('hf_XAU', 'five');
  assert.equal(calls.five, 'hf_XAU');
  // 5 分钟粒度每天最多 3 个点，横轴就按 3 排，不该用 1440 把每天压扁
  assert.equal(data.session, 3);
  assert.equal(data.days.length, 2);
  assert.equal(data.price, 3900);
  assert.equal(data.prevClose, 3950);
  assert.equal(data.pct, -1.27);
  assert.ok(Math.abs(data.change - (3900 - 3950)) < 1e-9);
  // 最后一天的昨收虚线跟快照（昨结）对齐
  assert.equal(data.days[1].prec, 3950);
  assert.equal(data.hasData, true);
});

test('外盘 5 日快照缺昨收时退回前一交易日收盘', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { hf_XAU: { price: 3900 } }; },
      fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); },
      fetchFiveDay: async function () {
        return [
          { date: '2026-11-02', prec: 3980, points: [
            { t: '07:00', price: 3990, vol: 1 },
            { t: '07:05', price: 4000, vol: 2 }
          ] },
          { date: '2026-11-03', prec: 3880, points: [
            { t: '07:00', price: 3890, vol: 3 },
            { t: '07:05', price: 3900, vol: 4 }
          ] }
        ];
      }
    }
  });
  const data = await service.payload('hf_XAU', 'five');
  assert.equal(data.prevClose, 3880);
  assert.ok(Math.abs(data.pct - ((3900 - 3880) / 3880) * 100) < 1e-9);
  assert.ok(Math.abs(data.change - 20) < 1e-9);
  assert.equal(data.days[1].prec, 3880);
});

test('日K payload 拉满 1200 根历史并过滤坏行', async function () {
  const { service, calls } = makeService();
  const data = await service.payload('sh600519', 'day');
  // 1200 是腾讯 fqkline 实测能返回的上限（约 5 年），再多就空
  assert.deepEqual(calls.kline, [['sh600519', 'day', 1200]]);
  assert.equal(data.candles.length, 3);
  assert.equal(data.price, 1705);
  assert.equal(data.prevClose, 1690);
  assert.equal(data.change, 15);
  assert.equal(data.hasData, true);
});

test('月K payload 取 120 根（约 10 年）', async function () {
  const { service, calls } = makeService();
  const data = await service.payload('sh600519', 'month');
  assert.deepEqual(calls.kline, [['sh600519', 'month', 120]]);
  assert.equal(data.candles.length, 3);
  assert.equal(data.hasData, true);
});

test('周K payload 取 520 根（约 10 年）', async function () {
  const { service, calls } = makeService();
  const data = await service.payload('sh600519', 'week');
  assert.deepEqual(calls.kline, [['sh600519', 'week', 520]]);
  assert.equal(data.tab, 'week');
  assert.equal(data.candles.length, 3);
  assert.equal(data.price, 1705);
  assert.equal(data.hasData, true);
});

test('分时级别 payload 按 interval 取对应分钟 K，并把粒度带回渲染层', async function () {
  const { service, calls } = makeService();
  const five = await service.payload('sh600519', 'min', 5);
  assert.deepEqual(calls.kline, [['sh600519', 'm5', 320]]);
  assert.equal(five.tab, 'min');
  assert.equal(five.min, 5);
  assert.equal(five.candles.length, 3);
  assert.equal(five.hasData, true);

  await service.payload('sh600519', 'min', 15);
  assert.deepEqual(calls.kline[1], ['sh600519', 'm15', 320]);

  // 非法粒度回退 1 分钟
  const bad = await service.payload('sh600519', 'min', 7);
  assert.equal(bad.min, 1);
  assert.deepEqual(calls.kline[2], ['sh600519', 'm1', 320]);
});

test('分时级别每一档单独缓存，互不串档', async function () {
  const { service, calls } = makeService();
  const a = await service.payload('sh600519', 'min', 5);
  const b = await service.payload('sh600519', 'min', 60);
  assert.ok(a !== b);
  assert.equal(b.min, 60);
  // 5 分钟那档还在缓存里，不会再请求一次
  const again = await service.payload('sh600519', 'min', 5);
  assert.equal(again, a);
  assert.equal(calls.kline.length, 2);
  assert.equal(service.peek('sh600519', 'min', 5).min, 5);
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
  assert.equal(data.days[0].points[1].price, 2405);
  assert.equal(data.days[0].points[1].vol, 15);
  assert.equal(data.hasData, true);
  assert.ok(calls.em[0][0].indexOf('trends2/get?secid=') >= 0);
  assert.equal(calls.em[0][1].headers, HEADERS);
});

test('外盘分时没有成交量时 vol 为 0（伦敦金 / 美元指数）', async function () {
  const urls = [];
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { hf_XAU: { name: '黄金', price: 4138.73, prevClose: 4060.13, pct: 1.94 } }; },
      fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function (url) {
        urls.push(url);
        return {
          data: {
            date: '20261105',
            trends: [
              '2026-11-05 07:00,4063.13,4063.13,4063.13,4063.13,0,0.00,0.000',
              '2026-11-05 11:45,4139.71,4138.73,4140.41,4138.39,0,0.00,0.000'
            ]
          }
        };
      }
    }
  });
  const data = await service.payload('hf_XAU', 'minute');
  assert.equal(data.price, 4138.73);
  assert.deepEqual(data.days[0].points.map(function (p) { return p.vol; }), [0, 0]);
  assert.ok(urls[0].indexOf('f56') >= 0);
});

test('parseLeadTrends 取东财第 8 列，并同时提供带日期和 HHMM 的 key', function () {
  const map = parseLeadTrends([
    '2026-11-12 09:30,3650,3650,3651,3649,100,0,3648.50',
    '2026-11-12 09:31,3650,3655,3656,3648,200,0,3652.50',
    'bad row',
    '2026-11-12 09:32,3655,3656,3657,3654,300,0,'
  ]);
  assert.equal(map.get('202611120930'), 3648.5);
  assert.equal(map.get('0930'), 3648.5);
  assert.equal(map.get('202611120931'), 3652.5);
  assert.equal(map.has('202611120932'), false);
});

test('上证指数分时把领先指数填进 avg，缺失的 13:00 沿用上一分钟', async function () {
  const urls = [];
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { sh000001: { name: '上证指数', price: 3660, prevClose: 3640, pct: 0.55 } }; },
      fetchTencentJson: async function (pathAndQuery) {
        assert.ok(pathAndQuery.indexOf('/minute/query') >= 0);
        const qt = [];
        qt[1] = '上证指数';
        qt[4] = '3640.00';
        qt[31] = '20.00';
        qt[32] = '0.55';
        return minuteBlock('sh000001', '20261112', [
          '0930 3650 100 365000',
          '0931 3655 200 730500',
          '1300 3655 200 730500',
          '1301 3660 300 1096500'
        ], qt);
      },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function (url) {
        urls.push(url);
        return {
          data: {
            trends: [
              '2026-11-12 09:30,3650,3650,3651,3649,100,0,3648.50',
              '2026-11-12 09:31,3650,3655,3656,3648,200,0,3652.50',
              '2026-11-12 13:01,3655,3660,3661,3654,300,0,3658.50'
            ]
          }
        };
      }
    }
  });
  const data = await service.payload('sh000001', 'minute');
  assert.equal(data.lead, true);
  assert.deepEqual(data.days[0].points.map(function (p) { return p.avg; }),
    [3648.5, 3652.5, 3652.5, 3658.5]);
  assert.ok(urls[0].indexOf('secid=1.000001') >= 0);
  assert.ok(urls[0].indexOf('ndays=1') >= 0);
});

test('上证指数 5 日分时按日期匹配领先指数，不串日', async function () {
  const urls = [];
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { sh000001: { name: '上证指数', price: 3662 } }; },
      fetchTencentJson: async function (pathAndQuery) {
        assert.ok(pathAndQuery.indexOf('/day/query') >= 0);
        return {
          data: {
            sh000001: {
              data: [
                { date: '20261111', prec: 3640, data: ['0930 3650 100 365000', '0931 3652 200 730400'] },
                { date: '20261112', prec: 3650, data: ['0930 3660 100 366000', '0931 3662 200 732400'] }
              ]
            }
          }
        };
      },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function (url) {
        urls.push(url);
        return {
          data: {
            trends: [
              '2026-11-11 09:30,3650,3650,3651,3649,100,0,3645.50',
              '2026-11-11 09:31,3650,3652,3653,3649,200,0,3648.50',
              '2026-11-12 09:30,3660,3660,3661,3659,100,0,3655.50',
              '2026-11-12 09:31,3660,3662,3663,3659,200,0,3657.50'
            ]
          }
        };
      }
    }
  });
  const data = await service.payload('sh000001', 'five');
  assert.equal(data.lead, true);
  assert.deepEqual(data.days[0].points.map(function (p) { return p.avg; }), [3645.5, 3648.5]);
  assert.deepEqual(data.days[1].points.map(function (p) { return p.avg; }), [3655.5, 3657.5]);
  assert.ok(urls[0].indexOf('ndays=5') >= 0);
});

test('领先指数接口失败时退回原来的均价线', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { sh000001: { name: '上证指数', price: 3660 } }; },
      fetchTencentJson: async function () {
        return minuteBlock('sh000001', '20261112', [
          '0930 3650 100 365000',
          '0931 3655 200 730500'
        ], []);
      },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function () { throw new Error('东财不可用'); }
    }
  });
  const data = await service.payload('sh000001', 'minute');
  assert.equal(data.lead, false);
  // 没有领先指数时 avg 仍然是价格×成交量算出的 VWAP
  assert.equal(data.days[0].points[0].avg, 3650);
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

test('FOCUS_TABS 与 TTL 覆盖所有周期，分时级别单独一个 tab', function () {
  assert.deepEqual(FOCUS_TABS, ['minute', 'five', 'day', 'week', 'month']);
  assert.equal(FOCUS_MIN_TAB, 'min');
  assert.deepEqual(FOCUS_INTERVALS, [1, 5, 15, 30, 60]);
  assert.deepEqual(FOCUS_TTL, {
    minute: 15000, five: 60000, day: 60000, week: 60000, month: 60000, min: 30000
  });
});
