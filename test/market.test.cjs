'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMarket,
  mapEmKlineRows,
  buildFiveDayRows,
  aggregateMonthlyRows,
  aggregateWeeklyRows,
  MIN_INTERVAL,
  SINA_SCALE
} = require('../electron/data/market.cjs');

function makeHttp(handlers) {
  const calls = [];
  return {
    calls: calls,
    fetchGbk: async function (url) {
      calls.push({ kind: 'gbk', url: url });
      if (!handlers.gbk) throw new Error('unexpected gbk: ' + url);
      return handlers.gbk(url);
    },
    fetchJson: async function (url) {
      calls.push({ kind: 'json', url: url });
      if (!handlers.json) throw new Error('unexpected json: ' + url);
      return handlers.json(url);
    },
    fetchText: async function (url) {
      calls.push({ kind: 'text', url: url });
      if (!handlers.text) throw new Error('unexpected text: ' + url);
      return handlers.text(url);
    }
  };
}

function txA(code, fields) {
  return 'v_' + code + '="' + fields.join('~') + '";';
}

function txAFields(name, price, prev, pct, change) {
  const a = new Array(33).fill('');
  a[1] = name;
  a[3] = String(price);
  a[4] = String(prev);
  a[30] = '20261028150000';
  a[31] = String(change);
  a[32] = String(pct);
  return a;
}

function txHfFields(name, price, pct, prev, time, date) {
  const a = new Array(14).fill('');
  a[0] = String(price);
  a[1] = String(pct);
  a[6] = time;
  a[7] = String(prev);
  a[12] = date;
  a[13] = name;
  return a;
}

test('fetchSnapshots 解析腾讯 A 股和外盘期货', async function () {
  const http = makeHttp({
    gbk: function () {
      return txA('sh000001', txAFields('上证指数', 3000.12, 2990, 0.34, 10.12)) + ';' +
        'v_hf_GC="' + txHfFields('纽约金', 2350.5, 1.2, 2322.3, '15:00:00', '2026-10-28').join(',') + '";';
    }
  });
  const market = createMarket({ http: http });

  const snap = await market.fetchSnapshots(['sh000001', 'hf_GC']);
  assert.equal(snap.sh000001.name, '上证指数');
  assert.equal(snap.sh000001.price, 3000.12);
  assert.equal(snap.sh000001.prevClose, 2990);
  assert.equal(snap.sh000001.pct, 0.34);
  assert.equal(snap.sh000001.change, 10.12);

  assert.equal(snap.hf_GC.name, '纽约金');
  assert.equal(snap.hf_GC.price, 2350.5);
  assert.equal(snap.hf_GC.prevClose, 2322.3);
  assert.equal(snap.hf_GC.pct, 1.2);
  assert.equal(snap.hf_GC.time, '2026-10-28 15:00:00');
});

test('腾讯失败时切到新浪，A 股 / 港股 / 美股指数字段各自解析', async function () {
  const http = makeHttp({
    gbk: function (url) {
      if (url.indexOf('qt.gtimg.cn') >= 0) throw new Error('blocked');
      return 'var hq_str_sh000001="上证指数,2990.00,2980.00,3000.00,3010.00,2970.00";\n' +
        'var hq_str_hkHSI="HK,恒生指数,1,25000.0,1,1,25100.0,100.0,0.4";\n' +
        'var hq_str_int_dji="道琼斯,42000.5,100.2,0.24";\n';
    }
  });
  const market = createMarket({ http: http });

  const snap = await market.fetchSnapshots(['sh000001', 'hkHSI', 'usDJI']);
  assert.equal(snap.sh000001.name, '上证指数');
  assert.equal(snap.sh000001.price, 3000);
  assert.equal(snap.sh000001.prevClose, 2980);
  assert.ok(Math.abs(snap.sh000001.pct - (20 / 2980) * 100) < 1e-9);

  assert.equal(snap.hkHSI.name, '恒生指数');
  assert.equal(snap.hkHSI.price, 25100);
  assert.equal(snap.hkHSI.prevClose, 25000);
  assert.equal(snap.hkHSI.pct, 0.4);

  assert.equal(snap.usDJI.name, '道琼斯');
  assert.equal(snap.usDJI.price, 42000.5);
  assert.equal(snap.usDJI.prevClose, 42000.5 - 100.2);
  assert.equal(snap.usDJI.pct, 0.24);
});

