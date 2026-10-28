'use strict';

const { buildItem, sortItems, buildFundItem } = require('../core/quotes.cjs');
const { isFundCode } = require('../core/symbols.cjs');
const { runPool } = require('../core/utils.cjs');
const { NAMES } = require('../core/constants.cjs');

// 分时线 20s 一拉；K 线变化慢，60s 一拉
const MINUTE_TTL = 20000;
const KLINE_TTL = 60000;

// 屏幕上实际的显示顺序。开了涨跌幅排序后跟 config.symbols 不一样，
// 聚焦图表的序号和 ↑↓ 切换要照着这个走，否则高亮会乱跳。
function createQuoteService(options) {
  options = options || {};
  const market = options.market;
  const http = options.http;
  const fundStore = options.fundStore;
  const log = typeof options.log === 'function' ? options.log : function () {};
  const getConfig = options.getConfig;
  const names = options.names || NAMES;

  if (!market) throw new Error('createQuoteService 需要 market 实例');
  if (!getConfig) throw new Error('createQuoteService 需要 getConfig');

  let seriesCache = { at: 0, map: {}, period: null };
  // 取数失败只记一次日志，避免每 3 秒刷屏
  let seriesFailLogged = {};
  let displayCodes = [];
  // 自选/周期变了会并发起新的一轮；只有最后发起的那轮能改显示顺序，
  // 否则先发的旧结果晚回来会把新顺序盖掉。
  let runSeq = 0;

  async function loadSeries(quoteCodes, period) {
    const now = Date.now();
    const ttl = period === 'minute' ? MINUTE_TTL : KLINE_TTL;
    if (now - seriesCache.at > ttl || seriesCache.period !== period) {
      const map = {};
      await runPool(quoteCodes, 4, async function (code) {
        let pts = [];
        try {
          if (period === 'minute') {
            pts = await market.fetchMinuteSeries(code);
            // 美股指数等没有分时接口，退回日线，保证折线不空
            if (pts.length < 2) pts = await market.fetchSeries(code, 'day');
          } else {
            pts = await market.fetchSeries(code, period);
          }
        } catch (error) {
          const old = seriesCache.period === period ? seriesCache.map[code] : null;
          pts = old || [];
          // 同一个标的不要每次轮询都刷日志，只记第一次
          if (!pts.length && !seriesFailLogged[code]) {
            seriesFailLogged[code] = true;
            log('[quote]', code + ' 折线取数失败：' + error.message);
          }
        }
        map[code] = pts;
        if (pts.length) seriesFailLogged[code] = false;
      });
      seriesCache = { at: now, map: map, period: period };
    }
    return seriesCache.map;
  }

  async function doFetchAll(cfg, seq) {
    const all = cfg.symbols.slice();
    const period = cfg.period || 'minute';
    const fundCodes = all.filter(isFundCode);
    const quoteCodes = all.filter(function (c) { return !isFundCode(c); });

    // 行情类：实时快照（一次请求拿全部）
    let snap = {};
    if (quoteCodes.length) {
      try {
        snap = await market.fetchSnapshots(quoteCodes);
      } catch (error) {
        snap = {};
      }
    }

    // 场外基金：盘中估值（批量）
    let funds = {};
    if (fundCodes.length) {
      try {
        funds = await market.fetchFundEstimates(fundCodes);
      } catch (error) {
        funds = {};
      }
      // 每轮都把估值记进当日分时：这类基金没有分钟行情，曲线只能自己攒
      if (fundStore) {
        Object.keys(funds).forEach(function (c) { fundStore.record(c, funds[c]); });
      }
    }

    const seriesMap = await loadSeries(quoteCodes, period);

    // 基金净值：pingzhongdata 自带 30 分钟缓存
    const fundNav = {};
    if (fundCodes.length) {
      await runPool(fundCodes, 3, async function (code) {
        try {
          fundNav[code] = await market.fetchFundNav(code);
        } catch (error) {
          fundNav[code] = null;
        }
      });
    }

    const items = all.map(function (code) {
      if (isFundCode(code)) {
        return buildFundItem(code, funds[code], fundNav[code], {
          period: period,
          names: names,
          minuteSeries: fundStore ? fundStore.series : null
        });
      }
      return buildItem(code, snap[code], seriesMap[code] || [], {
        period: period,
        names: names
      });
    });
    const sorted = sortItems(items, cfg.sortMode);
    if (seq === runSeq) displayCodes = sorted.map(function (it) { return it.code; });
    return sorted;
  }

  // 同一时刻只跑一份：轮询间隔比网络慢时，后来的调用复用前一个 Promise，
  // 避免请求叠加，也避免两轮结果乱序覆盖。
  function fetchAll() {
    const cfg = getConfig();
    if (!cfg || !Array.isArray(cfg.symbols)) return Promise.resolve([]);
    const key = 'quotes|' + (cfg.period || 'minute') + '|' + (cfg.sortMode || 'off') +
      '|' + cfg.symbols.join(',');
    // seq 在任务真正开始时才递增：命中 single-flight 的重复调用不该推进代数。
    const run = function () {
      const seq = ++runSeq;
      return doFetchAll(cfg, seq);
    };
    return http ? http.singleFlight(key, run) : run();
  }

  function getDisplayCodes() {
    return displayCodes.slice();
  }

  function resetSeriesCache() {
    seriesCache = { at: 0, map: {}, period: null };
  }

  return { fetchAll, getDisplayCodes, resetSeriesCache };
}

module.exports = { createQuoteService, MINUTE_TTL, KLINE_TTL };
