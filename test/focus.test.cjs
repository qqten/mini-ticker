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
  hkIndexSlotOf,
  parseCsindexIntraday,
  parseMinuteLines,
  parseTencentFiveDays,
  parseSinaIndexMinute,
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
  assert.equal(sessionMinutes('sge_AUTD'), 660);
});

test('sessionMinutes 能认出港股主题的东财指数', function () {
  assert.equal(sessionMinutes('em931787', '港股创新药'), 332);
  assert.equal(sessionMinutes('em931250', '港股通创新药'), 332);
  assert.equal(sessionMinutes('em930901', '动漫游戏'), 242);
  // 名称还没学到时按内地中证指数处理，避免把内地指数错画成 16:00 收盘
  assert.equal(sessionMinutes('em931787'), 242);
});

test('hkIndexSlotOf 把港股午休压缩掉：09:30-11:30 + 13:00-16:00', function () {
  assert.equal(hkIndexSlotOf('09:30'), 0);
  assert.equal(hkIndexSlotOf('11:00'), 90);
  assert.equal(hkIndexSlotOf('11:30'), 120);
  assert.equal(hkIndexSlotOf('13:00'), 121);
  assert.equal(hkIndexSlotOf('15:00'), 241);
  assert.equal(hkIndexSlotOf('16:00'), 301);
  // 11:30-13:00 中证没有数据，映射成空档而不是硬塞进上下午
  assert.equal(hkIndexSlotOf('12:00'), -1);
  assert.equal(hkIndexSlotOf('12:30'), -1);
  assert.equal(hkIndexSlotOf('08:59'), -1);
});

test('中证分时收盘后以 header.current 修正 16:00 的暂定收盘价', function () {
  const parsed = parseCsindexIntraday({ data: {
    intraDayHeader: {
      tradeDate: '2026-11-16', openToday: 1330.07, closePre: 1348.74, current: 1317.15
    },
    intraDayPerfList: [
      { tradeTime: '09:30:09', current: 1330.07 },
      { tradeTime: '15:59:09', current: 1318.17 },
      { tradeTime: '16:00:09', current: 1318.30 }
    ]
  } });
  const last = parsed.points[parsed.points.length - 1];
  assert.equal(last.slot, 301);
  // 16:00:09 的 1318.30 是暂定值，收盘后 header.current 才是最终收盘价
  assert.equal(last.price, 1317.15);
  assert.equal(parsed.price, 1317.15);
});

test('港股主题 em 指数分时走中证官网，槽位覆盖到 16:00', async function () {
  const calls = { urls: [] };
  const info = {
    fetchSnapshots: async function () {
      return { em931787: { name: '港股创新药', price: 1313.62, prevClose: 1348.74, pct: -2.6 } };
    },
    fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
    fetchKlineRaw: async function () { throw new Error('不应走K线'); }
  };
  const http = {
    fetchJson: async function (url) {
      calls.urls.push(url);
      if (url.indexOf('csindex') >= 0) {
        return { data: {
          intraDayHeader: {
            tradeDate: '2026-11-16', tradeTime: '15:25:09',
            openToday: 1330.07, closePre: 1348.74, current: 1313.62
          },
          intraDayPerfList: [
            { tradeTime: '09:30:09', current: 1330.07 },
            { tradeTime: '09:30:24', current: 1330.30 },
            { tradeTime: '09:31:09', current: 1329.00 },
            { tradeTime: '12:00:00', current: 1320.00 },
            { tradeTime: '13:00:10', current: 1318.00 },
            { tradeTime: '15:00:09', current: 1314.00 },
            { tradeTime: '15:25:09', current: 1313.62 }
          ]
        } };
      }
      return { data: { trends: [
        '2026-11-16 09:30,1330,1330,1330,1330,10,0,1330',
        '2026-11-16 09:31,1329,1329,1329,1329,20,0,1329',
        '2026-11-16 15:00,1314,1314,1314,1314,30,0,1314'
      ] } };
    }
  };
  const service = createFocusService({ market: info, http: http, now: function () { return 1000; } });
  const data = await service.payload('em931787', 'minute');
  assert.equal(data.session, 302);
  assert.equal(data.market, 'hk-index');
  assert.equal(data.price, 1313.62);
  assert.equal(data.prevClose, 1348.74);
  assert.ok(calls.urls.some(function (u) { return u.indexOf('index-perf-oneday?indexCode=931787') >= 0; }));
  const pts = data.days[0].points;
  // 同一分钟的 15 秒点只留最后一个；09:30 用今开补；
  // 13:00 紧接 11:30（午休压缩），11:30-13:00 之间没有点
  assert.deepEqual(pts.map(function (p) { return p.slot; }), [0, 1, 121, 241, 266]);
  assert.equal(pts[0].price, 1330.07);
  assert.ok(pts.every(function (p) { return p.slot !== 150; }));
  // 成交量从东财分钟线按分钟补，15:00 之后没有量就留 0
  assert.equal(pts[0].vol, 10);
  assert.equal(pts[3].vol, 30);
  assert.equal(pts[4].vol, 0);
});