test('searchSymbols 解析 smartbox，并保留本地外盘期货匹配', async function () {
  const hint = 'v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~600519~GP-A^' +
    'jj~001186~\\u56fd\\u6cf0\\u57fa\\u91d1~001186~KJ"';
  const http = makeHttp({ gbk: function () { return hint; } });
  const market = createMarket({ http: http });

  const list = await market.searchSymbols('茅台');
  const maotai = list.find(function (x) { return x.code === 'sh600519'; });
  assert.ok(maotai);
  assert.equal(maotai.name, '贵州茅台');
  assert.equal(maotai.typeLabel, 'A股');

  const fund = list.find(function (x) { return x.code === '001186'; });
  assert.ok(fund);
  assert.equal(fund.name, '国泰基金');
  assert.equal(fund.typeLabel, '场外基金');

  const http2 = makeHttp({ gbk: function () { return 'v_hint="N"'; } });
  const market2 = createMarket({ http: http2 });
  const local = await market2.searchSymbols('原油');
  assert.deepEqual(local.map(function (x) { return x.code; }).sort(), ['hf_CL', 'hf_OIL']);
  assert.equal(local[0].typeLabel, '外盘期货');

  // 上海黄金交易所：中文名和 autd 都能搜到，类型标签统一是「上金所」
  const autd = await market2.searchSymbols('黄金T+D');
  const gold = autd.find(function (x) { return x.code === 'sge_AUTD'; });
  assert.ok(gold);
  assert.equal(gold.typeLabel, '上金所');
  assert.equal(gold.market, 'sge');
  const byCode = await market2.searchSymbols('autd');
  assert.ok(byCode.some(function (x) { return x.code === 'sge_AUTD'; }));

  // 现货黄金9999 / 白银：腾讯搜索全空，靠本地名称表兜底
  const spot = await market2.searchSymbols('黄金9999');
  assert.ok(spot.some(function (x) { return x.code === 'sge_AU9999'; }));
  assert.equal(spot[0].name, '黄金9999');
  const silver = await market2.searchSymbols('白银9999');
  assert.ok(silver.some(function (x) { return x.code === 'sge_AG9999'; }));

  // 国债期货主连 + 债券指数：同样只能本地匹配
  const bondFuture = await market2.searchSymbols('十债');
  const tenYear = bondFuture.find(function (x) { return x.code === 'cf_TM'; });
  assert.ok(tenYear);
  assert.equal(tenYear.typeLabel, '国债期货');
  assert.equal(tenYear.market, 'cf');
  const bondIndex = await market2.searchSymbols('国债指数');
  const shBond = bondIndex.find(function (x) { return x.code === 'sh000012'; });
  assert.ok(shBond);
  assert.equal(shBond.typeLabel, '债券指数');
});

test('fetchFundEstimates / fetchFundNav 解析并缓存净值', async function () {
  const http = makeHttp({
    gbk: function () {
      return 'var hq_str_fu_001186="国泰基金,2026-10-28 15:00,1.2345,1.2000,1.2400,1.1900,2.87,2026-10-28";\n' +
        'var hq_str_fu_000001="空数据";\n';
    },
    text: function () {
      return 'var fS_name = "国泰基金";\n' +
        'var Data_netWorthTrend = [{"x":1760000000000,"y":"1.1"},{"x":1760100000000,"y":"1.2"}];\n';
    }
  });
  const market = createMarket({ http: http });

  const est = await market.fetchFundEstimates(['001186', '000001']);
  assert.equal(est['001186'].name, '国泰基金');
  assert.equal(est['001186'].price, 1.2345);
  assert.equal(est['001186'].pct, 2.87);
  assert.equal(est['001186'].date, '2026-10-28');
  assert.equal(est['000001'], undefined);

  const nav1 = await market.fetchFundNav('001186');
  assert.equal(nav1.name, '国泰基金');
  assert.equal(nav1.rows.length, 2);
  assert.equal(nav1.last, 1.2);
  assert.equal(nav1.prev, 1.1);

  // 30 分钟缓存命中，不再发请求
  const nav2 = await market.fetchFundNav('001186');
  assert.equal(nav1, nav2);
  assert.equal(http.calls.filter(function (c) { return c.kind === 'text'; }).length, 1);

  market.clearCaches();
  await market.fetchFundNav('001186');
  assert.equal(http.calls.filter(function (c) { return c.kind === 'text'; }).length, 2);
});

test('fetchMinuteSeries 解析腾讯分时，东财特殊品种走 trends2', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('trends2') >= 0) {
        return { data: { trends: [
          '2026-10-28 09:30,100.0,100.1,100.2,99.9,5,0,100.1',
          '2026-10-28 09:31,100.1,100.2,100.3,100.0,6,0,100.2'
        ] } };
      }
      return { data: { sh000001: { data: { data: ['0930 3000.00 1', '0931 3001.00 2'] } } } };
    }
  });
  const market = createMarket({ http: http });

  assert.deepEqual(await market.fetchMinuteSeries('sh000001'), [3000, 3001]);
  assert.deepEqual(await market.fetchMinuteSeries('usDXY'), [100.1, 100.2]);
});

