'use strict';

const { localYmd, minuteIndexOf } = require('../core/utils.cjs');
const { readJson, writeJsonAtomic } = require('../core/atomic-json.cjs');

/* 场外基金没有分钟行情：把每轮拿到的盘中估值按交易时间攒成当日分时。
   净值序列是日频的（一天一个点），套到 240 分钟轴上只会画出左边一小段就停住，
   所以分时改成自己攒：15 秒一个点，落盘到 cache/fund-minute.json，重启能接着画。 */
function createFundMinuteStore(options) {
  options = options || {};
  const file = options.file;
  const log = typeof options.log === 'function' ? options.log : function () {};
  const now = typeof options.now === 'function' ? options.now : function () { return new Date(); };
  const flushDelay = options.flushDelay != null ? options.flushDelay : 4000;

  const points = {};               // code -> { date:'2026-10-23', pts:{ '分钟': 价格 } }
  let ready = false;
  let dirty = false;
  let timer = null;
  let failureLogged = false;

  function load() {
    if (ready) return;
    ready = true;
    try {
      const raw = readJson(file);
      const today = localYmd(now());
      Object.keys(raw).forEach(function (code) {
        const it = raw[code];
        // 只认当天的，昨天攒的留着也没用
        if (it && it.date === today && it.pts) points[code] = it;
      });
    } catch (error) {
      // 缓存文件不存在或损坏都从空开始，不影响行情。
    }
  }

  function flush() {
    if (!dirty) return false;
    try {
      writeJsonAtomic(file, points, { pretty: false });
      dirty = false;
      failureLogged = false;
      return true;
    } catch (error) {
      // 写盘失败时保留 dirty，下次还会再试，不能把内存里攒的点丢掉。
      if (!failureLogged) {
        failureLogged = true;
        log('[fund]', '缓存保存失败：' + error.message);
      }
      return false;
    }
  }

  // 一轮轮询可能连着改好几支基金，合并成一次写盘；退出前由 before-quit 强制 flush
  function save(force) {
    dirty = true;
    if (force) { flush(); return; }
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      flush();
    }, flushDelay);
    // 后台定时器不该拖住进程退出
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function record(code, est) {
    if (!est || !(est.price > 0)) return;
    load();
    const at = now();
    const date = est.date || localYmd(at);
    const key = minuteIndexOf(at).toFixed(2);
    let slot = points[code];
    if (!slot || slot.date !== date) {
      slot = { date: date, pts: {} };
      points[code] = slot;
      save(true);   // 换天先落一次，别把新数据留在内存里
    }
    if (slot.pts[key] === est.price) return;
    slot.pts[key] = est.price;
    save();
  }

  // 当日累积 → { values:[价格], x:[分钟位置] }
  function series(code) {
    load();
    const slot = points[code];
    if (!slot) return { values: [], x: [] };
    // 键是 '118.25' 这种定位字符串，排序要按数值、取值必须用原字符串键
    const keys = Object.keys(slot.pts).sort(function (a, b) { return Number(a) - Number(b); });
    return { values: keys.map(function (k) { return slot.pts[k]; }), x: keys.map(Number) };
  }

  // 退出前调用：清掉待触发的定时器并强制落盘
  function dispose() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return flush();
  }

  return { load, flush, save, record, series, dispose };
}

module.exports = { createFundMinuteStore };
