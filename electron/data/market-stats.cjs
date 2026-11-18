'use strict';

const { parseTrends, buildMarketSnapshot } = require('../core/market-stats.cjs');
const { HEADERS } = require('./market.cjs');

// 概览（涨跌家数 / 成交额）变化快，3 秒刷新一次；昨日分时序列一天只变一次，
// 60 秒拉一次足够，也避免每轮都打两个大接口。
const OVERVIEW_TTL = 3000;
const TRENDS_TTL = 60000;

const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
// 上证指数 = 沪市，深证成指 = 深市。成交额 / 涨跌家数都是整个市场的口径。
const MARKET_SECIDS = ['1.000001', '0.399001'];

// 大盘概览取数：真实请求全部放在后台，get-quotes 只读 peek() 的缓存，
// 这样行情轮询不会被东财接口拖慢。
function createMarketStats(options) {
  options = options || {};
  const http = options.http;
  const log = typeof options.log === 'function' ? options.log : function () {};
  if (!http) throw new Error('createMarketStats 需要 http 实例');

  let overview = { at: 0, data: null };
  let trends = { at: 0, data: null };
  let snapshot = null;
  let running = null;
  const failed = { overview: false, trends: false };

  function noteFailure(key, error) {
    if (!failed[key]) {
      failed[key] = true;
      log('[market]', '大盘概览' + (key === 'trends' ? '分时序列' : '快照') +
        '获取失败：' + (error && error.message ? error.message : error));
    }
  }

  function noteSuccess(key) {
    if (failed[key]) {
      failed[key] = false;
      log('[market]', '大盘概览' + (key === 'trends' ? '分时序列' : '快照') + '已恢复');
    }
  }

  async function fetchOverview() {
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2' +
      '&secids=' + MARKET_SECIDS.join(',') +
      '&fields=f2,f3,f4,f6,f12,f13,f14,f104,f105,f106&ut=' + EM_UT;
    const j = await http.fetchJson(url, {
      headers: HEADERS, timeout: 4000, retries: 1, tag: 'market-overview'
    });
    const diff = j && j.data && j.data.diff;
    if (!Array.isArray(diff) || !diff.length) throw new Error('概览没有行情数据');

    let up = 0;
    let down = 0;
    let flat = 0;
    let amount = 0;
    diff.forEach(function (row) {
      if (!row) return;
      const u = Number(row.f104);
      const d = Number(row.f105);
      const f = Number(row.f106);
      const a = Number(row.f6);
      if (isFinite(u) && u > 0) up += u;
      if (isFinite(d) && d > 0) down += d;
      if (isFinite(f) && f > 0) flat += f;
      if (isFinite(a) && a > 0) amount += a;
    });
    return { up: up, down: down, flat: flat, amount: amount };
  }

  async function fetchTrends() {
    const results = await Promise.all(MARKET_SECIDS.map(async function (secid) {
      const url = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
        '&iscr=0&ndays=2&ut=' + EM_UT;
      const j = await http.fetchJson(url, {
        headers: HEADERS, timeout: 4000, retries: 1, tag: 'market-trends'
      });
      return parseTrends(j && j.data && j.data.trends);
    }));
    if (!results.some(function (list) { return list.length > 0; })) {
      throw new Error('分时序列没有数据');
    }
    return results;
  }

  function stale(cache, ttl) {
    return !cache.data || Date.now() - cache.at >= ttl;
  }

  // 后台刷新：同一个时刻只跑一轮；行情轮询再次调用时直接复用。
  function ensure() {
    if (running) return running;
    const needOverview = stale(overview, OVERVIEW_TTL);
    const needTrends = stale(trends, TRENDS_TTL);
    if (!needOverview && !needTrends) return Promise.resolve(snapshot);

    running = Promise.all([
      needOverview
        ? fetchOverview().then(function (data) {
          overview = { at: Date.now(), data: data };
          noteSuccess('overview');
        }).catch(function (e) { noteFailure('overview', e); })
        : null,
      needTrends
        ? fetchTrends().then(function (data) {
          trends = { at: Date.now(), data: data };
          noteSuccess('trends');
        }).catch(function (e) { noteFailure('trends', e); })
        : null
    ]).then(function () {
      // 任何一边失败都保留上一次成功的数据，快照仍然可画；缺的字段在渲染层显示 --。
      snapshot = buildMarketSnapshot({
        overview: overview.data,
        trends: trends.data,
        now: new Date()
      });
      return snapshot;
    }).finally(function () {
      running = null;
    });
    return running;
  }

  function peek() {
    return snapshot;
  }

  return {
    ensure: ensure,
    peek: peek
  };
}

module.exports = { createMarketStats, OVERVIEW_TTL, TRENDS_TTL };
