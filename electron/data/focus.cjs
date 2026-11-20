'use strict';

const {
  NAMES, EM_SECID, HF_EM_SECID, INDEX_EM_SECID,
  FOCUS_INTERVALS, FOCUS_INTERVAL_LABEL
} = require('../core/constants.cjs');
const { num } = require('../core/utils.cjs');
const { emIndexSecid, isEmIndexCode, isHkSymbol } = require('../core/symbols.cjs');
const { HEADERS, SINA_HEADERS } = require('./market.cjs');

// 聚焦图表的周期：分时 / 5日 / 日K / 周K / 月K，外加可配置的分时级别 K 线。
// 分时级别本身由一个 tab + 一个分钟数决定（config.focusInterval），
// 所以开关键盘的 1234 仍然只切这四个基础周期，分钟级别在设置里配默认值。
const FOCUS_TABS = ['minute', 'five', 'day', 'week', 'month'];
const FOCUS_MIN_TAB = 'min';
const FOCUS_SESSION_A = 242;   // A 股一个交易日：09:30-11:30 + 13:00-15:00，含首尾共 242 个分钟点
const FOCUS_SESSION_HK = 332;  // 港股：09:30-12:00 + 13:00-16:00
// 中证官网口径的港股主题指数：09:30-11:30 + 13:00-16:00（午休压缩），共 302 个分钟槽位
const FOCUS_SESSION_HK_INDEX = 302;
const FOCUS_SESSION_US = 392;  // 美股：09:30-16:00（东部时间）
const FOCUS_SESSION_HF = 1440; // 外盘期货/美元指数：近乎 24 小时连续交易（实际约 1380 分钟），留足余量
// 上金所 T+D / 现货：20:00-02:30 + 09:00-11:30 + 13:30-15:30，共 660 个分钟槽位
const FOCUS_SESSION_SGE = 660;
// 中金所国债期货：09:30-11:30 + 13:00-15:15，比 A 股多到最后 15:15，共 257 个槽位
const FOCUS_SESSION_CF = 257;
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

function sessionMinutes(code, name) {
  // 外盘期货 / 美元指数：近乎 24 小时连续交易，按 1440 个分钟槽位画
  if (/^hf_/i.test(code) || /^usDXY$/i.test(code)) return FOCUS_SESSION_HF;
  if (/^sge_/i.test(code)) return FOCUS_SESSION_SGE;
  if (/^cf_/i.test(code)) return FOCUS_SESSION_CF;
  if (isHkSymbol(code, name)) return FOCUS_SESSION_HK;
  if (/^us/i.test(code)) return FOCUS_SESSION_US;
  return FOCUS_SESSION_A;
}

// 中证官网的港股主题指数分时：09:30-11:30 + 13:00-16:00。
// 中证接口在 11:30-13:00 完全没有点，A 股分时也是同样口径，所以午休直接压缩掉：
// 13:00 排在 11:30 的下一格，折线在午休处连续，不会留出一条空白。
// 09:30 占 0、11:30 占 120、13:00 占 121、15:00 占 241、16:00 占 301。
function hkIndexSlotOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return -1;
  const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const open = 9 * 60 + 30;
  if (mins >= open && mins <= 11 * 60 + 30) return mins - open;
  if (mins >= 13 * 60 && mins <= 16 * 60) return 121 + mins - 13 * 60;
  return -1;
}