test('em 指数快照缺名称时，中证币种兜底判为港股并走 CSI 分时', async function () {
  const calls = { urls: [] };
  const info = {
    fetchSnapshots: async function () { return {}; },
    fetchCsindexInfo: async function (code) {
      assert.equal(code, 'em931787');
      return { name: '港股创新药', hk: true };
    },
    fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
    fetchKlineRaw: async function () { throw new Error('不应走K线'); }
  };
  const http = {
    fetchJson: async function (url) {
      calls.urls.push(url);
      if (url.indexOf('csindex') >= 0) {
        return { data: {
          intraDayHeader: { tradeDate: '2026-11-16', openToday: 1330.07, closePre: 1348.74, current: 1313.62 },
          intraDayPerfList: [
            { tradeTime: '09:30:09', current: 1319.01 },
            { tradeTime: '09:31:09', current: 1329.00 },
            { tradeTime: '15:00:09', current: 1314.00 }
          ]
        } };
      }
      return { data: { trends: ['2026-11-16 09:30,1330,1330,1330,1330,10,0,1330'] } };
    }
  };
  const service = createFocusService({ market: info, http: http, now: function () { return 1000; } });
  const data = await service.payload('em931787', 'minute');
  assert.equal(data.name, '港股创新药');
  assert.equal(data.market, 'hk-index');
  assert.equal(data.session, 302);
  assert.equal(data.price, 1313.62);
  assert.ok(calls.urls.some(function (u) { return u.indexOf('index-perf-oneday?indexCode=931787') >= 0; }));
});