test('fetchKlineRaw 解析腾讯 K 线，空数据时用新浪 jsonp 兜底', async function () {
  const tencentRows = [['2026-10-27', '1', '2', '3', '0.5', '100']];
  const http = makeHttp({
    json: function () {
      return { data: { sh000001: { qfqday: tencentRows } } };
    }
  });
  const market = createMarket({ http: http });
  assert.deepEqual(await market.fetchKlineRaw('sh000001', 'day', 10), tencentRows);

  const fallingBack = makeHttp({
    json: function () { return { data: {} }; },
    text: function () {
      return 'x=([{"day":"2026-10-27","open":"1","close":"2","high":"3","low":"0.5","volume":"100"}]);';
    }
  });
  const market2 = createMarket({ http: fallingBack });
  assert.deepEqual(await market2.fetchKlineRaw('sh000001', 'day', 10),
    [['2026-10-27', '1', '2', '3', '0.5', '100']]);
});

test('东财 K 线字符串行能解析，外盘月 K 用 klt=103 而不是日 K', async function () {  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      return {
        data: {
          klines: [
            '2026-09-30,10,11,12,9,5',
            '2026-10-31,11,13,14,10,6',
            '2026-11-03,13,12,15,11,7'
          ]
        }
      };
    }
  });
  const market = createMarket({ http: http });
  const month = await market.fetchKlineRaw('hf_XAU', 'month', 120);
  assert.ok(urls[0].indexOf('secid=122.XAU') >= 0);
  assert.ok(urls[0].indexOf('klt=103') >= 0);
  assert.equal(month.length, 3);
  assert.deepEqual(month[2], ['2026-11-03', 13, 12, 15, 11, 7]);

  assert.deepEqual(mapEmKlineRows(['2026-11-03,13,12,15,11,7', 'bad']),
    [['2026-11-03', 13, 12, 15, 11, 7]]);
});

test('东财不可用时外盘日 K 兜底并聚合出月 K', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      return {
        result: {
          data: [
            { date: '2026-09-30', open: 10, close: 11, high: 12, low: 9, volume: 5 },
            { date: '2026-10-31', open: 11, close: 13, high: 14, low: 10, volume: 6 },
            { date: '2026-11-03', open: 13, close: 12, high: 15, low: 11, volume: 7 }
          ]
        }
      };
    }
  });
  const market = createMarket({ http: http });
  const month = await market.fetchKlineRaw('hf_XAU', 'month', 120);
  assert.deepEqual(month, [
    ['2026-09-30', 10, 11, 12, 9, 5],
    ['2026-10-31', 11, 13, 14, 10, 6],
    ['2026-11-03', 13, 12, 15, 11, 7]
  ]);
  assert.equal(aggregateMonthlyRows([
    ['2026-10-01', 10, 11, 12, 9, 5],
    ['2026-10-31', 11, 13, 14, 10, 6]
  ])[0][3], 14);
});

test('美元指数东财 K 线不可用时用新浪 DINIW 日线兜底', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      assert.ok(url.indexOf('NewForexService.getDayKLine') >= 0);
      return {
        result: {
          // 新浪字段顺序：日期,开,低,高,收
          data: '2026-09-30,10,9,12,11,|2026-10-31,11,10,14,13,|2026-11-03,13,11,15,12,'
        }
      };
    }
  });
  const market = createMarket({ http: http });

  assert.deepEqual(await market.fetchKlineRaw('usDXY', 'day', 1200), [
    ['2026-09-30', 10, 11, 12, 9, 0],
    ['2026-10-31', 11, 13, 14, 10, 0],
    ['2026-11-03', 13, 12, 15, 11, 0]
  ]);

  const month = await market.fetchKlineRaw('usDXY', 'month', 120);
  assert.deepEqual(month[1], ['2026-10-31', 11, 13, 14, 10, 0]);
  assert.equal(month.length, 3);

  const week = await market.fetchKlineRaw('usDXY', 'week', 520);
  assert.equal(week.length, 3);

  // 分钟级别不能拿日线兜底
  assert.deepEqual(await market.fetchKlineRaw('usDXY', 'm1', 320), []);
});

test('美元指数分时和五日：东财不可用时用新浪 getOldMinKLine 兜底', async function () {
  const fxRows = [];
  const dates = ['2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
  dates.forEach(function (d) {
    fxRows.push({ d: d + ' 09:00:00', o: '10', h: '12', l: '9', c: '11' });
    fxRows.push({ d: d + ' 09:05:00', o: '11', h: '13', l: '10', c: '12' });
  });
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      if (url.indexOf('getOldMinKLine') >= 0) {
        assert.ok(url.indexOf('datalen=1440') >= 0);
        return { result: { data: fxRows } };
      }
      throw new Error('unexpected ' + url);
    }
  });
  const market = createMarket({ http: http });

  // 1 分钟 K 的价格序列（列表折线）
  const pts = await market.fetchMinuteSeries('usDXY');
  assert.equal(pts.length, 10);
  assert.equal(pts[pts.length - 1], 12);

  // 五日：按交易日归并，每天两个 5 分钟点
  const days = await market.fetchFiveDay('usDXY');
  assert.equal(days.length, 5);
  assert.equal(days[0].date, '2026-11-13');
  assert.equal(days[4].date, '2026-11-19');
  assert.deepEqual(days[4].points.map(function (p) { return p.price; }), [11, 12]);
});

