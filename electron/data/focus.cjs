'use strict';

const { NAMES, EM_SECID, HF_EM_SECID } = require('../core/constants.cjs');
const { num } = require('../core/utils.cjs');
const { HEADERS } = require('./market.cjs');

const FOCUS_TABS = ['minute', 'five', 'day'];
const FOCUS_SESSION_A = 242;   // A 股一个交易日：09:30-11:30 + 13:00-15:00，含首尾共 242 个分钟点
const FOCUS_SESSION_HK = 332;  // 港股：09:30-12:00 + 13:00-16:00
const FOCUS_SESSION_US = 392;  // 美股：09:30-16:00（东部时间）
const FOCUS_SESSION_HF = 1440; // 外盘期货/美元指数：近乎 24 小时连续交易（实际约 1380 分钟），留足余量
const FOCUS_TTL = { minute: 15000, five: 60000, day: 60000 };

function sessionMinutes(code) {
  if (/^hf_/i.test(code) || /^usDXY$/i.test(code)) return FOCUS_SESSION_HF;
  if (/^hk/i.test(code)) return FOCUS_SESSION_HK;
  if (/^us/i.test(code)) return FOCUS_SESSION_US;
  return FOCUS_SESSION_A;
}

// 分时原始行：`0930 3714.48 3228780 5179731313.30`（时间 价格 累计量 累计额）
// 累计量要差分回每分钟成交量；均价线用「价格×该分钟量」累加算 VWAP，
// 不能用 累计额/累计量 —— 指数的量是手、额是元，除出来是市场平均股价，不是点位。
function parseMinuteLines(lines) {
  const pts = [];
  let prevCum = 0, cumVol = 0, cumPV = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = String(lines[i]).trim().split(/\s+/);
    const t = f[0];
    const p = num(f[1]);
    const cum = num(f[2]);
    if (!isFinite(p) || !/^\d{3,4}$/.test(t)) continue;
    let v = isFinite(cum) ? cum - prevCum : 0;
    if (!(v > 0)) v = 0;
    if (isFinite(cum)) prevCum = cum;
    cumVol += v;
    cumPV += p * v;
    pts.push({ t: t, price: p, vol: v, avg: cumVol > 0 ? cumPV / cumVol : p });
  }
  return pts;
}

