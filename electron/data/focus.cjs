'use strict';

const {
  NAMES, EM_SECID, HF_EM_SECID, INDEX_EM_SECID,
  FOCUS_INTERVALS, FOCUS_INTERVAL_LABEL
} = require('../core/constants.cjs');
const { num } = require('../core/utils.cjs');
const { HEADERS } = require('./market.cjs');

// 聚焦图表的周期：分时 / 5日 / 日K / 周K / 月K，外加可配置的分时级别 K 线。
// 分时级别本身由一个 tab + 一个分钟数决定（config.focusInterval），
// 所以开关键盘的 1234 仍然只切这四个基础周期，分钟级别在设置里配默认值。
const FOCUS_TABS = ['minute', 'five', 'day', 'week', 'month'];
const FOCUS_MIN_TAB = 'min';
const FOCUS_SESSION_A = 242;   // A 股一个交易日：09:30-11:30 + 13:00-15:00，含首尾共 242 个分钟点
const FOCUS_SESSION_HK = 332;  // 港股：09:30-12:00 + 13:00-16:00
const FOCUS_SESSION_US = 392;  // 美股：09:30-16:00（东部时间）
const FOCUS_SESSION_HF = 1440; // 外盘期货/美元指数：近乎 24 小时连续交易（实际约 1380 分钟），留足余量
const FOCUS_TTL = { minute: 15000, five: 60000, day: 60000, week: 60000, month: 60000, min: 30000 };

// 日K 往后翻要靠历史：腾讯 fqkline 实测最多给到 1200 根（约 5 年，最早 2021-11），
// 再多就返回空。月K 120 根已经是 10 年，够看长期趋势了。周K 520 根正好 10 年。
const DAY_BARS = 1200;
const WEEK_BARS = 520;
const MONTH_BARS = 120;
// 分钟 K 默认拉 320 根：5 分钟级别约 6 个交易日，60 分钟级别约 3 个月，
// 再往上拉腾讯会限流、图表也画不下。
const MIN_BARS = 320;

function clampInterval(v) {
  const n = Number(v);
  return FOCUS_INTERVALS.indexOf(n) >= 0 ? n : 1;
}

// 分钟级别 tab 在取数时归一成一个 K 线周期名：m5 / m15 / m30 / m60
function minIntervalOf(minutes) {
  return 'm' + clampInterval(minutes);
}

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

// 东方财富 trends2 的最后一列：个股是均价，指数是不加权的领先指数（黄线）。
// 同时放一份带日期的 key 和一份 HHMM key：单日分时用 HHMM，5 日分时用完整日期，
// 避免多天里同一个 09:30 互相覆盖。
function parseLeadTrends(trends) {
  const map = new Map();
  (trends || []).forEach(function (row) {
    const f = String(row).split(',');
    const m = String(f[0] || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):?(\d{2})/);
    const v = num(f[7]);
    if (!m || !isFinite(v)) return;
    const hm = m[4] + m[5];
    map.set(m[1] + m[2] + m[3] + hm, v);
    map.set(hm, v);
  });
  return map;
}