test('外盘分时兜底：hf_XAU / hf_OIL 走新浪外盘分时', async function () {
  const http = makeHttp({
    json: function (url) {
      assert.ok(url.indexOf('getGlobalFuturesMinLine') >= 0, url);
      assert.ok(/symbol=(XAU|OIL)/.test(url), url);
      return {
        result: {
          data: {
            minLine_1d: [
              ['2026-11-19', '3724.67', 'LIFFE', '', '07:00', '3730', '0', '0', '3729.815', '2026-11-19 07:00:00'],
              ['07:01', '3732.66', '7', '0', '3730.678', '2026-11-19 07:01:00'],
              ['bad', '1', '0', '0', '0', 'not-a-time']
            ]
          }
        }
      };
    }
  });
  const market = createMarket({ http: http });

  const xau = await market.fetchForeignMinute('hf_XAU');
  assert.equal(xau.date, '2026-11-19');
  assert.equal(xau.points.length, 2);
  assert.equal(xau.points[1].t, '2026-11-19 07:01');
  assert.equal(xau.points[1].price, 3732.66);
  assert.equal(xau.points[1].vol, 7);

  // 列表小折线复用同一条兜底链
  const pts = await market.fetchMinuteSeries('hf_XAU');
  assert.deepEqual(pts, [3724.67, 3732.66]);

  const oil = await market.fetchForeignMinute('hf_OIL');
  assert.equal(oil.points.length, 2);
});

test('hf_OIL 五日：东财 K 线 / trends2 都不可用时用新浪当天分时兜底', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      if (url.indexOf('getGlobalFuturesMinLine') >= 0) {
        return {
          result: {
            data: {
              minLine_1d: [
                ['09:00', '91.30', '0', '0', '91.27', '2026-11-19 09:00:00'],
                ['09:01', '91.32', '5', '0', '91.27', '2026-11-19 09:01:00'],
                ['09:02', '91.28', '3', '0', '91.27', '2026-11-19 09:02:00']
              ]
            }
          }
        };
      }
      throw new Error('unexpected ' + url);
    }
  });
  const market = createMarket({ http: http });
  const days = await market.fetchFiveDay('hf_OIL');
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-11-19');
  assert.equal(days[0].points.length, 3);
  assert.equal(days[0].points[2].price, 91.28);
});

test('上金所 Au(T+D)：日 K 用官网日线，并把今天这段实时分时拼成最后一根', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      if (url.indexOf('sge.com.cn/graph/Dailyhq') >= 0) {
        return {
          time: [
            ['2026-11-17', '831.79', '832.33', '825.5', '835.12'],
            ['2026-11-18', '831.19', '810.17', '809.35', '835.6']
          ]
        };
      }
      if (url.indexOf('SpotService.getMinLine') >= 0) {
        assert.ok(url.indexOf('symbol=AUTD') >= 0, url);
        return {
          result: {
            data: [
              ['20:00', '809.000', '809.000', '16', '810.100', '2026-11-19'],
              ['20:01', '809.200', '809.100', '20'],
              ['09:00', '795.000', '804.900', '300'],
              ['11:45', '796.600', '804.954', '174']
            ]
          }
        };
      }
      throw new Error('unexpected ' + url);
    }
  });
  const market = createMarket({ http: http });

  const rows = await market.fetchKlineRaw('sge_AUTD', 'day', 1200);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[2].slice(0, 5), ['2026-11-19', 809, 796.6, 809.2, 795]);

  // 周 K 由日 K 聚合，不能拿别的周期冒充
  const week = await market.fetchKlineRaw('sge_AUTD', 'week', 10);
  assert.equal(week.length, 1);
  assert.deepEqual(week[0].slice(0, 5), ['2026-11-19', 831.79, 796.6, 835.6, 795]);
});

test('上金所现货快照：东财 118 市场按 f59 小数位缩放，各品种用自己的 secid', async function () {
  const seen = [];
  const http = makeHttp({
    json: function (url) {
      seen.push(url);
      if (url.indexOf('secid=118.AU9999') >= 0) {
        return { data: { f43: 75850, f57: 'AU9999', f58: 'AU9999', f59: 2, f60: 80193, f170: -541 } };
      }
      if (url.indexOf('secid=118.AG9999') >= 0) {
        return { data: { f43: 1010000, f57: 'AG9999', f58: 'AG9999', f59: 2, f60: 1087800, f170: -715 } };
      }
      throw new Error('unexpected ' + url);
    }
  });
  const market = createMarket({ http: http });
  const snap = await market.fetchSnapshots(['sge_AU9999', 'sge_AG9999']);
  assert.equal(snap.sge_AU9999.name, '黄金9999');
  assert.equal(snap.sge_AU9999.price, 758.5);
  assert.equal(snap.sge_AU9999.prevClose, 801.93);
  assert.equal(snap.sge_AU9999.pct, -5.41);
  assert.equal(snap.sge_AG9999.name, '白银9999');
  assert.equal(snap.sge_AG9999.price, 10100);
  assert.equal(seen.length, 2);
});

