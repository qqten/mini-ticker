'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_CONFIG,
  DEFAULT_WATCHLIST,
  PERIODS,
  TEXT_MODES,
  FOCUS_CHART_SIDES,
  FOCUS_INTERVALS,
  TOP_INDEX_CODES
} = require('./constants.cjs');
const { sameList, clampInt } = require('./utils.cjs');
const { isValidCode } = require('./symbols.cjs');
const { readJson, writeJsonAtomic, backupJson } = require('./atomic-json.cjs');

// 配置结构版本。以后加字段/改语义时在这里递增，并在 normalizeConfig 里迁移。
// 3: 引入自选分组（groups / activeGroupId），旧 symbols 迁移进「默认」组。
const SCHEMA_VERSION = 3;

const MAX_GROUPS = 32;
const GROUP_NAME_MAX = 24;
const FALLBACK_GROUP_NAME = '默认';

function cleanGroupName(value) {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (s || '分组').slice(0, GROUP_NAME_MAX);
}

function cleanGroupId(value, used) {
  const raw = typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9_-]/g, '') : '';
  const base = (raw || 'g').slice(0, 32);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = base + '-' + n;
    n++;
  }
  used.add(id);
  return id;
}

function cleanCodes(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach(function (c) {
    if (isValidCode(c) && out.indexOf(c) < 0) out.push(c);
  });
  return out;
}

// 只做清洗，不补默认分组：设置面板保存时用它判断「是否一个分组都不剩」。
function sanitizeGroups(list) {
  const used = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, MAX_GROUPS).forEach(function (g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return;
    out.push({
      id: cleanGroupId(g.id, used),
      name: cleanGroupName(g.name),
      symbols: cleanCodes(g.symbols)
    });
  });
  return out;
}

// 读配置时用：没有 groups 的旧配置把 symbols 原样迁进「默认」组。
function normalizeGroups(raw) {
  const groups = sanitizeGroups(raw && raw.groups);
  if (groups.length) return groups;
  let symbols = cleanCodes(raw && raw.symbols);
  if (!symbols.length) symbols = DEFAULT_CONFIG.symbols.slice();
  return [{ id: 'default', name: FALLBACK_GROUP_NAME, symbols: symbols }];
}

function groupById(cfg, id) {
  const groups = (cfg && cfg.groups) || [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].id === id) return groups[i];
  }
  return null;
}

function activeGroup(cfg) {
  return groupById(cfg, cfg && cfg.activeGroupId) || ((cfg && cfg.groups && cfg.groups[0]) || null);
}

// 快捷键格式校验：修饰符(Ctrl/Alt/Shift)+ 主键，如 Ctrl+1 / Ctrl+Alt+F / Ctrl+Shift+R
const SHORTCUT_KEY_RE = /^(F\d{1,2}|[0-9]|[a-zA-Z]|Space|Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Backspace|Delete)$/;

function validShortcut(s) {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('+');
  if (parts.length < 2 || parts.length > 4) return false; // 必须至少一个修饰符 + 主键
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].trim();
    if (m === 'Ctrl' || m === 'Control' || m === 'Alt' || m === 'Shift') continue;
    return false;
  }
  const key = parts[parts.length - 1].trim();
  return SHORTCUT_KEY_RE.test(key);
}

// HH:MM，24 小时制，同时校验范围。只校验格式会让 25:00 / 12:60 进配置，
// 定时器算出来是 null 或跨天，提醒和收盘退出就会静默失效。
function isValidTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const h = parseInt(value.slice(0, 2), 10);
  const m = parseInt(value.slice(3, 5), 10);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// 分时级别的粒度：只认白名单里的分钟数，其余一律回退 1 分钟。
function normalizeFocusInterval(value) {
  const n = Number(value);
  return FOCUS_INTERVALS.indexOf(n) >= 0 ? n : DEFAULT_CONFIG.focusInterval;
}

// 图表头部下拉里显示哪些级别：去重、按固定顺序排、只留合法值。
// 全被过滤掉时退回默认列表——下拉至少要有一项，否则用户没法切级别。
function normalizeFocusIntervals(list) {
  const picked = {};
  (Array.isArray(list) ? list : []).forEach(function (v) {
    const n = Number(v);
    if (FOCUS_INTERVALS.indexOf(n) >= 0) picked[n] = true;
  });
  const out = FOCUS_INTERVALS.filter(function (n) { return picked[n]; });
  return out.length ? out : DEFAULT_CONFIG.focusIntervals.slice();
}

// 左上角指数条选中的指数：只认下拉里的四只，其余回退上证指数。
function normalizeTopIndex(value) {
  return TOP_INDEX_CODES.indexOf(value) >= 0 ? value : DEFAULT_CONFIG.topIndex;
}

