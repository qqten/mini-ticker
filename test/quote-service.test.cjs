'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttp } = require('../electron/data/http.cjs');
const { createQuoteService } = require('../electron/data/quote-service.cjs');

function makeHttp() {
  // 这些测试不会发真实请求，只需要 singleFlight。
  return createHttp({
    fetchImpl: function () { throw new Error('测试里不应发请求'); }
  });
}

function makeMarket() {
  const calls = { snapshots: 0, minute: 0, series: 0, estimates: 0, nav: 0 };
  return {
    calls: calls,
    fetchSnapshots: async function (codes) {
      calls.snapshots++;
      const out = {};
      codes.forEach(function (code, i) {
        const pct = code === 'sh000001' ? 1 : 5 + i;
        out[code] = {
          name: '名称' + code, price: 10 + i, prevClose: 9 + i, pct: pct, change: 1
        };
      });
      return out;
    },
    fetchMinuteSeries: async function () {
      calls.minute++;
      return [9, 10];
    },
    fetchSeries: async function () {
      calls.series++;
      return [8, 9, 10];
    },
    fetchFundEstimates: async function (codes) {
      calls.estimates++;
      const out = {};
      codes.forEach(function (code) {
        out[code] = { name: '基金' + code, price: 1.5, prevClose: 1.4, pct: 7.14, time: '15:00' };
      });
      return out;
    },
    fetchFundNav: async function () {
      calls.nav++;
      return { name: '基金', rows: [['2026-01-01', 1.2], ['2026-02-01', 1.4]], last: 1.4, prev: 1.2 };
    }
  };
}

function makeFundStore() {
  return {
    recorded: [],
    record: function (code, est) { this.recorded.push({ code: code, price: est.price, time: est.time }); },
    series: function () { return { values: [1.4, 1.5], x: [1, 2] }; }
  };
}

function makeService(overrides) {
  const cfg = Object.assign({ symbols: ['sh000001', '001186'], period: 'minute', sortMode: 'off' }, overrides);
  const market = makeMarket();
  const fundStore = makeFundStore();
  const service = createQuoteService({
    market: market,
    http: makeHttp(),
    fundStore: fundStore,
    getConfig: function () { return cfg; }
  });
  return { cfg: cfg, market: market, fundStore: fundStore, service: service };
}

test('fetchAll 组合行情和场外基金，displayCodes 跟随配置顺序', async function () {
  const ctx = makeService();
  const list = await ctx.service.fetchAll();

  assert.equal(list.length, 2);
  assert.equal(list[0].code, 'sh000001');
  assert.equal(list[0].name, '名称sh000001');
  assert.equal(list[0].points.length, 2);

  assert.equal(list[1].code, '001186');
  assert.equal(list[1].fund, true);
  assert.deepEqual(list[1].points, [1.4, 1.5]);
  assert.deepEqual(list[1].xIndex, [1, 2]);

  assert.deepEqual(ctx.service.getDisplayCodes(), ['sh000001', '001186']);
  assert.equal(ctx.fundStore.recorded.length, 1);
  assert.equal(ctx.fundStore.recorded[0].code, '001186');
});

test('sortMode 改变显示顺序，但返回的 items 也按同样顺序', async function () {
  const ctx = makeService({ symbols: ['sh000001', 'sz399001'], period: 'minute', sortMode: 'pct-desc' });
  const list = await ctx.service.fetchAll();
  assert.deepEqual(list.map(function (x) { return x.code; }), ['sz399001', 'sh000001']);
  assert.deepEqual(ctx.service.getDisplayCodes(), ['sz399001', 'sh000001']);
});

test('并发 fetchAll 只跑一轮请求（single-flight）', async function () {
  const ctx = makeService({ symbols: ['sh000001'], sortMode: 'off' });
  const [a, b] = await Promise.all([ctx.service.fetchAll(), ctx.service.fetchAll()]);
  assert.equal(a, b);
  assert.equal(ctx.market.calls.snapshots, 1);
  assert.equal(ctx.market.calls.minute, 1);
});

test('折线缓存：同周期内复用；resetSeriesCache 后重拉', async function () {
  const ctx = makeService({ symbols: ['sh000001'], period: 'minute', sortMode: 'off' });
  await ctx.service.fetchAll();
  await ctx.service.fetchAll();
  assert.equal(ctx.market.calls.minute, 1);

  ctx.service.resetSeriesCache();
  await ctx.service.fetchAll();
  assert.equal(ctx.market.calls.minute, 2);
});

test('切换周期后重新拉 K 线', async function () {
  const ctx = makeService({ symbols: ['sh000001'], period: 'minute', sortMode: 'off' });
  await ctx.service.fetchAll();
  ctx.cfg.period = 'day';
  const list = await ctx.service.fetchAll();

  assert.equal(ctx.market.calls.series, 1);
  assert.deepEqual(list[0].points, [8, 9, 10]);
  assert.equal(list[0].range, true);
});

test('行情接口整体失败时仍返回结构完整的列表', async function () {
  const ctx = makeService({ symbols: ['sh000001'], period: 'minute', sortMode: 'off' });
  ctx.market.fetchSnapshots = async function () { throw new Error('offline'); };
  ctx.market.fetchMinuteSeries = async function () { throw new Error('offline'); };

  const list = await ctx.service.fetchAll();
  assert.equal(list.length, 1);
  assert.equal(list[0].ok, false);
  assert.deepEqual(list[0].points, []);
});

test('getDisplayCodes 返回副本，外部改动不影响内部状态', async function () {
  const ctx = makeService({ symbols: ['sh000001'], sortMode: 'off' });
  await ctx.service.fetchAll();
  const codes = ctx.service.getDisplayCodes();
  codes.push('hacked');
  assert.deepEqual(ctx.service.getDisplayCodes(), ['sh000001']);
});

test('切换自选时旧一轮晚回来不会覆盖新的显示顺序', async function () {
  const ctx = makeService({ symbols: ['sh000001'], period: 'minute', sortMode: 'off' });
  const pending = [];
  ctx.market.fetchSnapshots = function (codes) {
    return new Promise(function (resolve) { pending.push({ codes: codes, resolve: resolve }); });
  };

  const first = ctx.service.fetchAll();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(pending.length, 1);

  ctx.cfg.symbols = ['sz399001'];
  const second = ctx.service.fetchAll();
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(pending.length, 2);

  pending[1].resolve({ sz399001: { name: '新', price: 2, prevClose: 1, pct: 100, change: 1 } });
  const fresh = await second;
  assert.deepEqual(fresh.map(function (x) { return x.code; }), ['sz399001']);
  assert.deepEqual(ctx.service.getDisplayCodes(), ['sz399001']);

  // 旧一轮此刻才返回：数据可以返回给调用方，但不能把显示顺序改回去
  pending[0].resolve({ sh000001: { name: '旧', price: 1, prevClose: 1, pct: 0, change: 0 } });
  const stale = await first;
  assert.deepEqual(stale.map(function (x) { return x.code; }), ['sh000001']);
  assert.deepEqual(ctx.service.getDisplayCodes(), ['sz399001']);
});