test('国债期货快照：三位小数不能按两位还原（110110 是 110.110）', async function () {
  const http = makeHttp({
    json: function (url) {
      assert.ok(url.indexOf('secid=220.TM') >= 0, url);
      return { data: { f43: 110110, f57: 'TM', f58: '十债主连', f59: 3, f60: 110145, f170: -2 } };
    }
  });
  const market = createMarket({ http: http });
  const snap = await market.fetchSnapshots(['cf_TM']);
  assert.equal(snap.cf_TM.name, '十债主连');
  assert.equal(snap.cf_TM.price, 110.11);
  assert.equal(snap.cf_TM.prevClose, 110.145);
  assert.ok(Math.abs(snap.cf_TM.change + 0.035) < 1e-9);
});

test('国债期货主连：K 线走东财 220 市场，价格不再缩放', async function () {
  const http = makeHttp({
    json: function (url) {
      assert.ok(url.indexOf('secid=220.TM') >= 0, url);
      assert.ok(url.indexOf('klt=101') >= 0, url);
      return {
        data: {
          klines: [
            '2026-11-19,110.080,110.145,110.160,110.060,134446',
            '2026-11-20,110.160,110.110,110.180,110.095,71142'
          ]
        }
      };
    }
  });
  const market = createMarket({ http: http });
  const rows = await market.fetchKlineRaw('cf_TM', 'day', 10);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].slice(0, 5), ['2026-11-20', 110.16, 110.11, 110.18, 110.095]);
});

test('上金所快照：东财不可用时用新浪 SGE_AUTD 兜底', async function () {
  const http = makeHttp({
    json: function () { throw new Error('down'); },
    gbk: function (url) {
      assert.ok(url.indexOf('list=SGE_AUTD') >= 0, url);
      return 'var hq_str_SGE_AUTD="AUTD,黄金延期,Au(T+D),797.50,0,0,798.00,' +
        '799.00,795.00,810.10,797.40,797.50,1,2,1234,5678,2026-11-19 15:29:59,-1.56";';
    }
  });
  const market = createMarket({ http: http });
  const snap = await market.fetchSnapshots(['sge_AUTD']);
  assert.equal(snap.sge_AUTD.name, '黄金T+D');
  assert.equal(snap.sge_AUTD.price, 797.5);
  assert.equal(snap.sge_AUTD.prevClose, 810.1);
  assert.equal(snap.sge_AUTD.pct, -1.56);
  assert.ok(Math.abs(snap.sge_AUTD.change + 12.6) < 1e-6);
});

test('上金所 Au(T+D) 五日：新浪分时的 date 已是交易日，不再按 20:00 挪一天', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('eastmoney.com') >= 0) throw new Error('down');
      if (url.indexOf('SpotService.getMinLine') >= 0) {
        return {
          result: {
            data: [
              ['20:00', '809.000', '809.000', '16', '810.100', '2026-11-19'],
              ['20:01', '809.500', '809.300', '20'],
              ['09:00', '795.000', '804.900', '300'],
              ['09:01', '795.500', '804.900', '120']
            ]
          }
        };
      }
      throw new Error('unexpected ' + url);
    }
  });
  const market = createMarket({ http: http });
  const days = await market.fetchFiveDay('sge_AUTD');
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-11-19');
  assert.deepEqual(days[0].points.map(function (p) { return p.t; }), ['20:00', '20:01', '09:00', '09:01']);
});

test('上金所夜盘归并：周五 20:00 算下周一', function () {
  const rows = [
    ['2026-11-20 20:30', 10, 10, 10, 10, 0],
    ['2026-11-23 09:30', 11, 11, 11, 11, 0],
    ['2026-11-23 10:00', 12, 12, 12, 12, 0]
  ];
  const days = buildFiveDayRows(rows, true);
  assert.equal(days.length, 1);
  assert.equal(days[0].date, '2026-11-23');
  assert.equal(days[0].points.length, 3);
});