function normalizeShortcuts(sc) {
  const def = DEFAULT_CONFIG.shortcuts;
  const out = {};
  ['periodMinute', 'periodDay', 'periodMonth', 'periodYear', 'refresh', 'focus', 'showHide', 'clickThrough'].forEach(function (k) {
    out[k] = validShortcut(sc && sc[k]) ? sc[k].trim() : def[k];
  });
  return out;
}

function normalizeConfig(raw) {
  raw = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);

  // 分组：旧配置没有 groups 时由 normalizeGroups 用 symbols 建一个「默认」组。
  cfg.groups = normalizeGroups(raw);
  const wantedGroup = typeof raw.activeGroupId === 'string' ? raw.activeGroupId : '';
  cfg.activeGroupId = groupById(cfg, wantedGroup) ? wantedGroup : cfg.groups[0].id;
  // symbols 继续作为「当前分组」的镜像：浮窗、行情、聚焦图表都还按它取数。
  cfg.symbols = activeGroup(cfg).symbols.slice();

  const watchlist = cleanCodes(raw.watchlist);
  if (!watchlist.length) watchlist.push.apply(watchlist, DEFAULT_WATCHLIST);
  cfg.groups.forEach(function (g) {
    g.symbols.forEach(function (c) {
      if (watchlist.indexOf(c) < 0) watchlist.push(c);
    });
  });
  cfg.watchlist = watchlist;

  if (PERIODS.indexOf(cfg.period) < 0) cfg.period = 'minute';
  cfg.focusIntervals = normalizeFocusIntervals(cfg.focusIntervals);
  // 选中的级别必须在下拉里存在，否则打开图表会是个空白选择
  if (cfg.focusIntervals.indexOf(normalizeFocusInterval(cfg.focusInterval)) < 0) {
    cfg.focusInterval = cfg.focusIntervals[0];
  } else {
    cfg.focusInterval = normalizeFocusInterval(cfg.focusInterval);
  }
  if (TEXT_MODES.indexOf(cfg.textMode) < 0) cfg.textMode = 'auto';
  if (FOCUS_CHART_SIDES.indexOf(cfg.focusChartSide) < 0) {
    cfg.focusChartSide = DEFAULT_CONFIG.focusChartSide;
  }
  if (cfg.lastEffectiveTextMode !== 'dark') cfg.lastEffectiveTextMode = 'light';
  if (['off', 'pct-desc', 'pct-asc'].indexOf(cfg.sortMode) < 0) cfg.sortMode = 'off';
  cfg.showTopIndex = cfg.showTopIndex !== false;
  cfg.topIndex = normalizeTopIndex(cfg.topIndex);

  cfg.alert = Object.assign({}, DEFAULT_CONFIG.alert, raw.alert || {});
  if (!isValidTime(cfg.alert.time)) cfg.alert.time = DEFAULT_CONFIG.alert.time;

  cfg.autoExit = Object.assign({}, DEFAULT_CONFIG.autoExit, raw.autoExit || {});
  if (!isValidTime(cfg.autoExit.time)) cfg.autoExit.time = DEFAULT_CONFIG.autoExit.time;

  cfg.autoStart = Object.assign({}, DEFAULT_CONFIG.autoStart, raw.autoStart || {});
  // 兼容中间版本写过的 mode 字段：mode=schedule 等同于 enabled
  if (raw.autoStart && typeof raw.autoStart.mode === 'string') {
    cfg.autoStart.enabled = raw.autoStart.mode === 'schedule' || raw.autoStart.mode === 'login';
    delete cfg.autoStart.mode;
  }
  cfg.autoStart.enabled = !!cfg.autoStart.enabled;
  if (!isValidTime(cfg.autoStart.time)) cfg.autoStart.time = DEFAULT_CONFIG.autoStart.time;

  cfg.interval = clampInt(cfg.interval, DEFAULT_CONFIG.interval, 1000, 60000);
  cfg.probeIntervalMs = clampInt(cfg.probeIntervalMs, DEFAULT_CONFIG.probeIntervalMs, 1000, 15000);
  cfg.backdropOpacity = clampInt(cfg.backdropOpacity, DEFAULT_CONFIG.backdropOpacity, 0, 95);
  cfg.width = clampInt(cfg.width, DEFAULT_CONFIG.width, 220, 640);
  cfg.height = clampInt(cfg.height, DEFAULT_CONFIG.height, 0, 900);

  cfg.backdrop = !!cfg.backdrop;
  cfg.alwaysOnTop = !!cfg.alwaysOnTop;
  cfg.locked = !!cfg.locked;
  cfg.showName = cfg.showName !== false;
  cfg.baseline = cfg.baseline !== false;
  cfg.shortcuts = normalizeShortcuts(raw.shortcuts);
  cfg.schemaVersion = SCHEMA_VERSION;

  if (!cfg.pos || typeof cfg.pos !== 'object' ||
      !isFinite(cfg.pos.x) || !isFinite(cfg.pos.y)) {
    cfg.pos = null;
  } else {
    cfg.pos = { x: Math.round(cfg.pos.x), y: Math.round(cfg.pos.y) };
  }
  // 多屏记忆：只保留合法的 displayId -> 坐标，避免配置被手改坏后窗口开到屏幕外。
  cfg.displayPositions = {};
  if (raw.displayPositions && typeof raw.displayPositions === 'object' && !Array.isArray(raw.displayPositions)) {
    Object.keys(raw.displayPositions).slice(0, 32).forEach(function (id) {
      const p = raw.displayPositions[id];
      if (!id || id.length > 64) return;
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') return;
      if (!p || typeof p !== 'object' || !isFinite(p.x) || !isFinite(p.y)) return;
      cfg.displayPositions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    });
  }
  cfg.lastDisplayId = typeof raw.lastDisplayId === 'string' ? raw.lastDisplayId.slice(0, 64) : '';

  if (typeof cfg.updateFeed !== 'string') cfg.updateFeed = '';

  return cfg;
}

