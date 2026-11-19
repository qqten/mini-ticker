'use strict';

// 大盘概览的纯计算层：只负责把东财返回的原始数据整理成「四项指标」，
// 不碰网络、不碰配置，方便单元测试覆盖各种盘中 / 收盘状态。

// 东财 trends2 每个交易日 241 个分钟点（09:30 起、15:00 止，午休不占点）。
const SESSION_POINTS = 241;
// 开盘不足这么多分钟时样本太少，外推出来的全天成交额误差太大，先不显示。
const EARLY_POINTS = 15;
// 开盘前（09:30 之前）一律视为盘前。
const OPEN_HM = '09:30';
const CLOSE_HM = '15:00';

function toNumber(value) {
  const n = Number(value);
  return isFinite(n) ? n : NaN;
}

function toCount(value) {
  const n = toNumber(value);
  return isFinite(n) && n >= 0 ? Math.round(n) : NaN;
}

function dateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!isFinite(d.getTime())) return '';
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function minutesOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!isFinite(d.getTime())) return NaN;
  return d.getHours() * 60 + d.getMinutes();
}

// trends2 的每一行：日期时间,开盘,收盘,最高,最低,成交量,成交额,均价
// 只留「时间 + 成交额」，其它列这里用不到。
function parseTrends(lines) {
  const out = [];
  (Array.isArray(lines) ? lines : []).forEach(function (line) {
    const parts = String(line == null ? '' : line).split(',');
    if (parts.length < 7) return;
    const stamp = String(parts[0] || '');
    const day = stamp.slice(0, 10);
    const hm = stamp.slice(11, 16);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(hm)) return;
    const amount = toNumber(parts[6]);
    if (!isFinite(amount)) return;
    out.push({ day: day, hm: hm, amount: amount });
  });
  return out;
}

// 腾讯 day/query 的日期是 20261119，统一成和东财一致的 2026-11-19
function tencentDateKey(v) {
  const s = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 8);
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '';
}

// 腾讯 5 日分时兜底：`data[code].data = [{date, data:[...]}]`，按「今天 → 前 4 天」倒序。
// 每行 `HHMM 价格 累计量 累计额`，累计额要差分回每分钟，才能和 trends2 的成交额口径对齐。
function parseTencentTrendDays(block) {
  const arr = block && block.data;
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.slice().sort(function (a, b) {
    return String((a && a.date) || '').localeCompare(String((b && b.date) || ''));
  }).forEach(function (d) {
    const day = tencentDateKey(d && d.date);
    if (!day) return;
    let prev = 0;
    (Array.isArray(d && d.data) ? d.data : []).forEach(function (line) {
      const parts = String(line == null ? '' : line).trim().split(/\s+/);
      if (parts.length < 4) return;
      const t = parts[0];
      if (!/^\d{3,4}$/.test(t)) return;
      const hm = t.length === 3 ? '0' + t.charAt(0) + ':' + t.slice(1) : t.slice(0, 2) + ':' + t.slice(2);
      const cum = toNumber(parts[3]);
      if (!isFinite(cum)) return;
      let amount = cum - prev;
      if (!(amount >= 0)) amount = 0;
      prev = cum;
      out.push({ day: day, hm: hm, amount: amount });
    });
  });
  return out;
}

// 沪市 + 深市两条 trends2 按「同一天同一分钟」相加，得到两市合计成交额。
function mergeTrendDays(seriesList) {
  const days = {};
  (Array.isArray(seriesList) ? seriesList : []).forEach(function (points) {
    (Array.isArray(points) ? points : []).forEach(function (p) {
      if (!p || !p.day || !p.hm || !isFinite(p.amount)) return;
      const day = days[p.day] || (days[p.day] = {});
      day[p.hm] = (day[p.hm] || 0) + p.amount;
    });
  });
  return Object.keys(days).sort().map(function (day) {
    const map = days[day];
    const points = Object.keys(map).sort().map(function (hm) {
      return { day: day, hm: hm, amount: map[hm] };
    });
    return { day: day, points: points };
  });
}