// 中证官网分时：15 秒一个点，港股主题指数会一直更新到 16:00。
// 东财 trends2 对 931787 只到 15:00，所以这类指数改用中证接口画分时。
// 每分钟只留最后一个点（和 A 股分时的分钟收盘口径一致）。
function parseCsindexIntraday(j) {
  const d = j && j.data;
  const list = (d && d.intraDayPerfList) || [];
  if (!Array.isArray(list) || list.length < 2) return null;
  const header = d.intraDayHeader || {};
  const bySlot = new Map();
  list.forEach(function (row) {
    const hm = String((row && row.tradeTime) || '').slice(0, 5);
    const slot = hkIndexSlotOf(hm);
    const price = num(row && row.current);
    if (slot < 0 || !isFinite(price)) return;
    bySlot.set(slot, { t: hm, price: price, vol: 0 });
  });
  if (bySlot.size < 2) return null;
  // 中证 15 秒数据的第一个点已经是 09:30:09 之后了，直接取会把开盘价丢掉；
  // 用 header 的今开补 09:30，后面的分钟仍然取该分钟最后一个点。
  const open = num(header.openToday);
  if (isFinite(open) && open > 0) bySlot.set(0, { t: '09:30', price: open, vol: 0 });
  const points = Array.from(bySlot.keys()).sort(function (a, b) { return a - b; })
    .map(function (slot) {
      const pt = bySlot.get(slot);
      pt.slot = slot;
      return pt;
    });
  // 收盘后中证会把最终收盘价回填到 header.current，16:00 那个 15 秒点可能还是暂定值。
  // 最后一格正好是 16:00 时以 header.current 为准，保证图表终点和列表 / 标题一致。
  const last = points[points.length - 1];
  const close = num(header.current);
  if (last && last.slot === FOCUS_SESSION_HK_INDEX - 1 && isFinite(close) && close > 0) {
    last.price = close;
  }
  return {
    date: String(header.tradeDate || '').slice(0, 10),
    prevClose: num(header.closePre),
    price: close,
    session: FOCUS_SESSION_HK_INDEX,
    points: points
  };
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

// 腾讯分时 / 5 日分时只覆盖 A 股（sh / sz / bj），外盘、美元指数、上金所不能走这条路
function isTencentMinuteCode(code) {
  return /^(sh|sz|bj)\d{6}$/i.test(String(code || ''));
}

// 腾讯 day/query：`data[code].data = [{date, data:[行...]}]`，按「今天 → 前 4 天」倒序给。
// 行格式和 minute/query 一样（时间 价格 累计量 累计额），解析后转成正序。
function parseTencentFiveDays(block) {
  const arr = block && block.data;
  if (!Array.isArray(arr)) return [];
  return arr.slice().sort(function (a, b) {
    return String((a && a.date) || '').localeCompare(String((b && b.date) || ''));
  }).map(function (d) {
    const pts = parseMinuteLines((d && d.data) || []);
    return { date: String((d && d.date) || ''), prec: num(d && d.prec), points: pts };
  }).filter(function (d) { return d.points.length > 1; });
}

// 新浪指数分时：p=加权指数（白线），avg_p=均价，lx=领先指数（上证黄线），v=每分钟成交量。
// 东财 trends2 连不上时用它兜底，单日能同时补回白线和黄线。
// 09:25 集合竞价不占分时槽位，先丢掉，保证第 0 个点仍是 09:30。
function parseSinaIndexMinute(rows, lead) {
  const pts = [];
  let lastAvg = NaN;
  (rows || []).forEach(function (row) {
    const m = String((row && row.m) || '').match(/^(\d{1,2}):(\d{2})/);
    const p = num(row && row.p);
    if (!m || !isFinite(p)) return;
    const t = (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2];
    if (t < '09:30') return;
    const v = num(row.v);
    const lx = num(row.lx);
    const ap = num(row.avg_p);
    // 新浪偶尔把还没算出来的领先指数 / 均价给成 0，不能当成真实点位，
    // 否则纵轴会被 0 拉到底，白线和黄线都挤成一条贴顶的直线。
    const raw = lead
      ? (isFinite(lx) && lx > 0 ? lx : NaN)
      : (isFinite(ap) && ap > 0 ? ap : NaN);
    if (isFinite(raw)) lastAvg = raw;
    const avg = isFinite(raw) ? raw : (isFinite(lastAvg) ? lastAvg : p);
    pts.push({ t: t, price: p, vol: isFinite(v) ? v : 0, avg: avg });
  });
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

  // 港股主题的 em 指数分时。中证官网能给到 16:00，东财 trends2 只到 15:00；
  // 成交量仍从东财分钟线按分钟补（中证分时接口不带量）。
  async function fetchHkIndexMinute(code, emSecid) {
    const id = String(code).replace(/^em/i, '');
    const csiUrl = 'https://www.csindex.com.cn/csindex-home/perf/index-perf-oneday?indexCode=' +
      encodeURIComponent(id);
    const emUrl = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + emSecid +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&iscr=0&ndays=1';
    const both = await Promise.all([
      http.fetchJson(csiUrl, {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': 'https://www.csindex.com.cn/'
        },
        timeout: 5000, retries: 1, tag: 'csi-minute'
      }),
      http.fetchJson(emUrl, {
        headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute'
      }).catch(function () { return null; })
    ]);
    const parsed = parseCsindexIntraday(both[0]);
    if (!parsed) return null;
    const volMap = new Map();
    const rows = (both[1] && both[1].data && both[1].data.trends) || [];
    rows.forEach(function (line) {
      const f = String(line).split(',');
      const hm = String(f[0] || '').slice(11, 16);
      const v = num(f[5]);
      if (/^\d{2}:\d{2}$/.test(hm) && isFinite(v)) volMap.set(hm, v);
    });
    parsed.points.forEach(function (pt) { pt.vol = volMap.get(pt.t) || 0; });
    return parsed;
  }

  // 新浪分时兜底：指数能拿到领先指数（黄线），个股只有均价。
  // 东财 / 腾讯分时都不通时用它，避免整张分时空图。
  async function fetchSinaMinute(code) {
    const url = 'https://quotes.sina.cn/cn/api/openapi.php/CN_MinlineService.getMinlineData?symbol=' +
      encodeURIComponent(code);
    const text = await http.fetchText(url, {
      headers: SINA_HEADERS, timeout: 4000, retries: 1, tag: 'sina-index-minute'
    });
    const j = JSON.parse(text);
    const rows = (j && j.result && j.result.data) || [];
    let lead = false;
    if (code === 'sh000001') {
      rows.forEach(function (r) {
        const lx = num(r && r.lx);
        if (isFinite(lx) && lx > 0) lead = true;
      });
    }
    const pts = parseSinaIndexMinute(rows, lead);
    return pts.length > 1 ? { pts: pts, lead: lead } : null;
  }

  async function buildPayload(code, tab, interval) {
    const snapP = market.fetchSnapshots([code]).catch(function () { return {}; });
    // em 指数要先看名称 / 币种：东财 secid 不区分港股主题和内地中证指数，
    // 港股主题要走中证官网分时，才能一直画到 16:00。基本信息按代码缓存，不会每轮都拉。
    const emCode = isEmIndexCode(code);
    const csiInfoP = emCode && typeof market.fetchCsindexInfo === 'function'
      ? market.fetchCsindexInfo(code).catch(function () { return null; })
      : Promise.resolve(null);
    const preSnap = emCode ? await snapP : null;
    const csiInfo = emCode ? await csiInfoP : null;
    const snapName = preSnap && preSnap[code] && preSnap[code].name;
    let name = (snapName && snapName !== code ? snapName : '') ||
      (csiInfo && csiInfo.name) || NAMES[code] || code;
    const hk = !!(csiInfo && csiInfo.hk) || isHkSymbol(code, name);
    // 中证口径的港股主题指数：09:30-11:30 / 13:00-16:00，午休压缩（302 槽位）。
    // 和腾讯港股（09:30-12:00，332 槽位）区分开，免得 11:30-13:00 留出一大段空白。
    const hkIndex = hk && emCode;
    // 黄线单独拉，和腾讯的白线并行，失败也不影响主图
    const leadP = code === 'sh000001' && (tab === 'minute' || tab === 'five')
      ? fetchLeadMap(code, tab === 'five' ? 5 : 1)
      : Promise.resolve(null);
    let price = NaN, pct = NaN, prevClose = NaN, change = NaN;
    let days = [];
    let candles = [];
    let session = sessionMinutes(code, name);
    // 市场只用来选分时横轴口径：美元指数不是美股，和 hf_ / 上金所一样按真实时钟标刻度
    let marketTag = hk ? 'hk' : (/^sge_/i.test(code) ? 'sge'
      : (/^cf_/i.test(code) ? 'cf'
        : (/^hf_/i.test(code) || /^usDXY$/i.test(code) ? 'hf'
          : (/^us/i.test(code) ? 'us' : 'a'))));
    if (hkIndex) {
      session = FOCUS_SESSION_HK_INDEX;
      marketTag = 'hk-index';
    }
    let fiveForeign = false;
    let tabMin = 0;
    // 东财分时不可用、靠新浪 / 腾讯兜底时，黄线是否已经由新浪的领先指数补上
    let minuteLead = false;
    // 新浪分时一次取数多处复用（白线兜底 / 黄线兜底 / 五日兜底），同一次构建只打一次接口
    let sinaMinutePromise = null;
    function sinaMinuteOnce() {
      if (!sinaMinutePromise) {
        sinaMinutePromise = fetchSinaMinute(code).catch(function () { return null; });
      }
      return sinaMinutePromise;
    }

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
      const emSecid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
      if (emSecid && typeof market.fetchFiveDay === 'function') {
        days = await market.fetchFiveDay(code);
        fiveForeign = true;
        if (days.length) {
          if (hkIndex) {
            // 今天这段换成中证分时（1 分钟粒度，能到 16:00），并且带上 09:30 开盘。
            // 前 4 天用东财 5 分钟 K，它把 15:00-16:00 压缩进最后一根，映射时摆到 16:00。
            // 所有点按真实时钟摆进 302 槽位，和分时 tab 的口径一致。
            let csi = null;
            try { csi = await fetchHkIndexMinute(code, emSecid); } catch (error) { csi = null; }
            if (csi && csi.points.length) {
              const tail = days[days.length - 1];
              if (tail.date === csi.date) {
                tail.points = csi.points;
              } else if (csi.date > tail.date) {
                days.push({
                  date: csi.date,
                  prec: tail.points.length ? tail.points[tail.points.length - 1].price : csi.prevClose,
                  points: csi.points
                });
              }
            }
            days.forEach(function (d) {
              const lastIdx = d.points.length - 1;
              d.points = d.points.filter(function (pt, idx) {
                if (!isFinite(pt.slot)) {
                  // 东财 5 分钟 K 把港股 15:00-16:00 这一小时压缩进最后一根 15:00 K：
                  // 成交量是普通 5 分钟 K 的 20 多倍，收盘价就是当天收盘价。
                  // 所以最后一根要摆到 16:00，前 4 天才能画到收盘，而不是停在 15:00。
                  if (idx === lastIdx && pt.t === '15:00') {
                    pt.slot = FOCUS_SESSION_HK_INDEX - 1;
                    pt.t = '16:00';
                  } else {
                    pt.slot = hkIndexSlotOf(pt.t);
                  }
                }
                return pt.slot >= 0 && isFinite(pt.price);
              });
            });
            days = days.filter(function (d) { return d.points.length > 1; });
            session = FOCUS_SESSION_HK_INDEX;
            marketTag = 'hk-index';
          } else {
            // 5 分钟粒度每天点数比 A 股少，横轴按实际最大点数排，避免每天只占一小截
            let maxPts = 0;
            for (let i = 0; i < days.length; i++) {
              if (days[i].points.length > maxPts) maxPts = days[i].points.length;
            }
            session = maxPts || session;
          }
          if (days.length) {
            const lastPts = days[days.length - 1].points;
            price = lastPts[lastPts.length - 1].price;
          }
          // 昨收和涨跌幅以快照（昨结）为准，后面统一补，和列表保持一致
        }
      } else {
        let singleFallback = false;
        try {
          const j = await market.fetchTencentJson('/appstock/app/day/query?code=' + encodeURIComponent(code));
          days = parseTencentFiveDays(j && j.data && j.data[code]);
        } catch (error) {
          days = [];
        }
        // 腾讯 5 日分时也不可用：用新浪当天分时兜底，只画今天，别整张空图
        if (!days.length && isTencentMinuteCode(code)) {
          const alt = await sinaMinuteOnce();
          if (alt) {
            days = [{ date: '', prec: NaN, points: alt.pts }];
            minuteLead = minuteLead || !!alt.lead;
            singleFallback = true;
          }
        }
        if (days.length) {
          const lastDay = days[days.length - 1];
          const lastPt = lastDay.points[lastDay.points.length - 1];
          price = lastPt.price;
          if (!singleFallback) {
            prevClose = lastDay.prec;
            if (!isFinite(prevClose) || !prevClose) prevClose = days[0].points[0].price;
            pct = ((price - prevClose) / prevClose) * 100;
            change = price - prevClose;
          }
        }
      }
    } else {
      // 外盘期货 / 美元指数：腾讯没有分时，走东财 trends2（与主浮窗一致）
      const emSecid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
      let usedCsi = false;
      // 港股主题的中证指数：东财只到 15:00，改用中证官网分时画到 16:00
      if (emSecid && hk && isEmIndexCode(code)) {
        try {
          const csi = await fetchHkIndexMinute(code, emSecid);
          if (csi) {
            days = [{ date: csi.date, prec: csi.prevClose, points: csi.points }];
            price = csi.price;
            prevClose = csi.prevClose;
            if (isFinite(price) && isFinite(prevClose) && prevClose) {
              pct = ((price - prevClose) / prevClose) * 100;
              change = price - prevClose;
            }
            usedCsi = true;
          }
        } catch (error) {
          // 中证接口不可用：落回东财分时（画到 15:00）
        }
      }
      if (emSecid && !usedCsi) {
        let pts = [];
        let date = '';
        try {
          const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + emSecid +
            '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1';
          const j = await http.fetchJson(url, {
            headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute'
          });
          const trends = (j && j.data && j.data.trends) || [];
          date = String((j && j.data && j.data.date) || '');
          // trends 行：时间,开,收,高,低,成交量,成交额,均价；价格取分钟收盘，量直接取成交量。
          // 伦敦金 / 美元指数本身没有成交量，接口整列为 0，交给图表隐藏成交量栏。
          for (const t of trends) {
            const f = String(t).split(',');
            const p = num(f[2]);
            if (!isFinite(p)) continue;
            const v = num(f[5]);
            pts.push({ t: f[0], price: p, vol: isFinite(v) ? v : 0 });
          }
        } catch (error) {
          // 东财 trends2 不可用：美元指数 / 外盘 / 上金所下面走各自的新浪兜底。
        }
        if (pts.length <= 1 && typeof market.fetchForeignMinute === 'function') {
          try {
            const alt = await market.fetchForeignMinute(code);
            if (alt && alt.points && alt.points.length > 1) {
              pts = alt.points;
              date = alt.date || date;
            }
          } catch (error) {
            // 两个源都失败：保持空图，不拿日 K 冒充分时。
          }
        }
        if (pts.length > 1) {
          days = [{ date: date, prec: NaN, points: pts }];
          const lastPt = pts[pts.length - 1];
          price = lastPt.price;
          // trends2 里没有昨收列，prevClose/pct/change 交给下方 snap 快照填充
        }
      } else if (!emSecid) {
        let pts = [];
        let qqDate = '';
        let qqPrec = NaN;
        let qqPct = NaN;
        let qqChange = NaN;
        let qqName = '';
        try {
          const j = await market.fetchTencentJson('/appstock/app/minute/query?code=' + encodeURIComponent(code));
          const block = j && j.data && j.data[code];
          const lines = (block && block.data && block.data.data) || [];
          const qt = (block && block.qt && block.qt[code]) || [];
          pts = parseMinuteLines(lines);
          qqDate = String((block && block.data && block.data.date) || '');
          qqPrec = num(qt[4]);
          qqPct = num(qt[32]);
          qqChange = num(qt[31]);
          qqName = String(qt[1] || '');
        } catch (error) {
          // 腾讯分时不可用：下面用新浪兜底
        }
        if (pts.length <= 1 && isTencentMinuteCode(code)) {
          const alt = await sinaMinuteOnce();
          if (alt) {
            pts = alt.pts;
            minuteLead = !!alt.lead;
          }
        }
        if (pts.length > 1) {
          days = [{ date: qqDate, prec: isFinite(qqPrec) ? qqPrec : NaN, points: pts }];
          price = pts[pts.length - 1].price;
          if (isFinite(qqPrec) && qqPrec > 0) prevClose = qqPrec;
          if (isFinite(qqPct)) pct = qqPct;
          if (isFinite(qqChange)) change = qqChange;
          if (qqName) name = qqName;
        }
      }
    }

    let leadApplied = false;
    if (days.length) {
      const leadMap = await leadP;
      if (leadMap) leadApplied = applyLeadValues(days, leadMap, tab === 'five');
    }
    // 东财领先指数接口也不通时，上证分时的黄线用新浪 lx 兜底
    if (!leadApplied && code === 'sh000001' && tab === 'minute' && days.length) {
      const alt = await sinaMinuteOnce();
      if (alt && alt.lead && alt.pts.length) {
        const leadMap = new Map();
        alt.pts.forEach(function (p) { leadMap.set(p.t.replace(':', ''), p.avg); });
        if (applyLeadValues(days, leadMap, false)) leadApplied = true;
      }
    }
    // 东财趋势线不可用时，新浪兜底已经带了领先指数，黄线照样画
    if (!leadApplied && minuteLead) leadApplied = true;

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
    // 单日分时：东财 trends2 没有昨收列，用快照昨收补上，图表才画得出昨收虚线
    if (days.length === 1 && !isFinite(days[0].prec) && isFinite(prevClose) && prevClose > 0) {
      days[0].prec = prevClose;
    }
    // 腾讯 qt 和快照都没给昨收时退回开盘价，分时至少还有一条参考虚线
    if (!isFinite(prevClose) && tab === 'minute' && days.length && days[0].points.length) {
      prevClose = days[0].points[0].price;
    }
    if (!isFinite(change) && isFinite(price) && isFinite(prevClose)) change = price - prevClose;

    const isCandleTab = tab === 'day' || tab === 'week' || tab === 'month' || tab === FOCUS_MIN_TAB;
    const hasData = isCandleTab ? candles.length > 1 : days.length > 0;
    return {
      code: code, name: name, tab: tab, session: session,
      // 市场：分时横轴按港股 / 美股 / A 股的交易时段画刻度（em 港股指数也能认出来）
      market: marketTag,
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
  hkIndexSlotOf,
  parseCsindexIntraday,
  parseMinuteLines,
  parseTencentFiveDays,
  parseSinaIndexMinute,
  parseLeadTrends,
  applyLeadValues
};
