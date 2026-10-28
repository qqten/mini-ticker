'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMarket } = require('../electron/data/market.cjs');

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
        return { data: { trends: ['2026-10-28 09:30,100.1,0,0,0', '2026-10-28 09:31,100.2,0,0,0'] } };
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