function sumAmount(points) {
  let sum = 0;
  (Array.isArray(points) ? points : []).forEach(function (p) {
    if (p && isFinite(p.amount)) sum += p.amount;
  });
  return sum;
}

// 昨日「同一时刻」的累计成交额：只累加时间不晚于当前分钟的点。
function sameTimeAmount(points, hm) {
  let sum = 0;
  (Array.isArray(points) ? points : []).forEach(function (p) {
    if (p && isFinite(p.amount) && p.hm <= hm) sum += p.amount;
  });
  return sum;
}

// 按当前已走完的分钟数线性外推到收盘；分母固定为全天 241 个点。
function projectFullDay(todayAmount, points) {
  if (!isFinite(todayAmount) || !isFinite(points) || points <= 0) return NaN;
  return todayAmount / points * SESSION_POINTS;
}

function percentChange(current, base) {
  if (!isFinite(current) || !isFinite(base) || base <= 0) return NaN;
  return (current - base) / base * 100;
}

function tradeStatus(day, lastHm, pointCount, now) {
  if (!day || !lastHm || !pointCount) return 'pre';
  const today = dateKey(now);
  if (day < today) {
    // 数据还停在上一个交易日：开盘前算盘前，开盘后（周末 / 节假日）算已收盘。
    return minutesOfDay(now) < 9 * 60 + 30 ? 'pre' : 'closed';
  }
  if (day > today) return 'closed';
  if (lastHm >= CLOSE_HM) return 'closed';
  if (lastHm < OPEN_HM) return 'pre';
  if (pointCount < EARLY_POINTS) return 'early';
  return 'open';
}

// 输入：
//   overview: { up, down, flat, amount }  来自东财 ulist.np/get
//   trends:   [parseTrends(...), parseTrends(...)]  沪市 / 深市两条
//   now:      Date（测试可注入）
// 输出直接给渲染层用，缺失值统一为 NaN。
function buildMarketSnapshot(input) {
  const opts = input || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  const overview = opts.overview || {};

  const up = toCount(overview.up);
  const down = toCount(overview.down);
  const flat = toCount(overview.flat);
  const amount = toNumber(overview.amount);

  const days = mergeTrendDays(opts.trends);
  const today = days.length ? days[days.length - 1] : null;
  const prev = days.length > 1 ? days[days.length - 2] : null;

  const lastHm = today && today.points.length
    ? today.points[today.points.length - 1].hm
    : '';
  const status = tradeStatus(today && today.day, lastHm, today ? today.points.length : 0, now);

  const todayAmount = today ? sumAmount(today.points) : NaN;
  const prevFullAmount = prev ? sumAmount(prev.points) : NaN;

  let prevAmount = NaN;
  let projAmount = NaN;

  if (status === 'closed') {
    // 收盘后不再外推，较昨直接对昨日全天。
    prevAmount = prevFullAmount;
  } else if (status === 'open' || status === 'early') {
    prevAmount = prev ? sameTimeAmount(prev.points, lastHm) : NaN;
    if (status === 'open') projAmount = projectFullDay(todayAmount, today.points.length);
  }

  return {
    at: now.getTime(),
    status: status,
    day: today ? today.day : '',
    tradeTime: lastHm,
    up: up,
    down: down,
    flat: flat,
    amount: amount,
    todayAmount: todayAmount,
    prevAmount: prevAmount,
    prevFullAmount: prevFullAmount,
    vsAmount: todayAmount - prevAmount,
    vsPct: percentChange(todayAmount, prevAmount),
    projAmount: projAmount,
    projDelta: projAmount - prevFullAmount,
    projPct: percentChange(projAmount, prevFullAmount)
  };
}

module.exports = {
  SESSION_POINTS,
  EARLY_POINTS,
  parseTrends,
  parseTencentTrendDays,
  mergeTrendDays,
  sumAmount,
  sameTimeAmount,
  projectFullDay,
  percentChange,
  tradeStatus,
  buildMarketSnapshot
};
