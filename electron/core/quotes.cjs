'use strict';

const { num, rangeChange } = require('./utils.cjs');

function closeSeries(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const c = num(rows[i][2]);
    if (isFinite(c)) out.push(c);
  }
  return out;
}

// 月线聚合成年线：每年最后一个月收盘价
function yearlySeries(rows) {
  const order = [];
  const byYear = {};
  for (let i = 0; i < rows.length; i++) {
    const y = String(rows[i][0]).slice(0, 4);
    const c = num(rows[i][2]);
    if (!isFinite(c) || !/^\d{4}$/.test(y)) continue;
    if (!(y in byYear)) order.push(y);
    byYear[y] = c;
  }
  return order.map(function (y) { return byYear[y]; });
}

function buildItem(code, snap, points, options) {
  options = options || {};
  const names = options.names || {};
  const period = options.period || 'minute';

  // 场内 ETF/LOF 价格精度 3-4 位小数，和场外基金一样显示 4 位
  const isEtf = /^sh5\d{5}$/i.test(code) || /^sz1[56]\d{4}$/i.test(code);
  const out = {
    code: code, name: (snap && snap.name) || names[code] || code,
    price: NaN, prevClose: NaN, pct: NaN, change: NaN,
    points: points || [], ok: false, fund: isEtf
  };
  if (snap) {
    out.price = snap.price;
    out.prevClose = snap.prevClose;
    out.pct = snap.pct;
    out.change = snap.change;
  }
  if (!isFinite(out.price) && out.points.length) out.price = out.points[out.points.length - 1];
  if ((!isFinite(out.prevClose) || out.prevClose === 0) && out.points.length > 1) {
    out.prevClose = out.points[out.points.length - 2];
  }
  if (!isFinite(out.pct) && isFinite(out.price) && isFinite(out.prevClose) && out.prevClose) {
    out.pct = ((out.price - out.prevClose) / out.prevClose) * 100;
  }
  if (!isFinite(out.change) && isFinite(out.price) && isFinite(out.prevClose)) {
    out.change = out.price - out.prevClose;
  }
  // 切到日/月/年线时，涨跌幅跟着换成"这条折线覆盖的区间"的涨跌，
  // 否则折线变了、数字还停在今天的涨跌幅，看着就像没跟着周期走。
  if (period !== 'minute') {
    const rc = rangeChange(out.points);
    if (isFinite(rc)) {
      out.pct = rc;
      if (isFinite(out.price) && isFinite(out.points[0])) {
        out.change = out.price - out.points[0];
      }
      out.range = true;
    }
  }
  out.ok = isFinite(out.price);
  return out;
}

// 按涨跌幅排：取数失败 / 没有涨跌幅的永远沉到最后，不跟着升序降序翻转
function sortItems(items, mode) {
  if (mode !== 'pct-asc' && mode !== 'pct-desc') return items;
  const dir = mode === 'pct-asc' ? 1 : -1;
  return items
    .map(function (it, i) {
      return { it: it, i: i, v: (it && isFinite(it.pct)) ? it.pct : null };
    })
    .sort(function (a, b) {
      if (a.v === null && b.v === null) return a.i - b.i;
      if (a.v === null) return 1;
      if (b.v === null) return -1;
      if (a.v === b.v) return a.i - b.i;
      return (a.v - b.v) * dir;
    })
    .map(function (s) { return s.it; });
}

// 日频净值序列 → 目标周期
function fundSeriesForPeriod(rows, period) {
  if (!rows.length) return [];
  if (period === 'day') return rows.slice(-120).map(function (r) { return r[1]; });

  const buckets = new Map();
  for (let i = 0; i < rows.length; i++) {
    const d = new Date(rows[i][0]);
    const key = period === 'month' ? (d.getFullYear() * 100 + (d.getMonth() + 1)) : d.getFullYear();
    buckets.set(key, rows[i][1]);
  }
  const vals = Array.from(buckets.values());
  return period === 'year' ? vals.slice(-25) : vals.slice(-120);
}

function buildFundItem(code, est, nav, options) {
  options = options || {};
  const period = options.period || 'minute';
  const names = options.names || {};
  const out = {
    code: code,
    name: (est && est.name) || (nav && nav.name) || names[code] || code,
    price: NaN, prevClose: NaN, pct: NaN, change: NaN,
    points: [], fund: true, ok: false
  };

  if (est) {
    out.price = est.price;
    out.prevClose = est.prevClose;
    out.pct = est.pct;
    out.estTime = est.time;
  }
  if (period === 'minute') {
    // 分时用本地攒的当日估值曲线（带 x 位置，按时间轴摆），不是日净值
    const s = options.minuteSeries ? options.minuteSeries(code) : { values: [], x: [] };
    out.points = s.values || [];
    out.xIndex = s.x || [];
  } else if (nav) {
    out.points = fundSeriesForPeriod(nav.rows, period);
  }
  if (nav) {
    if (nav.name && !est) out.name = nav.name;
    if (!isFinite(out.prevClose)) out.prevClose = nav.prev;
    if (!isFinite(out.price)) out.price = nav.last;
  }

  if (!isFinite(out.pct) && isFinite(out.price) && isFinite(out.prevClose) && out.prevClose) {
    out.pct = ((out.price - out.prevClose) / out.prevClose) * 100;
  }
  if (isFinite(out.price) && isFinite(out.prevClose)) out.change = out.price - out.prevClose;
  // 和行情类一致：日/月/年线按折线区间算涨跌
  if (nav && period !== 'minute') {
    const rc = rangeChange(out.points);
    if (isFinite(rc)) {
      out.pct = rc;
      if (isFinite(out.price) && isFinite(out.points[0])) {
        out.change = out.price - out.points[0];
      }
      out.range = true;
    }
  }
  out.ok = isFinite(out.price);
  return out;
}

module.exports = {
  closeSeries,
  yearlySeries,
  buildItem,
  sortItems,
  fundSeriesForPeriod,
  buildFundItem
};
