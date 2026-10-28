'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_CONFIG,
  DEFAULT_WATCHLIST,
  PERIODS,
  TEXT_MODES
} = require('./constants.cjs');
const { sameList, clampInt } = require('./utils.cjs');
const { readJson, writeJsonAtomic, backupJson } = require('./atomic-json.cjs');

// 配置结构版本。以后加字段/改语义时在这里递增，并在 normalizeConfig 里迁移。
const SCHEMA_VERSION = 1;

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

function normalizeShortcuts(sc) {
  const def = DEFAULT_CONFIG.shortcuts;
  const out = {};
  ['periodMinute', 'periodDay', 'periodMonth', 'periodYear', 'refresh', 'focus'].forEach(function (k) {
    out[k] = validShortcut(sc && sc[k]) ? sc[k].trim() : def[k];
  });
  return out;
}

function normalizeConfig(raw) {
  raw = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);

  if (!Array.isArray(cfg.symbols) || cfg.symbols.length === 0) {
    cfg.symbols = DEFAULT_CONFIG.symbols.slice();
  }
  if (!Array.isArray(cfg.watchlist) || cfg.watchlist.length === 0) {
    cfg.watchlist = DEFAULT_WATCHLIST.slice();
  }

  if (PERIODS.indexOf(cfg.period) < 0) cfg.period = 'minute';
  if (TEXT_MODES.indexOf(cfg.textMode) < 0) cfg.textMode = 'auto';
  if (cfg.lastEffectiveTextMode !== 'dark') cfg.lastEffectiveTextMode = 'light';
  if (['off', 'pct-desc', 'pct-asc'].indexOf(cfg.sortMode) < 0) cfg.sortMode = 'off';

  cfg.alert = Object.assign({}, DEFAULT_CONFIG.alert, raw.alert || {});
  if (!/^\d{2}:\d{2}$/.test(cfg.alert.time)) cfg.alert.time = DEFAULT_CONFIG.alert.time;

  cfg.autoExit = Object.assign({}, DEFAULT_CONFIG.autoExit, raw.autoExit || {});
  if (!/^\d{2}:\d{2}$/.test(cfg.autoExit.time)) cfg.autoExit.time = DEFAULT_CONFIG.autoExit.time;

  cfg.autoStart = Object.assign({}, DEFAULT_CONFIG.autoStart, raw.autoStart || {});
  // 兼容中间版本写过的 mode 字段：mode=schedule 等同于 enabled
  if (raw.autoStart && typeof raw.autoStart.mode === 'string') {
    cfg.autoStart.enabled = raw.autoStart.mode === 'schedule' || raw.autoStart.mode === 'login';
    delete cfg.autoStart.mode;
  }
  cfg.autoStart.enabled = !!cfg.autoStart.enabled;
  if (!/^\d{2}:\d{2}$/.test(cfg.autoStart.time)) cfg.autoStart.time = DEFAULT_CONFIG.autoStart.time;

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
    sameList(normalized.watchlist, DEFAULT_WATCHLIST);
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
  validShortcut,
  normalizeShortcuts,
  normalizeConfig,
  loadConfig,
  saveConfig,
  candidateConfigPaths,
  pickConfigFrom,
  isFreshDefault,
  migrateConfig
};
