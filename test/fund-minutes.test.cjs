'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFundMinuteStore } = require('../electron/data/fund-minutes.cjs');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ticker-fund-'));
  return { dir: dir, file: path.join(dir, 'cache', 'fund-minute.json') };
}

test('record / series 按交易时间排序，并过滤非当日数据', function () {
  const tmp = tempFile();
  let clock = new Date(2026, 9, 28, 10, 0, 30);
  const store = createFundMinuteStore({
    file: tmp.file,
    now: function () { return clock; },
    flushDelay: 60000
  });

  try {
    store.record('001186', { price: 1.5, date: '2026-10-28' });
    // 同一个 15 秒槽位 + 同一个价格：不重复记
    store.record('001186', { price: 1.5, date: '2026-10-28' });
    clock = new Date(2026, 9, 28, 10, 0, 45);
    store.record('001186', { price: 1.52, date: '2026-10-28' });
    clock = new Date(2026, 9, 28, 9, 30, 5);
    store.record('001186', { price: 1.48, date: '2026-10-28' });
    // 无效估值直接忽略
    store.record('001186', { price: 0 });
    store.record('001186', null);

    const series = store.series('001186');
    assert.deepEqual(series.values, [1.48, 1.5, 1.52]);
    assert.deepEqual(series.x, [0, 30.5, 30.75]);
    assert.deepEqual(store.series('999999'), { values: [], x: [] });
  } finally {
    store.dispose();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('dispose 落盘；新实例能接着读当天的点', function () {
  const tmp = tempFile();
  const clock = new Date(2026, 9, 28, 14, 0, 0);
  const first = createFundMinuteStore({
    file: tmp.file,
    now: function () { return clock; },
    flushDelay: 60000
  });

  try {
    first.record('001186', { price: 1.6, date: '2026-10-28' });
    assert.equal(first.dispose(), true);
    assert.equal(fs.existsSync(tmp.file), true);

    const second = createFundMinuteStore({ file: tmp.file, now: function () { return clock; } });
    assert.deepEqual(second.series('001186').values, [1.6]);
    // 没有新数据时 flush 不重复写
    assert.equal(second.flush(), false);
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('换天后丢掉昨天的点', function () {
  const tmp = tempFile();
  const yesterday = new Date(2026, 9, 27, 10, 0, 0);
  const first = createFundMinuteStore({
    file: tmp.file,
    now: function () { return yesterday; },
    flushDelay: 60000
  });
  first.record('001186', { price: 1.6, date: '2026-10-27' });
  first.dispose();

  const today = new Date(2026, 9, 28, 9, 31, 0);
  const second = createFundMinuteStore({ file: tmp.file, now: function () { return today; } });
  assert.deepEqual(second.series('001186'), { values: [], x: [] });

  // 新的一天重新开槽，而不是接在昨天的曲线上
  second.record('001186', { price: 1.7, date: '2026-10-28' });
  const series = second.series('001186');
  assert.deepEqual(series.values, [1.7]);
  assert.deepEqual(series.x, [1]);
  second.dispose();
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

test('缓存文件损坏时从空开始，不抛错', function () {
  const tmp = tempFile();
  fs.mkdirSync(path.dirname(tmp.file), { recursive: true });
  fs.writeFileSync(tmp.file, '{ broken', 'utf8');
  try {
    const store = createFundMinuteStore({
      file: tmp.file,
      now: function () { return new Date(2026, 9, 28, 10, 0, 0); }
    });
    assert.deepEqual(store.series('001186'), { values: [], x: [] });
    store.record('001186', { price: 1.9, date: '2026-10-28' });
    assert.deepEqual(store.series('001186').values, [1.9]);
    store.dispose();
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});