test('港股 em 指数 5 日图：今天用中证补到 16:00，所有点按真实时钟摆位', async function () {
  const info = {
    fetchSnapshots: async function () {
      return { em931787: { name: '港股创新药', price: 1313.62, prevClose: 1348.74, pct: -2.6 } };
    },
    fetchFiveDay: async function () {
      return [
        { date: '2026-11-13', prec: 1396.56, points: [
          { t: '09:35', price: 1371.04, vol: 10 },
          { t: '11:30', price: 1360.00, vol: 11 },
          { t: '13:05', price: 1355.00, vol: 12 },
          { t: '15:00', price: 1348.74, vol: 13 }
        ] },
        { date: '2026-11-16', prec: 1348.74, points: [
          { t: '09:35', price: 1312.62, vol: 20 },
          { t: '11:30', price: 1305.00, vol: 21 },
          { t: '13:05', price: 1303.00, vol: 22 },
          { t: '15:00', price: 1313.48, vol: 23 }
        ] }
      ];
    },
    fetchTencentJson: async function () { throw new Error('不应走腾讯'); },
    fetchKlineRaw: async function () { throw new Error('不应走K线'); }
  };
  const http = {
    fetchJson: async function (url) {
      if (url.indexOf('csindex') >= 0) {
        return { data: {
          intraDayHeader: {
            tradeDate: '2026-11-16', openToday: 1330.07, closePre: 1348.74, current: 1318.78
          },
          intraDayPerfList: [
            { tradeTime: '09:30:09', current: 1330.07 },
            { tradeTime: '09:31:09', current: 1329.00 },
            { tradeTime: '13:00:10', current: 1306.00 },
            { tradeTime: '15:00:09', current: 1314.00 },
            { tradeTime: '15:40:09', current: 1318.78 }
          ]
        } };
      }
      return { data: { trends: [] } };
    }
  };
  const service = createFocusService({ market: info, http: http, now: function () { return 1000; } });
  const data = await service.payload('em931787', 'five');
  assert.equal(data.session, 302);
  assert.equal(data.market, 'hk-index');
  assert.equal(data.days.length, 2);
  assert.equal(data.price, 1318.78);
  // 昨天（东财 5 分钟）按真实时钟摆：09:35=5、11:30=120、13:05=126；
  // 东财把 15:00-16:00 压缩进最后一根 15:00 K，所以它要摆到 16:00（slot 301）
  assert.deepEqual(data.days[0].points.map(function (p) { return p.slot; }), [5, 120, 126, 301]);
  assert.equal(data.days[0].points[3].t, '16:00');
  assert.equal(data.days[0].prec, 1396.56);
  // 今天换成中证分时，带上 09:30 开盘，一直画到 15:40（收盘后到 16:00）
  assert.deepEqual(data.days[1].points.map(function (p) { return p.slot; }), [0, 1, 121, 241, 281]);
  assert.equal(data.days[1].points[0].price, 1330.07);
  assert.equal(data.days[1].prec, 1348.74);
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

test('美元指数东财分时失败时用新浪 1 分钟 K 兜底', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () {
        return { usDXY: { name: '美元指数', price: 103.94, prevClose: 103.86, pct: 0.08 } };
      },
      fetchForeignMinute: async function () {
        return {
          date: '2026-11-19',
          points: [
            { t: '2026-11-19 11:23:00', price: 103.93, vol: 0 },
            { t: '2026-11-19 11:24:00', price: 103.94, vol: 0 }
          ]
        };
      }
    },
    http: {
      fetchJson: async function () { throw new Error('eastmoney down'); }
    }
  });
  const data = await service.payload('usDXY', 'minute');
  assert.equal(data.session, 1440);
  assert.equal(data.hasData, true);
  assert.equal(data.days[0].date, '2026-11-19');
  assert.equal(data.days[0].points.length, 2);
  assert.equal(data.price, 103.94);
  assert.equal(data.prevClose, 103.86);
});

test('黄金T+D 分时：东财 trends2 挂了走新浪 SpotService 兜底', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () {
        return { sge_AUTD: { name: '黄金T+D', price: 796.6, prevClose: 810.1, pct: -1.67 } };
      },
      fetchForeignMinute: async function (code) {
        assert.equal(code, 'sge_AUTD');
        return {
          date: '2026-11-19',
          points: [
            { t: '20:00', price: 809, vol: 16 },
            { t: '09:00', price: 795, vol: 300 },
            { t: '11:45', price: 796.6, vol: 174 }
          ]
        };
      }
    },
    http: {
      fetchJson: async function () { throw new Error('eastmoney down'); }
    }
  });
  const data = await service.payload('sge_AUTD', 'minute');
  assert.equal(data.session, 660);
  assert.equal(data.market, 'sge');
  assert.equal(data.hasData, true);
  assert.equal(data.name, '黄金T+D');
  assert.equal(data.days[0].date, '2026-11-19');
  assert.equal(data.days[0].points.length, 3);
  assert.equal(data.price, 796.6);
  assert.equal(data.prevClose, 810.1);
  // 东财 trends2 没有昨收列：单日分时要把快照昨收带给图表，虚线才画得出来
  assert.equal(data.days[0].prec, 810.1);
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