test('外盘 5 日按交易日夜盘归并，只取最近 5 天', function () {  const rows = [
    '2026-10-28 07:00,10,10,10,10,0',
    '2026-10-28 23:00,11,11,11,11,0',
    '2026-10-29 07:00,12,12,12,12,0',
    '2026-10-29 23:00,13,13,13,13,0',
    '2026-10-30 07:00,14,14,14,14,0',
    '2026-10-30 23:00,15,15,15,15,0',
    '2026-10-31 02:00,16,16,16,16,0',
    '2026-11-02 07:00,17,17,17,17,0',
    '2026-11-02 23:00,18,18,18,18,0',
    '2026-11-03 07:00,19,19,19,19,0',
    '2026-11-03 08:00,20,20,20,20,0'
  ];
  const days = buildFiveDayRows(rows);
  assert.deepEqual(days.map(function (d) { return d.date; }),
    ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03']);
  assert.ok(!isFinite(days[0].prec));
  assert.equal(days[1].prec, 11);
  assert.equal(days[0].points.length, 2);
  assert.equal(days[1].points.length, 2);
  assert.equal(days[2].points.length, 3);
  assert.equal(days[4].points[1].price, 20);
});

test('fetchFiveDay 走东财 5 分钟 K 线', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      return {
        data: {
          klines: [
            '2026-11-02 07:00,17,17,17,17,0',
            '2026-11-02 07:05,18,18,18,18,0',
            '2026-11-03 07:00,19,19,19,19,0',
            '2026-11-03 07:05,20,20,20,20,0'
          ]
        }
      };
    }
  });
  const market = createMarket({ http: http });
  const days = await market.fetchFiveDay('hf_XAU');
  assert.ok(urls[0].indexOf('klt=5') >= 0);
  assert.deepEqual(days.map(function (d) { return d.date; }), ['2026-11-02', '2026-11-03']);
  assert.equal(days[1].points[1].price, 20);
});

test('aggregateWeeklyRows 按 ISO 周聚合，开收高低量都对', function () {
  // 2026-11-02 是周一，11-06 周五收盘、11-09 下一周开始
  const weeks = aggregateWeeklyRows([
    ['2026-11-02', 10, 11, 12, 9, 100],
    ['2026-11-03', 11, 13, 14, 10, 200],
    ['2026-11-06', 13, 12, 15, 11, 300],
    ['2026-11-09', 12, 16, 17, 12, 400]
  ]);
  assert.equal(weeks.length, 2);
  // 开取首根、收取尾根、高取最大、低取最小、量累加
  assert.deepEqual(weeks[0], ['2026-11-06', 10, 12, 15, 9, 600]);
  assert.deepEqual(weeks[1], ['2026-11-09', 12, 16, 17, 12, 400]);
});

test('aggregateWeeklyRows 丢掉坏日期，跨年周不拆成两段', function () {
  // 2025-12-29（周一）~ 2026-01-02（周五）属于同一个 ISO 周
  const weeks = aggregateWeeklyRows([
    ['2025-12-29', 10, 10, 10, 10, 1],
    ['2026-01-02', 10, 11, 12, 9, 2],
    ['bad', 1, 2, 3, 0, 0],
    ['2026-01-05', 11, 12, 13, 10, 4]
  ]);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0][0], '2026-01-02');
  assert.equal(weeks[0][5], 3);
  assert.equal(weeks[1][0], '2026-01-05');
});

test('周K 走腾讯周期字段；分钟 K 腾讯只当兜底（东财先失败才轮到它）', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      // 东财分钟 K 返回空，才落到腾讯
      if (url.indexOf('eastmoney.com') >= 0) return { data: { klines: [] } };
      if (url.indexOf(',m5,') >= 0) {
        return { data: { sh600519: { qfqm5: ['2026-11-11 14:30', '1', '2', '3', '0.5', '10'] } } };
      }
      return { data: { sh600519: { qfqweek: ['2026-11-06', '1', '2', '3', '0.5', '10'] } } };
    }
  });
  const market = createMarket({ http: http });
  // fetchKlineRaw 原样返回腾讯给的行（开收高低量顺序由调用方切）
  assert.deepEqual(await market.fetchKlineRaw('sh600519', 'week', 520),
    ['2026-11-06', '1', '2', '3', '0.5', '10']);
  assert.deepEqual(await market.fetchKlineRaw('sh600519', 'm5', 320),
    ['2026-11-11 14:30', '1', '2', '3', '0.5', '10']);
  assert.ok(urls[0].indexOf('sh600519,week,,,520,qfq') >= 0);
  // 分钟 K：先东财、后腾讯
  assert.ok(urls[1].indexOf('eastmoney.com') >= 0 && urls[1].indexOf('klt=5') >= 0);
  assert.ok(urls[2].indexOf('sh600519,m5,,,320,qfq') >= 0);
});

test('外盘周K 用东财 klt=102，分钟 K 用对应 klt；没有分钟数据时返回空', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      // 分钟 K 东财返回空，走新浪外盘日 K 也聚合不出分钟，最终是空数组
      if (url.indexOf('klt=5') >= 0) return { data: { klines: [] } };
      return { data: { klines: ['2026-11-06,10,11,12,9,5'] } };
    }
  });
  const market = createMarket({ http: http });
  const week = await market.fetchKlineRaw('hf_XAU', 'week', 260);
  assert.ok(urls[0].indexOf('klt=102') >= 0);
  assert.deepEqual(week, [['2026-11-06', 10, 11, 12, 9, 5]]);

  const minRows = await market.fetchKlineRaw('hf_XAU', 'm5', 320);
  assert.ok(urls[1].indexOf('klt=5') >= 0);
  assert.deepEqual(minRows, []);
});