// 把领先指数填进分时点。13:00 这种接口缺一行的时间点沿用上一分钟，
// 否则黄线会在午休处断开。返回是否真的填进过数据。
function applyLeadValues(days, leadMap, multiDay) {
  let applied = false;
  (days || []).forEach(function (day) {
    const dayKey = String(day.date || '').replace(/\D/g, '').slice(0, 8);
    let last = NaN;
    (day.points || []).forEach(function (pt) {
      const m = String(pt.t || '').match(/^(\d{1,2}):?(\d{2})$/);
      if (!m) return;
      const hm = (m[1].length === 1 ? '0' : '') + m[1] + m[2];
      const hit = leadMap.get((multiDay ? dayKey : '') + hm);
      if (isFinite(hit)) {
        last = hit;
        applied = true;
      }
      if (isFinite(last)) pt.avg = last;
    });
  });
  return applied;
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

  // 上证指数分时：白线用腾讯的加权指数，黄线用东财 trends2 第 8 列的领先指数。
  // 只取指数，个股的 avg 仍然是成交量加权均价，不受影响。
  async function fetchLeadMap(code, ndays) {
    const secid = INDEX_EM_SECID[code];
    if (!secid) return null;
    const url = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
      '&iscr=0&ndays=' + ndays;
    try {
      const j = await http.fetchJson(url, {
        headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-lead'
      });
      return parseLeadTrends((j && j.data && j.data.trends) || []);
    } catch (e) {
      return null;
    }
  }

  async function buildPayload(code, tab, interval) {
    const snapP = market.fetchSnapshots([code]).catch(function () { return {}; });
    // 黄线单独拉，和腾讯的白线并行，失败也不影响主图
    const leadP = code === 'sh000001' && (tab === 'minute' || tab === 'five')
      ? fetchLeadMap(code, tab === 'five' ? 5 : 1)
      : Promise.resolve(null);
    let name = NAMES[code] || code;
    let price = NaN, pct = NaN, prevClose = NaN, change = NaN;
    let days = [];
    let candles = [];
    let session = sessionMinutes(code);
    let fiveForeign = false;
    let tabMin = 0;

    if (tab === FOCUS_MIN_TAB) {
      // 分时级别 K 线：tab 固定为 min，真正的粒度在 interval（1/5/15/30/60 分钟）
      tabMin = clampInterval(interval);
      const rows = await market.fetchKlineRaw(code, minIntervalOf(tabMin), MIN_BARS);
      candles = rows.map(function (r) {
        return { d: String(r[0]), o: num(r[1]), c: num(r[2]), h: num(r[3]), l: num(r[4]), v: num(r[5]) };
      }).filter(function (x) { return isFinite(x.c) && isFinite(x.o) && isFinite(x.h) && isFinite(x.l); });
      if (candles.length) {
        const last = candles[candles.length - 1];
        price = last.c;
        // 涨跌幅按上一根分钟 K 收盘算，没有就走快照的昨收
        if (candles.length > 1) prevClose = candles[candles.length - 2].c;
        if (!isFinite(prevClose) || prevClose === 0) prevClose = last.o;
        pct = ((price - prevClose) / prevClose) * 100;
        change = price - prevClose;
      }
    } else if (tab === 'day' || tab === 'week' || tab === 'month') {
      // 日K 拉满 1200 根让用户能往回翻到 5 年前；周K 520 根约 10 年；月K 120 根就是 10 年
      const bars = tab === 'day' ? DAY_BARS : tab === 'week' ? WEEK_BARS : MONTH_BARS;
      const rows = await market.fetchKlineRaw(code, tab, bars);
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
      // 外盘期货 / 美元指数：腾讯没有 5 日分时，用东财 5 分钟 K 线拼最近 5 个交易日
      const emSecid = EM_SECID[code] || HF_EM_SECID[code];
      if (emSecid && typeof market.fetchFiveDay === 'function') {
        days = await market.fetchFiveDay(code);
        fiveForeign = true;
        if (days.length) {
          // 5 分钟粒度每天点数比 A 股少，横轴按实际最大点数排，避免每天只占一小截
          let maxPts = 0;
          for (let i = 0; i < days.length; i++) {
            if (days[i].points.length > maxPts) maxPts = days[i].points.length;
          }
          session = maxPts || session;
          const lastPts = days[days.length - 1].points;
          price = lastPts[lastPts.length - 1].price;
          // 昨收和涨跌幅以快照（昨结）为准，后面统一补，和列表保持一致
        }
      } else {
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
      }
    } else {
      // 外盘期货 / 美元指数：腾讯没有分时，走东财 trends2（与主浮窗一致）
      const emSecid = EM_SECID[code] || HF_EM_SECID[code];
      if (emSecid) {
        const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + emSecid +
          '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1';
        const j = await http.fetchJson(url, {
          headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute'
        });
        const trends = (j && j.data && j.data.trends) || [];
        // trends 行：时间,开,收,高,低,成交量,成交额,均价；价格取分钟收盘，量直接取成交量。
        // 伦敦金 / 美元指数本身没有成交量，接口整列为 0，交给图表隐藏成交量栏。
        const pts = [];
        for (const t of trends) {
          const f = String(t).split(',');
          const p = num(f[2]);
          if (!isFinite(p)) continue;
          const v = num(f[5]);
          pts.push({ t: f[0], price: p, vol: isFinite(v) ? v : 0 });
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

    let leadApplied = false;
    if (days.length) {
      const leadMap = await leadP;
      if (leadMap) leadApplied = applyLeadValues(days, leadMap, tab === 'five');
    }

    const snap = await snapP;
    if (snap && snap[code]) {
      if (snap[code].name) name = snap[code].name;
      if (!isFinite(price) && isFinite(snap[code].price)) price = snap[code].price;
      if (!isFinite(prevClose) && isFinite(snap[code].prevClose)) prevClose = snap[code].prevClose;
      if (!isFinite(pct) && isFinite(snap[code].pct)) pct = snap[code].pct;
    }
    // 外盘 5 日：快照没有昨收时退回前一交易日收盘；图表最后一天的虚线也跟着对齐
    if (fiveForeign && days.length) {
      if (!isFinite(prevClose) && isFinite(days[days.length - 1].prec)) {
        prevClose = days[days.length - 1].prec;
        if (isFinite(price) && prevClose) {
          pct = ((price - prevClose) / prevClose) * 100;
          change = price - prevClose;
        }
      }
      if (isFinite(prevClose)) days[days.length - 1].prec = prevClose;
    }
    if (!isFinite(change) && isFinite(price) && isFinite(prevClose)) change = price - prevClose;

    const isCandleTab = tab === 'day' || tab === 'week' || tab === 'month' || tab === FOCUS_MIN_TAB;
    const hasData = isCandleTab ? candles.length > 1 : days.length > 0;
    return {
      code: code, name: name, tab: tab, session: session,
      // 分钟级别 tab 把实际粒度一起带出去，渲染层据此画横轴和标题
      min: tabMin,
      price: price, pct: pct, prevClose: prevClose, change: change,
      // 上证指数分时是否成功叠加了领先指数（黄线）；失败时渲染层退回原来的均价线
      lead: leadApplied,
      days: days, candles: candles, hasData: hasData, at: now()
    };
  }

  async function payload(code, tab, interval) {
    // 分钟级别 tab 的缓存键要带上粒度，否则切 5 分钟 / 15 分钟会拿到上一档的数据
    const key = tab === FOCUS_MIN_TAB
      ? code + '|' + tab + '|' + clampInterval(interval)
      : code + '|' + tab;
    const hit = cache[key];
    if (hit && now() - hit.at < ttl[tab]) return hit.data;
    const data = await buildPayload(code, tab, interval);
    cache[key] = { at: now(), data: data };
    return data;
  }

  // 给 focusMeta 查名字用：只读缓存，不触发请求
  function peek(code, tab, interval) {
    const key = tab === FOCUS_MIN_TAB
      ? code + '|' + tab + '|' + clampInterval(interval)
      : code + '|' + tab;
    const hit = cache[key];
    return hit ? hit.data : null;
  }

  function clear() {
    Object.keys(cache).forEach(function (key) { delete cache[key]; });
  }

  return { payload, peek, clear, buildPayload };
}

module.exports = {
  createFocusService,
  FOCUS_TABS,
  FOCUS_TTL,
  FOCUS_MIN_TAB,
  FOCUS_INTERVALS,
  FOCUS_INTERVAL_LABEL,
  clampInterval,
  minIntervalOf,
  sessionMinutes,
  parseMinuteLines,
  parseLeadTrends,
  applyLeadValues
};