test('parseSinaIndexMinute 丢掉 09:25 集合竞价，黄线取领先指数 lx', function () {
  const pts = parseSinaIndexMinute([
    { m: '09:25:00', p: '3583.12', avg_p: '3583.12', lx: '3587.83', v: '483230000' },
    { m: '09:30:00', p: '3570.10', avg_p: '3575.29', lx: '3581.36', v: '1362142800' },
    { m: '09:31:00', p: '3566.78', avg_p: '3573.24', lx: '3561.76', v: '784705900' },
    // 新浪有时把最新一分钟的领先指数给成 0，不能把纵轴拉到底
    { m: '09:32:00', p: '3568.00', avg_p: '3573.00', lx: '0', v: '600000000' }
  ], true);
  assert.deepEqual(pts.map(function (p) { return p.t; }), ['09:30', '09:31', '09:32']);
  assert.equal(pts[0].price, 3570.1);
  assert.equal(pts[0].avg, 3581.36);
  assert.equal(pts[0].vol, 1362142800);
  assert.equal(pts[2].avg, 3561.76);
});

test('parseSinaIndexMinute 非领先指数时黄线退回均价 avg_p', function () {
  const pts = parseSinaIndexMinute([
    { m: '09:30:00', p: '3570.10', avg_p: '3575.29', lx: '3581.36', v: '1362142800' }
  ], false);
  assert.equal(pts[0].avg, 3575.29);
});

test('parseTencentFiveDays 把倒序 5 日分时转正序并丢掉空日', function () {
  const days = parseTencentFiveDays({
    data: [
      { date: '20261112', data: ['0930 3660 100 366000', '0931 3662 200 732400'] },
      { date: 'bad', data: ['0930 3650 100 365000'] },
      { date: '20261111', data: ['0930 3650 100 365000', '0931 3652 200 730400'] }
    ]
  });
  assert.deepEqual(days.map(function (d) { return d.date; }), ['20261111', '20261112']);
  assert.deepEqual(days[0].points.map(function (p) { return p.vol; }), [100, 100]);
});

test('东财分时不可用时上证指数走新浪兜底，白线黄线都还在', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () {
        return { sh000001: { name: '上证指数', price: 3566.78, prevClose: 3587.83 } };
      },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function () { throw new Error('东财不可用'); },
      fetchText: async function (url) {
        assert.ok(url.indexOf('CN_MinlineService') >= 0);
        return JSON.stringify({
          result: {
            data: [
              { m: '09:25:00', p: '3583.12', avg_p: '3583.12', lx: '3587.83', v: '483230000' },
              { m: '09:30:00', p: '3570.10', avg_p: '3575.29', lx: '3581.36', v: '1362142800' },
              { m: '09:31:00', p: '3566.78', avg_p: '3573.24', lx: '3561.76', v: '784705900' }
            ]
          }
        });
      }
    }
  });
  const data = await service.payload('sh000001', 'minute');
  assert.equal(data.days[0].points.length, 2);
  assert.equal(data.lead, true);
  assert.equal(data.days[0].points[1].avg, 3561.76);
  // 单日分时用快照昨收补足，昨收虚线才画得出
  assert.equal(data.days[0].prec, 3587.83);
});

test('腾讯 5 日分时不可用时用新浪当天分时兜底，只画今天', async function () {
  const { service } = makeService({
    market: {
      fetchSnapshots: async function () { return { sh000001: { name: '上证指数', price: 3566.78, prevClose: 3587.83 } }; },
      fetchTencentJson: async function () { throw new Error('腾讯不可用'); },
      fetchKlineRaw: async function () { throw new Error('不应走K线'); }
    },
    http: {
      fetchJson: async function () { throw new Error('东财不可用'); },
      fetchText: async function (url) {
        assert.ok(url.indexOf('CN_MinlineService') >= 0);
        return JSON.stringify({
          result: {
            data: [
              { m: '09:30:00', p: '3570.10', avg_p: '3575.29', lx: '3581.36', v: '1362142800' },
              { m: '09:31:00', p: '3566.78', avg_p: '3573.24', lx: '3561.76', v: '784705900' }
            ]
          }
        });
      }
    }
  });
  const data = await service.payload('sh000001', 'five');
  assert.equal(data.days.length, 1);
  assert.equal(data.days[0].points.length, 2);
  assert.equal(data.days[0].points[1].price, 3566.78);
  // 新浪只给当天，昨收由快照补，虚线不会落在开盘价上
  assert.equal(data.prevClose, 3587.83);
});