test('MIN_INTERVAL / SINA_SCALE 覆盖分时级别与周线', function () {
  assert.deepEqual(MIN_INTERVAL, { m1: 1, m5: 5, m15: 15, m30: 30, m60: 60 });
  assert.equal(SINA_SCALE.m1, 1);
  assert.equal(SINA_SCALE.m5, 5);
  assert.equal(SINA_SCALE.m15, 15);
  assert.equal(SINA_SCALE.m30, 30);
  assert.equal(SINA_SCALE.m60, 60);
  assert.equal(SINA_SCALE.week, 1200);
});

test('分钟 K 优先走东财：A 股 / 港股 / 美股指数都能拿到多天历史', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      return { data: { klines: ['2026-11-11 14:30,10,11,12,9,5'] } };
    }
  });
  const market = createMarket({ http: http });

  // 上证指数 → 1.000001，恒生科技 → 124.HSTECH，道指 → 100.DJIA
  const cases = [
    ['sh000001', 'm5', '1.000001', 5],
    ['sz000001', 'm15', '0.000001', 15],
    ['bj899050', 'm30', '0.899050', 30],
    ['hkHSTECH', 'm5', '124.HSTECH', 5],
    ['usDJI', 'm60', '100.DJIA', 60],
    ['hf_XAU', 'm5', '122.XAU', 5],
    ['em931787', 'm5', '2.931787', 5],
    ['sh600519', 'm1', '1.600519', 1]
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const rows = await market.fetchKlineRaw(c[0], c[1], 320);
    assert.equal(rows.length, 1, c[0] + ' 应拿到东财分钟 K');
    assert.ok(urls[i].indexOf('secid=' + c[2]) >= 0, c[0] + ' secid 应为 ' + c[2] + '，实际 ' + urls[i]);
    assert.ok(urls[i].indexOf('klt=' + c[3]) >= 0, c[0] + ' klt 应为 ' + c[3]);
    assert.ok(urls[i].indexOf('lmt=320') >= 0);
  }
});

test('新浪外盘：东财给不出分钟 K 时返回空，不拿日 K 冒充', async function () {
  // 东财给不出分钟数据时返回空，不能把日 K 冒充成分钟 K
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('klt=') >= 0) return { data: { klines: [] } };
      return { result: { data: [] } };
    }
  });
  const market = createMarket({ http: http });
  assert.deepEqual(await market.fetchKlineRaw('hf_GC', 'm15', 320), []);
  // 1 分钟同样不能拿日 K 冒充
  assert.deepEqual(await market.fetchKlineRaw('hf_GC', 'm1', 320), []);
});

test('1 分钟 K 走东财 klt=1；东财没数据时新浪用 scale=1，不落回日 K', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      if (url.indexOf('eastmoney.com') >= 0) return { data: { klines: [] } };
      if (url.indexOf('/appstock/app/fqkline/get') >= 0) {
        return { data: { sh600519: { m1: [['2026-11-19', '1', '2', '3', '0.5', '10']] } } };
      }
      return { data: {} };
    },
    text: function (url) {
      urls.push(url);
      return 'x=([{"day":"2026-11-19 10:09:00","open":"1","close":"2","high":"3","low":"0.5","volume":"10"}]);';
    }
  });
  const market = createMarket({ http: http });
  const rows = await market.fetchKlineRaw('sh600519', 'm1', 320);
  assert.deepEqual(rows, [['2026-11-19 10:09:00', '1', '2', '3', '0.5', '10']]);
  assert.ok(urls.some(function (u) {
    return u.indexOf('eastmoney.com') >= 0 && u.indexOf('klt=1') >= 0;
  }), '1 分钟应先请求东财 klt=1');
  // 腾讯 m1 返回的是日线形状的数据，不能走这条路
  assert.ok(!urls.some(function (u) { return u.indexOf(',m1,') >= 0; }), '不应请求腾讯 m1');
  assert.ok(urls.some(function (u) { return u.indexOf('scale=1') >= 0; }), '新浪兜底应使用 scale=1');
});

test('em 前缀的东财专属指数：快照 / 分时都走 2.xxxxxx', async function () {
  const urls = [];
  const http = makeHttp({
    json: function (url) {
      urls.push(url);
      if (url.indexOf('stock/get') >= 0) {
        return { data: { f43: 131025, f57: '931787', f58: '港股创新药', f60: 134874, f170: -285 } };
      }
      if (url.indexOf('trends2') >= 0) {
        return { data: { trends: [
          '2026-11-16 09:30,1300.0,1310.25,1315.0,1298.0,10,0,1305.0',
          '2026-11-16 09:31,1310.25,1311.00,1313.0,1309.0,12,0,1307.0'
        ] } };
      }
      return { data: {} };
    }
  });
  const market = createMarket({ http: http });

  const snap = await market.fetchSnapshots(['em931787']);
  assert.ok(urls[0].indexOf('secid=2.931787') >= 0);
  assert.equal(snap.em931787.name, '港股创新药');
  assert.equal(snap.em931787.price, 1310.25);
  assert.equal(snap.em931787.prevClose, 1348.74);
  assert.equal(snap.em931787.pct, -2.85);

  const pts = await market.fetchMinuteSeries('em931787');
  assert.deepEqual(pts, [1310.25, 1311]);
  assert.ok(urls[1].indexOf('secid=2.931787') >= 0);
});