function loadConfig(options) {
  const configPath = options.configPath;
  const log = options.log;
  const backup = configPath + '.bak';
  let raw = null;

  try {
    raw = readJson(configPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT' && log) {
      log('[config]', '读取配置失败，尝试备份：' + error.message);
    }
    try {
      raw = readJson(backup);
      if (log) log('[config]', '已从备份恢复配置：' + backup);
    } catch (backupError) {
      raw = null;
    }
  }

  return normalizeConfig(raw || {});
}

function saveConfig(options) {
  const configPath = options.configPath;
  const log = options.log;
  try {
    // 只有现有文件是合法 JSON 才备份，避免把损坏内容盖到唯一的好备份上。
    backupJson(configPath, configPath + '.bak');
    writeJsonAtomic(configPath, options.config);
    return true;
  } catch (error) {
    if (log) log('[config]', '保存失败：' + error.message);
    else console.error('[config] 保存失败:', error.message);
    return false;
  }
}

function candidateConfigPaths(options) {
  const out = [];
  const configPath = options.configPath;
  const push = function (p) {
    if (p && out.indexOf(p) < 0) out.push(p);
  };
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  push(path.join(dir, 'config.json'));
  push(path.join(dir, '..', 'config.json'));
  push(path.join(options.resDir, 'config.json'));
  return out.filter(function (p) {
    return path.resolve(p) !== path.resolve(configPath);
  });
}

function pickConfigFrom(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    try {
      if (!fs.existsSync(p)) continue;
      const raw = readJson(p);
      if (!raw || typeof raw !== 'object') continue;
      if (!Array.isArray(raw.symbols) || !raw.symbols.length) continue;
      return { path: p, data: raw };
    } catch (error) {
      // 候选文件损坏就跳过，不影响其它位置。
    }
  }
  return null;
}

// 一份配置是不是「原封不动的默认值」：是的话说明没被用户动过，可以让位给老配置
function isFreshDefault(cfg) {
  const normalized = normalizeConfig(cfg);
  return sameList(normalized.symbols, DEFAULT_CONFIG.symbols) &&
    sameList(normalized.watchlist, DEFAULT_WATCHLIST) &&
    normalized.groups.length === 1 &&
    normalized.groups[0].id === 'default' &&
    normalized.groups[0].name === FALLBACK_GROUP_NAME;
}

// 首次启动：把老位置的配置接过来。只跑一次，结果记在 .config-migrated。
function migrateConfig(options) {
  const dataDir = options.dataDir;
  const configPath = options.configPath;
  const log = options.log;
  const marker = path.join(dataDir, '.config-migrated');
  if (fs.existsSync(marker)) return false;

  try {
    const src = pickConfigFrom(candidateConfigPaths(options));
    let take = false;
    if (src) {
      if (!fs.existsSync(configPath)) {
        take = true;
      } else {
        try {
          take = isFreshDefault(readJson(configPath));
        } catch (error) {
          take = true;
        }
      }
    }
    if (take) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.copyFileSync(src.path, configPath);
      if (log) log('[config]', '已继承本地配置：' + src.path);
    }
    fs.writeFileSync(marker, (src ? src.path : '') + '\n', 'utf8');
    return take;
  } catch (error) {
    if (log) log('[config]', '配置迁移失败：' + error.message);
    return false;
  }
}

module.exports = {
  SCHEMA_VERSION,
  MAX_GROUPS,
  GROUP_NAME_MAX,
  isValidTime,
  validShortcut,
  normalizeFocusInterval,
  normalizeFocusIntervals,
  normalizeTopIndex,
  normalizeShortcuts,
  sanitizeGroups,
  normalizeGroups,
  groupById,
  activeGroup,
  normalizeConfig,
  loadConfig,
  saveConfig,
  candidateConfigPaths,
  pickConfigFrom,
  isFreshDefault,
  migrateConfig
};
