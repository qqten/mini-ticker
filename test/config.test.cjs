'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DEFAULT_CONFIG, DEFAULT_WATCHLIST } = require('../electron/core/constants.cjs');
const {
  SCHEMA_VERSION,
  validShortcut,
  normalizeShortcuts,
  normalizeConfig,
  loadConfig,
  saveConfig,
  migrateConfig
} = require('../electron/core/config.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ticker-config-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
}

test('validShortcut 只接受「修饰符 + 主键」', function () {
  assert.equal(validShortcut('Ctrl+1'), true);
  assert.equal(validShortcut('Ctrl+Alt+F'), true);
  assert.equal(validShortcut('Control+Shift+ArrowUp'), true);
  assert.equal(validShortcut('Ctrl'), false);
  assert.equal(validShortcut('Ctrl+Foo'), false);
  assert.equal(validShortcut('a+b'), false);
  assert.equal(validShortcut(null), false);
});

test('normalizeShortcuts 对非法值逐项回退默认', function () {
  const out = normalizeShortcuts({ refresh: 'R', focus: 'Ctrl+Alt+F' });
  assert.equal(out.refresh, DEFAULT_CONFIG.shortcuts.refresh);
  assert.equal(out.focus, 'Ctrl+Alt+F');
  assert.equal(out.periodMinute, DEFAULT_CONFIG.shortcuts.periodMinute);
});

test('normalizeConfig 修掉越界 / 非法字段并补默认值', function () {
  const cfg = normalizeConfig({
    symbols: [],
    watchlist: [],
    period: 'week',
    interval: 5,
    textMode: 'blue',
    sortMode: 'hot',
    width: 10,
    height: 2000,
    backdropOpacity: 200,
    alert: null,
    autoStart: { mode: 'schedule', time: '9:25' },
    shortcuts: { refresh: 'R' }
  });

  assert.deepEqual(cfg.symbols, DEFAULT_CONFIG.symbols);
  assert.deepEqual(cfg.watchlist, DEFAULT_WATCHLIST);
  assert.equal(cfg.period, 'minute');
  assert.equal(cfg.textMode, 'auto');
  assert.equal(cfg.sortMode, 'off');
  assert.equal(cfg.interval, 1000);
  assert.equal(cfg.width, 220);
  assert.equal(cfg.height, 900);
  assert.equal(cfg.backdropOpacity, 95);
  assert.equal(cfg.alert.time, DEFAULT_CONFIG.alert.time);
  // 中间版本写过的 mode=schedule 等同于 enabled
  assert.equal(cfg.autoStart.enabled, true);
  assert.equal(cfg.autoStart.time, DEFAULT_CONFIG.autoStart.time);
  assert.equal(cfg.autoStart.mode, undefined);
  assert.equal(cfg.shortcuts.refresh, DEFAULT_CONFIG.shortcuts.refresh);
  assert.equal(cfg.schemaVersion, SCHEMA_VERSION);
  assert.equal(cfg.pos, null);
});

test('normalizeConfig 保留合法自选、位置和布尔开关', function () {
  const cfg = normalizeConfig({
    symbols: ['sh600519'],
    watchlist: ['sh600519', '001186'],
    pos: { x: 10.4, y: -3.6 },
    showName: false,
    baseline: false,
    backdrop: 1,
    locked: 'yes'
  });
  assert.deepEqual(cfg.symbols, ['sh600519']);
  assert.deepEqual(cfg.watchlist, ['sh600519', '001186']);
  assert.deepEqual(cfg.pos, { x: 10, y: -4 });
  assert.equal(cfg.showName, false);
  assert.equal(cfg.baseline, false);
  assert.equal(cfg.backdrop, true);
  assert.equal(cfg.locked, true);
});

test('saveConfig 原子写入，loadConfig 容忍 BOM', function () {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  try {
    const cfg = normalizeConfig({ symbols: ['sh600519'], interval: 5000 });
    assert.equal(saveConfig({ configPath: configPath, config: cfg }), true);

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.interval, 5000);
    assert.equal(saved.schemaVersion, SCHEMA_VERSION);
    // 不留下临时文件
    assert.deepEqual(fs.readdirSync(dir).filter(function (f) { return f.endsWith('.tmp'); }), []);

    // 记事本改过的配置会带 BOM
    fs.writeFileSync(configPath, '\uFEFF' + JSON.stringify({ symbols: ['sz399001'] }), 'utf8');
    const loaded = loadConfig({ configPath: configPath });
    assert.deepEqual(loaded.symbols, ['sz399001']);
    assert.deepEqual(loaded.watchlist, DEFAULT_WATCHLIST);
    assert.equal(loaded.period, 'minute');
  } finally {
    cleanup(dir);
  }
});

test('主配置损坏时从 .bak 恢复', function () {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  const logs = [];
  try {
    const first = normalizeConfig({ symbols: ['sh600519'] });
    saveConfig({ configPath: configPath, config: first });
    const second = normalizeConfig({ symbols: ['sz000001'] });
    saveConfig({ configPath: configPath, config: second });

    assert.equal(fs.existsSync(configPath + '.bak'), true);
    fs.writeFileSync(configPath, '{ broken', 'utf8');

    const loaded = loadConfig({ configPath: configPath, log: function (tag, msg) { logs.push(tag + msg); } });
    assert.deepEqual(loaded.symbols, ['sh600519']);
    assert.equal(logs.some(function (l) { return l.indexOf('备份') >= 0; }), true);
  } finally {
    cleanup(dir);
  }
});

test('主配置和备份都坏了也能拿到默认值', function () {
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(configPath, 'nope', 'utf8');
    fs.writeFileSync(configPath + '.bak', 'nope too', 'utf8');
    const loaded = loadConfig({ configPath: configPath });
    assert.deepEqual(loaded.symbols, DEFAULT_CONFIG.symbols);
  } finally {
    cleanup(dir);
  }
});

test('migrateConfig 首次启动接管老配置，只跑一次', function () {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  const resDir = path.join(dir, 'res');
  const configPath = path.join(dataDir, 'config.json');
  try {
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(resDir, 'config.json'),
      JSON.stringify({ symbols: ['sh600519'], watchlist: ['sh600519'] }), 'utf8');

    assert.equal(migrateConfig({ dataDir: dataDir, resDir: resDir, configPath: configPath }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).symbols, ['sh600519']);
    assert.equal(fs.existsSync(path.join(dataDir, '.config-migrated')), true);

    // 再次启动（即使源文件还在）不再覆盖用户后来的配置
    fs.writeFileSync(configPath, JSON.stringify({ symbols: ['sz000001'] }), 'utf8');
    assert.equal(migrateConfig({ dataDir: dataDir, resDir: resDir, configPath: configPath }), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).symbols, ['sz000001']);
  } finally {
    cleanup(dir);
  }
});

test('migrateConfig 忽略没有 symbols 的候选文件', function () {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  const resDir = path.join(dir, 'res');
  const configPath = path.join(dataDir, 'config.json');
  try {
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(resDir, 'config.json'), JSON.stringify({ period: 'day' }), 'utf8');
    assert.equal(migrateConfig({ dataDir: dataDir, resDir: resDir, configPath: configPath }), false);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    cleanup(dir);
  }
});
