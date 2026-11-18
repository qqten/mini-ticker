'use strict';

const { isHkSymbol } = require('./symbols.cjs');

// 港股 16:00 收盘，比 A 股晚一小时。只要当前分组里还有港股（含港股主题的中证指数），
// 收盘自动退出就不能按 15:05 提前关掉，统一顺延到 16:05。
const HK_CLOSE_EXIT = '16:05';

function hmToMinutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function hasHkSymbols(codes, names) {
  const list = Array.isArray(codes) ? codes : [];
  const map = names || {};
  for (let i = 0; i < list.length; i++) {
    if (isHkSymbol(list[i], map[list[i]])) return true;
  }
  return false;
}

// 返回实际生效的退出时间：用户设置早于港股收盘时顺延到 16:05；设置得更晚则尊重用户。
function autoExitTime(configured, codes, names) {
  const raw = configured || '';
  if (!hasHkSymbols(codes, names)) return raw;
  const at = hmToMinutes(raw);
  const hk = hmToMinutes(HK_CLOSE_EXIT);
  if (at == null || hk == null) return raw;
  return at < hk ? HK_CLOSE_EXIT : raw;
}

module.exports = {
  HK_CLOSE_EXIT,
  hmToMinutes,
  hasHkSymbols,
  autoExitTime
};