test('东财快照失败时 em 指数用中证补名称和价格，并识别港元指数', async function () {
  const calls = { snapshot: 0, info: 0, quote: 0 };
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('stock/get') >= 0) {
        calls.snapshot++;
        throw new Error('fetch failed');
      }
      if (url.indexOf('index-basic-info') >= 0) {
        calls.info++;
        return { data: {
          indexFullNameCn: '中证香港创新药指数',
          indexShortNameCn: '港股创新药',
          currencyCn: '港元',
          currencyEn: 'HKD'
        } };
      }
      if (url.indexOf('index-perf-oneday') >= 0) {
        calls.quote++;
        return { data: {
          intraDayHeader: {
            tradeDate: '2026-11-16', current: 1313.62, closePre: 1348.74, changePct: -2.6
          },
          intraDayPerfList: []
        } };
      }
      throw new Error('unexpected json: ' + url);
    }
  });
  const market = createMarket({ http: http });

  const snap = await market.fetchSnapshots(['em931787']);
  assert.equal(snap.em931787.name, '港股创新药');
  // 价格 / 昨收 / 涨跌幅都从中证补，不能让列表拿最后一分钟和前一分比出 +0.3%
  assert.equal(snap.em931787.price, 1313.62);
  assert.equal(snap.em931787.prevClose, 1348.74);
  assert.equal(snap.em931787.pct, -2.6);
  assert.ok(Math.abs(snap.em931787.change - (1313.62 - 1348.74)) < 1e-9);
  assert.equal(calls.info, 1);
  assert.equal(calls.quote, 1);

  // 同一代码命中缓存，不重复请求中证基本信息 / 快照
  const info = await market.fetchCsindexInfo('em931787');
  assert.equal(info.name, '港股创新药');
  assert.equal(info.hk, true);
  const quote = await market.fetchCsindexQuote('em931787');
  assert.equal(quote.price, 1313.62);
  assert.equal(calls.info, 1);
  assert.equal(calls.quote, 1);
});

test('非港股主题的中证指数不会被当成 16:00 收盘', async function () {
  const http = makeHttp({
    json: function (url) {
      if (url.indexOf('index-basic-info') >= 0) {
        return { data: { indexShortNameCn: '动漫游戏', currencyCn: '人民币', currencyEn: 'CNY' } };
      }
      return { data: {} };
    }
  });
  const market = createMarket({ http: http });
  const info = await market.fetchCsindexInfo('930901');
  assert.equal(info.name, '动漫游戏');
  assert.equal(info.hk, false);

  // 非 6 位数字 / 非法代码不请求接口
  assert.equal(await market.fetchCsindexInfo('sh000001'), null);
});

test('searchSymbols 腾讯查不到时用东财补指数，6 位基金仍然兜底', async function () {
  const emPayload = {
    QuotationCodeTable: {
      Data: [{
        Code: '931787', Name: '港股创新药', SecurityTypeName: '指数', QuoteID: '2.931787'
      }, {
        Code: '000300', Name: '沪深300', SecurityTypeName: '指数', QuoteID: '1.000300'
      }]
    }
  };
  const hs300Payload = {
    QuotationCodeTable: {
      Data: [{ Code: '000300', Name: '沪深300', SecurityTypeName: '指数', QuoteID: '1.000300' }]
    }
  };
  const http = makeHttp({
    gbk: function () { return 'v_hint="N"'; },
    json: function (url) {
      return decodeURIComponent(url).indexOf('沪深300') >= 0 ? hs300Payload : emPayload;
    }
  });
  const market = createMarket({ http: http });

  const list = await market.searchSymbols('931787');
  const hit = list.find(function (x) { return x.code === 'em931787'; });
  assert.ok(hit);
  assert.equal(hit.name, '港股创新药');
  assert.equal(hit.typeLabel, '指数');

  const hs300 = await market.searchSymbols('沪深300');
  assert.equal(hs300[0].code, 'sh000300');

  const fundHttp = makeHttp({
    gbk: function () { return 'v_hint="N"'; },
    json: function () { return { QuotationCodeTable: { Data: [] } }; }
  });
  const market2 = createMarket({ http: fundHttp });
  const fund = await market2.searchSymbols('001186');
  assert.deepEqual(fund.map(function (x) { return x.code; }), ['001186']);
});