// 聚焦图表的取数与缓存。窗口/热键/状态仍留在 main，这里只负责
// 「给定 code + tab，拿到可渲染的数据」，方便单独测试和复用。
function createFocusService(options) {
  const opts = options || {};
  const market = opts.market;
  const http = opts.http;
  if (!market || !http) throw new Error('createFocusService 需要 market 和 http');

  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const ttl = Object.assign({}, FOCUS_TTL, opts.ttl || {});
  const cache = {};

  async function buildPayload(code, tab) {
    const snapP = market.fetchSnapshots([code]).catch(function () { return {}; });
    let name = NAMES[code] || code;
    let price = NaN, pct = NaN, prevClose = NaN, change = NaN;
    let days = [];
    let candles = [];
    const session = sessionMinutes(code);

    if (tab === 'day') {
      const rows = await market.fetchKlineRaw(code, 'day', 160);
      candles = rows.map(function (r) {
        return { d: String(r[0]), o: num(r[1]), c: num(r[2]), h: num(r[3]), l: num(r[4]), v: num(r[5]) };
      }).filter(function (x) { return isFinite(x.c) && isFinite(x.o) && isFinite(x.h) && isFinite(x.l); });
      if (candles.length) {
        const last = candles[candles.length - 1];
        price = last.c;
        if (candles.length > 1) prevClose = candles[candles.length - 2].c;
        if (!isFinite(prevClose) || prevClose === 0) prevClose = last.o;
        pct = ((price - prevClose) / prevClose) * 100;
        change = price - prevClose;
      }
    } else if (tab === 'five') {
      const j = await market.fetchTencentJson('/appstock/app/day/query?code=' + encodeURIComponent(code));
      const block = j && j.data && j.data[code];
      const arr = (block && block.data) || [];
      // 接口按「今天 → 前 4 天」倒序给，画图要正序
      const list = arr.slice().sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date));
      });
      days = list.map(function (d) {
        const pts = parseMinuteLines(d.data || []);
        return { date: String(d.date || ''), prec: num(d.prec), points: pts };
      }).filter(function (d) { return d.points.length > 1; });
      if (days.length) {
        const lastDay = days[days.length - 1];
        const lastPt = lastDay.points[lastDay.points.length - 1];
        price = lastPt.price;
        prevClose = lastDay.prec;
        if (!isFinite(prevClose) || !prevClose) prevClose = days[0].points[0].price;
        pct = ((price - prevClose) / prevClose) * 100;
        change = price - prevClose;
      }
    } else {
      // 外盘期货 / 美元指数：腾讯没有分时，走东财 trends2（与主浮窗一致）
      const emSecid = EM_SECID[code] || HF_EM_SECID[code];
      if (emSecid) {
        const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + emSecid +
          '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
        const j = await http.fetchJson(url, {
          headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute'
        });
        const trends = (j && j.data && j.data.trends) || [];
        // trends 行：时间,价,涨跌额,涨跌幅,当日累计量 → 累计量差分回每分钟量
        const pts = [];
        let prevCum = 0;
        for (const t of trends) {
          const f = String(t).split(',');
          const p = num(f[1]);
          if (!isFinite(p)) continue;
          const cum = num(f[4]);
          let v = isFinite(cum) ? cum - prevCum : 0;
          if (v < 0) v = 0;
          if (isFinite(cum)) prevCum = cum;
          pts.push({ t: f[0], price: p, vol: v });
        }
        if (pts.length > 1) {
          days = [{ date: String((j.data && j.data.date) || ''), prec: NaN, points: pts }];
          const lastPt = pts[pts.length - 1];
          price = lastPt.price;
          // trends2 里没有昨收列，prevClose/pct/change 交给下方 snap 快照填充
        }
      } else {
        const j = await market.fetchTencentJson('/appstock/app/minute/query?code=' + encodeURIComponent(code));
        const block = j && j.data && j.data[code];
        const lines = (block && block.data && block.data.data) || [];
        const qt = (block && block.qt && block.qt[code]) || [];
        const pts = parseMinuteLines(lines);
        if (pts.length > 1) {
          days = [{ date: String((block.data && block.data.date) || ''), prec: num(qt[4]), points: pts }];
          const lastPt = pts[pts.length - 1];
          price = lastPt.price;
          prevClose = num(qt[4]);
          pct = num(qt[32]);
          change = num(qt[31]);
          if (qt[1]) name = qt[1];
          if (!isFinite(prevClose) || !prevClose) prevClose = pts[0].price;
          if (!isFinite(pct)) pct = ((price - prevClose) / prevClose) * 100;
        }
      }
    }

    const snap = await snapP;
    if (snap && snap[code]) {
      if (snap[code].name) name = snap[code].name;
      if (!isFinite(price) && isFinite(snap[code].price)) price = snap[code].price;
      if (!isFinite(prevClose) && isFinite(snap[code].prevClose)) prevClose = snap[code].prevClose;
      if (!isFinite(pct) && isFinite(snap[code].pct)) pct = snap[code].pct;
    }

    const hasData = tab === 'day' ? candles.length > 1 : days.length > 0;
    return {
      code: code, name: name, tab: tab, session: session,
      price: price, pct: pct, prevClose: prevClose, change: change,
      days: days, candles: candles, hasData: hasData, at: now()
    };
  }

  async function payload(code, tab) {
    const key = code + '|' + tab;
    const hit = cache[key];
    if (hit && now() - hit.at < ttl[tab]) return hit.data;
    const data = await buildPayload(code, tab);
    cache[key] = { at: now(), data: data };
    return data;
  }

  // 给 focusMeta 查名字用：只读缓存，不触发请求
  function peek(code, tab) {
    const hit = cache[code + '|' + tab];
    return hit ? hit.data : null;
  }

  function clear() {
    Object.keys(cache).forEach(function (key) { delete cache[key]; });
  }

  return { payload, peek, clear };
}

module.exports = {
  createFocusService,
  FOCUS_TABS,
  FOCUS_TTL,
  sessionMinutes,
  parseMinuteLines
};
