'use strict';

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function localYmd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// A 股一天 240 个交易分钟：09:30-11:30 + 13:00-15:00，午休不占宽度。
// 分钟之内再按 15 秒细分，刚启动半分钟内也能看出趋势。
function minuteIndexOf(d) {
  const t = d.getHours() * 60 + d.getMinutes();
  const AM = 9 * 60 + 30;
  const AM_END = 11 * 60 + 30;
  const PM = 13 * 60;
  const PM_END = 15 * 60;
  let idx;
  if (t <= AM) idx = 0;
  else if (t <= AM_END) idx = t - AM;
  else if (t < PM) idx = 120;
  else if (t <= PM_END) idx = 120 + (t - PM);
  else idx = 239;
  const sec = Math.floor(d.getSeconds() / 15) * 15;
  return Math.min(239.9, idx + sec / 60);
}

// 折线所展示这段区间的涨跌幅（首点 → 末点）。
// 分时不用它：分时按昨收算「今日涨跌」才符合习惯。
function rangeChange(points) {
  if (!points || points.length < 2) return NaN;
  const first = points[0];
  const last = points[points.length - 1];
  if (!isFinite(first) || !isFinite(last) || !first) return NaN;
  return ((last - first) / first) * 100;
}

async function runPool(items, limit, fn) {
  let idx = 0;
  const n = Math.min(limit, items.length);
  const workers = [];
  for (let i = 0; i < n; i++) {
    workers.push((async function () {
      while (idx < items.length) {
        const cur = idx++;
        await fn(items[cur], cur);
      }
    })());
  }
  await Promise.all(workers);
}

function clampInt(value, fallback, low, high) {
  const n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  return Math.max(low, Math.min(high, n));
}

module.exports = {
  num,
  pad2,
  sameList,
  localYmd,
  minuteIndexOf,
  rangeChange,
  runPool,
  clampInt
};
