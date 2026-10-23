const { app, BrowserWindow, ipcMain, Menu, screen, shell, Notification, desktopCapturer, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// 极简浮窗不需要 GPU 合成，禁用硬件加速可避免部分机器上 GPU 进程崩溃、并降低功耗
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

/* ---------------- 运行日志（闪退排查用） ---------------- */

const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function logLine(tag, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 512 * 1024) {
        try { fs.unlinkSync(LOG_FILE + '.old'); } catch (e) {}
        fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      }
    } catch (e) {}
    const d = new Date();
    const ts = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    fs.appendFileSync(LOG_FILE, '[' + ts + '] ' + tag + ' ' + msg + '\n');
  } catch (e) {}
}

// 常用指数名称表（watchlist 里出现的代码会优先用这里的名字）
const NAMES = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000688: '科创50',
  sh000300: '沪深300',
  sh000016: '上证50',
  sh000905: '中证500',
  sh000852: '中证1000',
  bj899050: '北证50',
  hkHSI: '恒生指数',
  hkHSTECH: '恒生科技',
  hkHSCEI: '国企指数',
  usDJI: '道琼斯',
  usIXIC: '纳斯达克',
  usINX: '标普500',
  usNDX: '纳指100',
  hf_GC: '纽约金',
  hf_XAU: '伦敦金',
  hf_SI: '纽约白银',
  hf_XAG: '伦敦银',
  hf_XPT: '纽约铂金',
  hf_CL: 'WTI原油',
  hf_OIL: '布伦特原油',
  hf_HG: 'COMEX铜',
  hf_NG: '美国天然气',
  usDXY: '美元指数'
};

// 东财特殊品种（非 hf_ 前缀）：美元指数等
const EM_SECID = {
  usDXY: '100.UDI'   // 美元指数
};

const DEFAULT_WATCHLIST = [
  'sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300', 'sh000016',
  'sh000905', 'sh000852', 'bj899050', 'hkHSI', 'hkHSTECH', 'usDJI', 'usIXIC', 'usINX'
];

const PERIODS = ['minute', 'day', 'month', 'year'];
const PERIOD_LABEL = { minute: '分时', day: '日线', month: '月线', year: '年线' };

// 文字配色：light = 亮色文字（配深背景），dark = 暗色文字（配浅背景），auto = 跟随窗口背后的实际画面
const TEXT_MODES = ['light', 'dark', 'auto'];

const DEFAULT_CONFIG = {
  symbols: ['sh000001', 'sz399001', 'sz399006', 'sh000688'],
  watchlist: DEFAULT_WATCHLIST,
  period: 'minute',
  interval: 3000,
  probeIntervalMs: 4000,
  alert: { enabled: true, time: '14:30' },
  // 收盘后自动退出：默认 15:05（留几分钟让收盘数据落定）
  autoExit: { enabled: true, time: '15:05' },
  // 开盘自动启动：靠 Windows 计划任务，工作日定点拉起
  autoStart: { enabled: false, time: '09:25' },
  textMode: 'auto',
  backdrop: false,
  backdropOpacity: 40,
  sparkWidth: 120,
  showName: true,
  baseline: true,
  alwaysOnTop: true,
  locked: false,
  width: 320,
  // 高度：0 表示跟随内容自动撑开，>0 表示用户手动拖过、以这个值为准
  height: 0,
  pos: null
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const HEADERS = { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' };
const SINA_HEADERS = { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' };
const FUND_HEADERS = { 'User-Agent': UA, 'Referer': 'https://fund.eastmoney.com/' };

// 分时线 20s 一拉；K 线变化慢，60s 一拉
const MINUTE_TTL = 20000;
const KLINE_TTL = 60000;
let seriesCache = { at: 0, map: {}, period: null };
// 取数失败只记一次日志，避免每 3 秒刷屏
let seriesFailLogged = {};

let config = loadConfig();
let win = null;
// 渲染层最近一次算出的"内容自然高度"，用来区分用户手动拖高还是内容撑开
let autoFitHeight = 0;
// 最近一次拖动调尺寸的时间戳：拖动期间不允许内容高度插手，否则会互相抢
let resizingAt = 0;
let settingsWin = null;
let dragTimer = null;
let dragProbeTimer = null;
let dragBase = null;

function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw);
  if (!Array.isArray(cfg.symbols) || cfg.symbols.length === 0) cfg.symbols = DEFAULT_CONFIG.symbols.slice();
  if (!Array.isArray(cfg.watchlist) || cfg.watchlist.length === 0) cfg.watchlist = DEFAULT_WATCHLIST.slice();
  if (PERIODS.indexOf(cfg.period) < 0) cfg.period = 'minute';
  // 配色固定跟随背景，不再提供手动切换
  cfg.textMode = 'auto';
  cfg.alert = Object.assign({}, DEFAULT_CONFIG.alert, raw.alert || {});
  if (!/^\d{2}:\d{2}$/.test(cfg.alert.time)) cfg.alert.time = DEFAULT_CONFIG.alert.time;
  cfg.autoExit = Object.assign({}, DEFAULT_CONFIG.autoExit, raw.autoExit || {});
  if (!/^\d{2}:\d{2}$/.test(cfg.autoExit.time)) cfg.autoExit.time = DEFAULT_CONFIG.autoExit.time;
  cfg.autoStart = Object.assign({}, DEFAULT_CONFIG.autoStart, raw.autoStart || {});
  if (!/^\d{2}:\d{2}$/.test(cfg.autoStart.time)) cfg.autoStart.time = DEFAULT_CONFIG.autoStart.time;
  return cfg;
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] 保存失败:', e.message);
  }
}

/* ---------------- 行情抓取 ---------------- */

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : NaN;
}

async function fetchGbk(url, headers) {
  const res = await fetch(url, { headers: headers || HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return buf.toString('latin1');
  }
}

// 实时快照（GBK），一次请求拿全部标的
async function fetchSnapshots(codes) {
  // 东财特殊品种（美元指数等）：腾讯不支持，单独走东财快照
  const emCodes = codes.filter(function (c) { return EM_SECID[c]; });
  const txCodes = codes.filter(function (c) { return !EM_SECID[c]; });
  const out = {};
  for (let i = 0; i < emCodes.length; i++) {
    const code = emCodes[i];
    const secid = EM_SECID[code];
    try {
      const j = await fetchJson('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid +
        '&fields=f43,f44,f45,f46,f57,f58,f60,f170');
      const d = j.data;
      if (!d) continue;
      // 东财价格放大了 100 倍（美元指数两位小数）
      const price = (d.f43 || 0) / 100;
      const prev = (d.f60 || 0) / 100;
      out[code] = {
        name: NAMES[code] || d.f58 || code,
        price: price,
        prevClose: prev,
        pct: (d.f170 || 0) / 100,
        change: price - prev,
        time: ''
      };
    } catch (e) {}
  }
  if (!txCodes.length) return out;
  codes = txCodes;
  // 调试用：TICKER_FORCE_SINA=1 时优先走新浪，验证兜底链路是否可用
  if (process.env.TICKER_FORCE_SINA) {
    try {
      const alt = await fetchSinaSnapshots(codes);
      if (Object.keys(alt).length) return alt;
    } catch (e) {}
  }
  try {
    const text = await fetchGbk('https://qt.gtimg.cn/q=' + codes.join(','));
    const map = {};
    text.split(';').forEach(function (line) {
      const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
      if (!m) return;
      const code = m[1];
      const a = m[2].split('~');
      if (/^hf_/i.test(code)) {
        // 外盘期货：现价,涨跌,...,最高,最低,时间,昨结,今开,...,日期,名称
        const price = num(a[0]);
        const change = num(a[1]);
        const prev = num(a[7]);
        map[code] = {
          name: NAMES[code] || a[13] || code,
          price: price,
          prevClose: prev,
          pct: (isFinite(price) && isFinite(prev) && prev) ? (change / prev) * 100 : NaN,
          change: change,
          time: (a[12] || '') + ' ' + (a[6] || '')
        };
      } else {
        map[code] = {
          name: a[1] || code,
          price: num(a[3]),
          prevClose: num(a[4]),
          pct: num(a[32]),
          change: num(a[31]),
          time: a[30] || ''
        };
      }
    });
    if (Object.keys(map).length) {
      // 合并东财特殊品种结果
      Object.keys(out).forEach(function (k) { map[k] = out[k]; });
      return map;
    }
    throw new Error('快照为空');
  } catch (e) {
    const alt = await fetchSinaSnapshots(codes);
    if (Object.keys(alt).length) {
      Object.keys(out).forEach(function (k) { alt[k] = out[k]; });
      return alt;
    }
    throw e;
  }
}

// 新浪快照兜底。新浪各家字段顺序不一样，按代码类型分开解析：
//   int_ 美股指数：名称, 现价, 涨跌, 涨跌%
//   hk   港股：    代码, 名称, 今开, 昨收, 最高, 最低, 现价, 涨跌, 涨跌%
//   A股/指数：     名称, 今开, 昨收, 现价, 最高, 最低, ...
const SINA_ALIAS = {
  usDJI: 'int_dji',
  usIXIC: 'int_nasdaq',
  usINX: 'int_sp500'
};

function sinaSymbol(code) {
  if (SINA_ALIAS[code]) return SINA_ALIAS[code];
  if (/^(sh|sz|bj)/i.test(code)) return code.toLowerCase();
  if (/^hk/i.test(code)) return code;                                // hkHSI 直接用
  if (/^us/i.test(code)) return 'gb_' + code.slice(2).toLowerCase(); // 美股个股兜底
  return null;
}

async function fetchSinaSnapshots(codes) {
  const forward = {};
  const backward = {};
  codes.forEach(function (c) {
    const s = sinaSymbol(c);
    if (!s) return;
    forward[c] = s;
    backward[s] = c;
  });
  const syms = Object.keys(backward);
  if (!syms.length) return {};

  const text = await fetchGbk('https://hq.sinajs.cn/list=' + syms.join(','), SINA_HEADERS);
  const map = {};
  text.split(';').forEach(function (line) {
    const m = /hq_str_([A-Za-z0-9_$]+)="([^"]*)"/.exec(line);
    if (!m || !m[2]) return;
    const code = backward[m[1]];
    if (!code) return;

    const a = m[2].split(',');
    let name = a[0], price = NaN, prev = NaN, chg = NaN, pct = NaN;

    if (/^int_/.test(m[1])) {
      name = a[0];
      price = num(a[1]);
      chg = num(a[2]);
      pct = num(a[3]);
      prev = isFinite(price) && isFinite(chg) ? price - chg : NaN;
    } else if (/^hk/i.test(m[1])) {
      name = a[1] || m[1];
      price = num(a[6]);
      prev = num(a[3]);
      chg = num(a[7]);
      pct = num(a[8]);
    } else {
      name = a[0] || m[1];
      price = num(a[3]);
      prev = num(a[2]);
      if (isFinite(price) && isFinite(prev)) {
        chg = price - prev;
        pct = prev ? (chg / prev) * 100 : NaN;
      }
    }

    if (!isFinite(price) || price <= 0) return;
    map[code] = { name: name, price: price, prevClose: prev, pct: pct, change: chg, time: '' };
  });

  if (Object.keys(map).length) noteSinaFallback();
  return map;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  const head = text.trim().slice(0, 1);
  // 被 WAF 拦下时返回的是 HTML 挑战页（甚至 200 状态码），直接 res.json() 会抛 SyntaxError
  if (head === '<') throw new Error('接口返回网页（疑似被拦截）');
  return JSON.parse(text);
}

// 腾讯行情有两个等价入口：主域名被 WAF 拦就换备用域名，数据格式完全一致
const QT_HOSTS = [
  'https://ifzq.gtimg.cn',
  'https://proxy.finance.qq.com/ifzqgtimg'
];
let qtHostIdx = 0;

async function fetchTencentJson(pathAndQuery) {
  let lastErr = null;
  for (let i = 0; i < QT_HOSTS.length; i++) {
    const idx = (qtHostIdx + i) % QT_HOSTS.length;
    try {
      const j = await fetchJson(QT_HOSTS[idx] + pathAndQuery);
      if (idx !== qtHostIdx) {
        qtHostIdx = idx;
        logLine('[quote]', '已切换到备用行情入口 ' + QT_HOSTS[idx]);
      }
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('行情接口不可用');
}

/* ---------------- 标的搜索：名称 / 拼音 / 代码 ---------------- */

// smartbox 返回的 name 是 \uXXXX 转义；个别情况直接是中文，两种都兼容
function unescapeUnicode(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
}

const TYPE_LABEL = {
  'GP-A': 'A股',
  'GP-A-KCB': '科创板',
  'GP-A-CYB': '创业板',
  'GP-B': 'B股',
  ZS: '指数',
  ETF: 'ETF',
  LOF: 'LOF',
  FJ: '分级',
  QZ: '权证',
  KJ: '场外基金',
  'GP-HK': '港股',
  'GP-US': '美股'
};

async function searchSymbols(keyword) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  const out = [];
  const seen = {};

  // 用户直接输入代码（如 hf_GC、sh518880）时，即使搜索接口没有也直接返回
  if (isValidCode(q)) {
    out.push({ code: q, name: NAMES[q] || q, market: q.slice(0, 2).toLowerCase(), type: '', typeLabel: '' });
    seen[q] = true;
  }

  // 外盘期货（hf_）和东财特殊品种（usDXY）搜索接口不覆盖，按名称本地匹配
  const ql = q.toLowerCase();
  Object.keys(NAMES).forEach(function (code) {
    if (!/^hf_/i.test(code) && !EM_SECID[code]) return;
    const name = NAMES[code];
    if (seen[code]) return;
    if (name.toLowerCase().indexOf(ql) >= 0 || code.toLowerCase().indexOf(ql) >= 0) {
      out.push({ code: code, name: name, market: /^hf_/i.test(code) ? 'hf' : 'em', type: '', typeLabel: '外盘期货' });
      seen[code] = true;
    }
  });

  const text = await fetchGbk('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(q) + '&t=all&c=1');
  const m = /v_hint="([^"]*)"/.exec(text);
  if (m && m[1] && m[1] !== 'N') {
    m[1].split('^').forEach(function (row) {
      const a = row.split('~');
      if (a.length < 5) return;

      const market = String(a[0] || '').toLowerCase();
      const raw = String(a[1] || '');
      const name = unescapeUnicode(a[2] || '');
      const type = a[4] || '';

      // 场外基金在内部统一用 6 位纯数字（走新浪估值），其余是「市场前缀 + 代码」
      const code = (market === 'jj' || market === 'of' || type === 'KJ') ? raw : market + raw;

      if (!isValidCode(code) || seen[code]) return;
      seen[code] = true;
      out.push({
        code: code,
        name: name || code,
        market: market,
        type: type,
        typeLabel: TYPE_LABEL[type] || ''
      });
    });
  }

  return out.slice(0, 12);
}

/* ---------------- 新浪财经：腾讯接口全挂时的兜底 ---------------- */
// 新浪只认 sh / sz / bj 前缀，港股美股它的 K 线接口返回 null
function sinaSupported(code) {
  return /^(sh|sz|bj)/i.test(code);
}

let sinaFallbackLogged = false;
function noteSinaFallback() {
  if (sinaFallbackLogged) return;
  sinaFallbackLogged = true;
  logLine('[quote]', '腾讯行情不可用，已切到新浪财经兜底');
}

// 新浪的 K 线是 JSONP：/*<script>...*/ x=([{...}])，把数组抠出来
function parseSinaJsonp(text) {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return []; }
}

async function fetchSinaText(url) {
  const res = await fetch(url, { headers: SINA_HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// 当日分时 → 价格序列
async function fetchSinaMinute(code) {
  const url = 'https://quotes.sina.cn/cn/api/openapi.php/CN_MinlineService.getMinlineData?symbol=' +
    encodeURIComponent(code) + '&scale=1&dpc=1';
  const j = JSON.parse(await fetchSinaText(url));
  const arr = (j && j.result && j.result.data) || [];
  const pts = [];
  for (let i = 0; i < arr.length; i++) {
    const p = num(arr[i] && arr[i].p);
    if (isFinite(p)) pts.push(p);
  }
  return pts;
}

// 新浪 K 线周期：240=日 1200=周 7200=月
const SINA_SCALE = { day: 240, week: 1200, month: 7200 };

// 转成和腾讯一致的 [日期, 开, 收, 高, 低, 量]，这样 closeSeries 不用改
async function fetchSinaKline(code, interval, count) {
  const scale = SINA_SCALE[interval] || SINA_SCALE.day;
  const url = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/x=/CN_MarketDataService.getKLineData?symbol=' +
    encodeURIComponent(code) + '&scale=' + scale + '&ma=no&datalen=' + count;
  const arr = parseSinaJsonp(await fetchSinaText(url));
  if (!Array.isArray(arr)) return [];
  return arr.map(function (o) {
    return [o.day, o.open, o.close, o.high, o.low, o.volume];
  });
}

// 当日分时（一次只能查一个 code）
async function fetchMinuteSeries(code) {
  // 东财特殊品种（美元指数等）和外盘期货：腾讯不支持分时，走东财 trends2
  if (EM_SECID[code] || HF_EM_SECID[code]) {
    const secid = EM_SECID[code] || HF_EM_SECID[code];
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
    const j = await fetchJson(url);
    const trends = (j && j.data && j.data.trends) || [];
    return trends.map(function (t) { return num(String(t).split(',')[1]); }).filter(isFinite);
  }
  if (process.env.TICKER_FORCE_SINA && sinaSupported(code)) {
    try {
      const alt = await fetchSinaMinute(code);
      if (alt.length >= 2) return alt;
    } catch (e) {}
  }
  try {
    const j = await fetchTencentJson('/appstock/app/minute/query?code=' + encodeURIComponent(code));
    const block = j && j.data && j.data[code];
    const raw = block && block.data && block.data.data;
    const pts = [];
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i++) {
        const p = num(String(raw[i]).trim().split(/\s+/)[1]);
        if (isFinite(p)) pts.push(p);
      }
    }
    if (pts.length >= 2 || !sinaSupported(code)) return pts;
    // 腾讯给回空数据，再用新浪试一次
    const alt = await fetchSinaMinute(code);
    if (alt.length >= 2) { noteSinaFallback(); return alt; }
    return pts;
  } catch (e) {
    if (!sinaSupported(code)) throw e;
    const alt = await fetchSinaMinute(code);
    if (alt.length) { noteSinaFallback(); return alt; }
    throw e;
  }
}

// K 线原始行：[日期, 开, 收, 高, 低, 量]
// 美股走 usfqkline，其余走 fqkline
async function fetchKlineRaw(code, interval, count) {
  if (process.env.TICKER_FORCE_SINA && sinaSupported(code)) {
    try {
      const alt = await fetchSinaKline(code, interval, count);
      if (alt.length) return alt;
    } catch (e) {}
  }
  try {
    const ep = code.slice(0, 2).toLowerCase() === 'us' ? 'usfqkline' : 'fqkline';
    const url = '/appstock/app/' + ep + '/get?param=' +
      code + ',' + interval + ',,,' + count + ',qfq';
    const j = await fetchTencentJson(url);
    const block = j && j.data && j.data[code];
    const arr = block ? (block['qfq' + interval] || block[interval] || []) : [];
    if (Array.isArray(arr) && arr.length) return arr;
    if (!sinaSupported(code)) return [];
    const alt = await fetchSinaKline(code, interval, count);
    if (alt.length) { noteSinaFallback(); return alt; }
    return [];
  } catch (e) {
    if (!sinaSupported(code)) throw e;
    const alt = await fetchSinaKline(code, interval, count);
    if (alt.length) { noteSinaFallback(); return alt; }
    throw e;
  }
}

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

// 外盘期货（hf_）→ 东方财富 secid 映射（腾讯不提供外盘分时/K线）
const HF_EM_SECID = {
  hf_XAU: '122.XAU',   // 伦敦金（现货黄金）
  hf_XAG: '122.XAG',   // 伦敦银（现货白银）
  hf_GC: '101.GC00Y',  // COMEX 黄金
  hf_SI: '101.SI00Y',  // COMEX 白银
  hf_CL: '102.CL00Y',  // NYMEX WTI 原油
  hf_OIL: '112.B00Y',  // 布伦特原油
  hf_HG: '101.HG00Y',  // COMEX 铜
  hf_NG: '102.NG00Y',  // NYMEX 天然气
  hf_XPT: '102.PL00Y'  // NYMEX 铂金
};

async function fetchSeries(code, period) {
  // 东财特殊品种（美元指数等）：走东财分时
  if (EM_SECID[code] && period === 'minute') {
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + EM_SECID[code] +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
    const j = await fetchJson(url);
    const trends = (j && j.data && j.data.trends) || [];
    return trends.map(function (t) { return num(String(t).split(',')[1]); }).filter(isFinite);
  }
  // 外盘期货（hf_ 前缀）：腾讯不提供分时/K线，走东方财富
  if (/^hf_/i.test(code)) {
    const secid = HF_EM_SECID[code];
    if (secid && period === 'minute') {
      // 当天分时：东财 trends2 接口
      const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
      const j = await fetchJson(url);
      const trends = (j && j.data && j.data.trends) || [];
      return trends.map(function (t) { return num(String(t).split(',')[1]); }).filter(isFinite);
    }
    // 日K：新浪外盘期货日K，只取最近 30 个交易日
    const sym = code.slice(3).toUpperCase();
    const url = 'https://stock2.finance.sina.com.cn/futures/api/openapi.php/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=' + sym;
    const j = await fetchJson(url);
    const rows = (j && j.result && j.result.data) || [];
    return rows.slice(-30).map(function (r) { return num(r.close); }).filter(isFinite);
  }
  if (period === 'day') return closeSeries(await fetchKlineRaw(code, 'day', 120));
  if (period === 'month') return closeSeries(await fetchKlineRaw(code, 'month', 120));
  if (period === 'year') return yearlySeries(await fetchKlineRaw(code, 'month', 240));
  return [];
}

/* ---- 场外基金（6 位纯数字代码）---- */

function isFundCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

// 盘中估值：新浪 fu_ 批量接口；货币基金等没有盘中估值的会返回空串
async function fetchFundEstimates(codes) {
  if (!codes.length) return {};
  const url = 'https://hq.sinajs.cn/list=' + codes.map(function (c) { return 'fu_' + c; }).join(',');
  const text = await fetchGbk(url, SINA_HEADERS);
  const map = {};
  text.split('\n').forEach(function (line) {
    const m = line.match(/hq_str_fu_(\d{6})="([^"]*)"/);
    if (!m) return;
    const a = m[2].split(',');
    if (a.length < 8 || !a[0]) return;
    map[m[1]] = {
      name: a[0],
      time: a[1],
      price: num(a[2]),
      prevClose: num(a[3]),
      pct: num(a[6]),
      date: a[7]
    };
  });
  return map;
}

// 历史净值：pingzhongdata 一次拿到全量日频单位净值
const NAV_TTL = 30 * 60 * 1000;
const navCache = {};

async function fetchFundNav(code) {
  const hit = navCache[code];
  if (hit && Date.now() - hit.at < NAV_TTL) return hit;

  const res = await fetch('https://fund.eastmoney.com/pingzhongdata/' + code + '.js', { headers: FUND_HEADERS });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();

  const nameM = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  const nwM = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);

  let rows = [];
  if (nwM) {
    try {
      const arr = JSON.parse(nwM[1]);
      rows = arr.map(function (r) { return [r.x, num(r.y)]; }).filter(function (r) { return isFinite(r[1]); });
    } catch (e) {}
  }

  const out = {
    at: Date.now(),
    name: nameM ? nameM[1] : code,
    rows: rows,
    last: rows.length ? rows[rows.length - 1][1] : NaN,
    prev: rows.length > 1 ? rows[rows.length - 2][1] : NaN
  };
  navCache[code] = out;
  return out;
}

// 日频净值序列 → 目标周期
function fundSeriesForPeriod(rows, period) {
  if (!rows.length) return [];
  if (period === 'minute') return rows.slice(-60).map(function (r) { return r[1]; });
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

function buildFundItem(code, est, nav) {
  const out = {
    code: code,
    name: (est && est.name) || (nav && nav.name) || code,
    price: NaN, prevClose: NaN, pct: NaN, change: NaN,
    points: [], fund: true, ok: false
  };

  if (est) {
    out.price = est.price;
    out.prevClose = est.prevClose;
    out.pct = est.pct;
    out.estTime = est.time;
  }
  if (nav) {
    if (nav.name && !est) out.name = nav.name;
    out.points = fundSeriesForPeriod(nav.rows, config.period || 'minute');
    if (!isFinite(out.prevClose)) out.prevClose = nav.prev;
    if (!isFinite(out.price)) out.price = nav.last;
  }

  if (!isFinite(out.pct) && isFinite(out.price) && isFinite(out.prevClose) && out.prevClose) {
    out.pct = ((out.price - out.prevClose) / out.prevClose) * 100;
  }
  if (isFinite(out.price) && isFinite(out.prevClose)) out.change = out.price - out.prevClose;
  // 和行情类一致：日/月/年线按折线区间算涨跌
  if (nav && config.period !== 'minute') {
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

// 折线所展示这段区间的涨跌幅（首点 → 末点）。
// 分时不用它：分时按昨收算「今日涨跌」才符合习惯。
function rangeChange(points) {
  if (!points || points.length < 2) return NaN;
  const first = points[0];
  const last = points[points.length - 1];
  if (!isFinite(first) || !isFinite(last) || !first) return NaN;
  return ((last - first) / first) * 100;
}

function buildItem(code, snap, points) {
  // 场内 ETF/LOF 价格精度 3-4 位小数，和场外基金一样显示 4 位
  const isEtf = /^sh5\d{5}$/i.test(code) || /^sz1[56]\d{4}$/i.test(code);
  const out = {
    code: code, name: (snap && snap.name) || NAMES[code] || code,
    price: NaN, prevClose: NaN, pct: NaN, change: NaN,
    points: points || [], ok: false, fund: isEtf
  };  if (snap) {
    out.price = snap.price;
    out.prevClose = snap.prevClose;
    out.pct = snap.pct;
    out.change = snap.change;
  }
  if (!isFinite(out.price) && out.points.length) out.price = out.points[out.points.length - 1];
  if ((!isFinite(out.prevClose) || out.prevClose === 0) && out.points.length > 1) out.prevClose = out.points[out.points.length - 2];
  if (!isFinite(out.pct) && isFinite(out.price) && isFinite(out.prevClose) && out.prevClose) {
    out.pct = ((out.price - out.prevClose) / out.prevClose) * 100;
  }
  if (!isFinite(out.change) && isFinite(out.price) && isFinite(out.prevClose)) {
    out.change = out.price - out.prevClose;
  }
  // 切到日/月/年线时，涨跌幅跟着换成"这条折线覆盖的区间"的涨跌，
  // 否则折线变了、数字还停在今天的涨跌幅，看着就像没跟着周期走。
  if (config.period !== 'minute') {
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

async function fetchAll() {
  const all = config.symbols.slice();
  const period = config.period || 'minute';
  const fundCodes = all.filter(isFundCode);
  const quoteCodes = all.filter(function (c) { return !isFundCode(c); });

  // 行情类：实时快照（一次请求拿全部）
  let snap = {};
  if (quoteCodes.length) {
    try {
      snap = await fetchSnapshots(quoteCodes);
    } catch (e) {
      snap = {};
    }
  }

  // 场外基金：盘中估值（批量）
  let funds = {};
  if (fundCodes.length) {
    try {
      funds = await fetchFundEstimates(fundCodes);
    } catch (e) {
      funds = {};
    }
  }

  // 行情类折线：分时 20s、K 线 60s 缓存
  const now = Date.now();
  const ttl = period === 'minute' ? MINUTE_TTL : KLINE_TTL;
  if (now - seriesCache.at > ttl || seriesCache.period !== period) {
    const map = {};
    await runPool(quoteCodes, 4, async function (code) {
      let pts = [];
      try {
        if (period === 'minute') {
          pts = await fetchMinuteSeries(code);
          // 美股指数等没有分时接口，退回日线，保证折线不空
          if (pts.length < 2) pts = await fetchSeries(code, 'day');
        } else {
          pts = await fetchSeries(code, period);
        }
      } catch (e) {
        const old = seriesCache.period === period ? seriesCache.map[code] : null;
        pts = old || [];
        // 同一个标的不要每次轮询都刷日志，只记第一次
        if (!pts.length && !seriesFailLogged[code]) {
          seriesFailLogged[code] = true;
          logLine('[quote]', code + ' 折线取数失败：' + e.message);
        }
      }
      map[code] = pts;
      if (pts.length) seriesFailLogged[code] = false;
    });
    seriesCache = { at: now, map: map, period: period };
  }

  // 基金净值：pingzhongdata 自带 30 分钟缓存
  const fundNav = {};
  if (fundCodes.length) {
    await runPool(fundCodes, 3, async function (code) {
      try {
        fundNav[code] = await fetchFundNav(code);
      } catch (e) {
        fundNav[code] = null;
      }
    });
  }

  return all.map(function (code) {
    if (isFundCode(code)) return buildFundItem(code, funds[code], fundNav[code]);
    return buildItem(code, snap[code], seriesCache.map[code] || []);
  });
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const opts = {
    width: config.width || 320,
    height: config.height > 0 ? config.height : 200,
    frame: false,
    transparent: true,
    // alpha 给到 1（而不是 0）：Windows 对全透明像素会跳过命中测试，导致右键/拖动漏到桌面
    backgroundColor: '#01000000',
    hasShadow: false,
    resizable: true,
    minWidth: 220,
    maxWidth: 640,
    minHeight: 56,
    maxHeight: 900,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: '盯盘',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  };

  if (config.pos && isFinite(config.pos.x) && isFinite(config.pos.y)) {
    opts.x = config.pos.x;
    opts.y = config.pos.y;
  }

  win = new BrowserWindow(opts);
  win.setAlwaysOnTop(!!config.alwaysOnTop);
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  logLine('[window]', 'BrowserWindow 已创建 pos=' + JSON.stringify(config.pos));

  win.once('ready-to-show', function () {
    logLine('[window]', 'ready-to-show');
    win.show();
  });

  win.webContents.once('did-finish-load', function () {
    logLine('[window]', '页面加载完成');
  });
  win.webContents.on('render-process-gone', function (e, d) {
    logLine('[renderer-gone]', JSON.stringify(d));
  });
  win.webContents.on('unresponsive', function () {
    logLine('[renderer]', '界面无响应');
  });

  // 调试：TICKER_SHOT=main|settings|alert
  if (process.env.TICKER_SHOT) {
    win.webContents.once('did-finish-load', function () {
      const which = process.env.TICKER_SHOT;

      if (which === 'alert') {
        setTimeout(function () {
          fireAlert(false).then(function () {
            setTimeout(function () { app.quit(); }, 2000);
          });
        }, 2000);
        return;
      }

      // 调试：TICKER_SHOT_KEY=2 模拟 Ctrl+数字，验证快捷键链路
      if (process.env.TICKER_SHOT_KEY) {
        setTimeout(function () {
          if (!win || win.isDestroyed()) return;
          win.webContents.executeJavaScript(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:" +
            JSON.stringify(process.env.TICKER_SHOT_KEY) +
            ",ctrlKey:true,bubbles:true}));"
          ).catch(function () {});
        }, 3000);
      }

      if (which === 'settings') {
        openSettings();
        // 调试：TICKER_SHOT_QUERY=茅台 会把关键词打进搜索框，方便截候选列表
        if (process.env.TICKER_SHOT_QUERY) {
          setTimeout(function () {
            if (!settingsWin || settingsWin.isDestroyed()) return;
            settingsWin.webContents.executeJavaScript(
              "var el=document.getElementById('code-input');el.value=" +
              JSON.stringify(process.env.TICKER_SHOT_QUERY) +
              ";el.focus();el.dispatchEvent(new Event('input'));"
            ).catch(function () {});
          }, 4000);
        }
        // 调试：TICKER_SHOT_PICK=1 自动点候选第一条，验证「选中 -> 入列表」整条链路
        if (process.env.TICKER_SHOT_PICK) {
          setTimeout(function () {
            if (!settingsWin || settingsWin.isDestroyed()) return;
            settingsWin.webContents.executeJavaScript(
              "var li=document.querySelector('#suggest li');" +
              "if(li)li.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));"
            ).catch(function () {});
          }, 5600);
        }
      }
      if (which === 'focus') {
        setFocus(true);
        // 调试：TICKER_SHOT_FOCUS_TAB=day/five/minute 指定周期；TICKER_SHOT_FOCUS_STEP=1 切换下一个自选
        if (process.env.TICKER_SHOT_FOCUS_TAB) {
          setTimeout(function () { focusSetTab(process.env.TICKER_SHOT_FOCUS_TAB); }, 1600);
        }
        if (process.env.TICKER_SHOT_FOCUS_STEP) {
          setTimeout(function () {
            focusStep(Number(process.env.TICKER_SHOT_FOCUS_STEP) || 1);
          }, 2400);
        }
        // 调试：TICKER_SHOT_FOCUS_CLOSE=1 展开后收起，验证窗口能还原
        if (process.env.TICKER_SHOT_FOCUS_CLOSE) {
          setTimeout(function () { setFocus(false); }, 3800);
        }
      }

      setTimeout(async function () {
        const target = (which === 'settings' && settingsWin) ? settingsWin : win;
        if (!target || target.isDestroyed()) return;
        // 调试：TICKER_SHOT_LAYOUT=1 时把各区块实际尺寸打进日志，排查布局问题
        if (process.env.TICKER_SHOT_LAYOUT) {
          try {
            const txt = await target.webContents.executeJavaScript(
              "(function(){var r=function(id){var e=document.getElementById(id);if(!e)return null;" +
              "var b=e.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)];};" +
              "var row=document.querySelector('.row');var rb=row?row.getBoundingClientRect():null;" +
              "return JSON.stringify({win:[innerWidth,innerHeight],left:r('left'),app:r('app'),focus:r('focus'),chart:r('chart')," +
              "row:rb?[Math.round(rb.width),Math.round(rb.height)]:null,lw:getComputedStyle(document.body).getPropertyValue('--left-w')," +
              "cls:document.body.className});})()"
            );
            logLine('[layout]', String(txt));
          } catch (e) {
            logLine('[layout]', 'fail ' + e.message);
          }
        }
        const img = await target.webContents.capturePage();
        const dir = path.join(ROOT, '.dev');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        const file = which === 'settings' ? 'settings.png' : which === 'focus' ? 'focus.png' : 'self.png';
        fs.writeFileSync(path.join(dir, file), img.toPNG());
        app.quit();
      }, which === 'settings' ? 7000 : which === 'focus' ? 6500 : 5000);
    });
  }

  win.on('moved', function () {
    if (!win) return;
    const pos = win.getPosition();
    config.pos = { x: pos[0], y: pos[1] };
    // 拖到别处后背景可能完全变了，松手就重采一次，不用干等下一个 4 秒周期
    if (probeMoveTimer) clearTimeout(probeMoveTimer);
    probeMoveTimer = setTimeout(function () { probeBackground(true); }, 260);
  });

  // 四边都能拖：宽 220-640、高 56-900，min/max 已在窗口选项里限死。
  // 手动调过高度后就以手动值为准，不再被内容自动撑开；
  // 如果拖回去正好等于内容高度，就自动恢复成"跟随内容"。
  let sizeSaveTimer = null;
  win.on('resize', function () {
    if (!win || win.isDestroyed()) return;
    resizingAt = Date.now();
    if (Date.now() < skipResizeUntil) return;   // 聚焦展开/收起是程序改的，别当成用户拖动
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(function () {
      if (!win || win.isDestroyed()) return;
      const size = win.getSize();
      const w = size[0];
      const h = size[1];
      if (focusOn) {
        // 聚焦时拖的是图表栏宽度：总宽减去左侧列表宽度，列表宽度不变
        focusChartW = Math.max(160, Math.min(1200, w - focusLeftW));
        config.focusChartWidth = focusChartW;
        saveConfig();
        broadcast();
        return;
      }
      config.width = Math.max(220, Math.min(640, w));
      config.height = Math.abs(h - autoFitHeight) > 4 ? h : 0;
      saveConfig();
      broadcast();
    }, 300);
  });

  win.on('closed', function () {
    win = null;
    focusOn = false;
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const winH = Math.max(520, Math.min(880, area.height - 70));

  settingsWin = new BrowserWindow({
    width: 640,
    height: winH,
    minWidth: 560,
    minHeight: 480,
    title: '盯盘设置',
    backgroundColor: '#14171d',
    autoHideMenuBar: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile(path.join(ROOT, 'settings', 'index.html'));
  // 设置面板关闭时，主窗口宽度回到 config.width：
  // 没点保存 → 滑块预览没写进 config，自然还原到原始宽度；
  // 点了保存 → config.width 已是新值，保持新宽度。
  settingsWin.on('closed', function () {
    settingsWin = null;
    if (win && !win.isDestroyed()) {
      const w = Math.max(220, Math.min(640, Math.round(config.width || 320)));
      win.setSize(w, win.getSize()[1]);
    }
  });
}

/* ---------------- 聚焦图表：单标的分时 / 5日 / 日K ---------------- */

const FOCUS_TABS = ['minute', 'five', 'day'];
const FOCUS_SESSION_A = 242;   // A 股一个交易日：09:30-11:30 + 13:00-15:00，含首尾共 242 个分钟点
const FOCUS_SESSION_HK = 332;  // 港股：09:30-12:00 + 13:00-16:00
const FOCUS_SESSION_US = 392;  // 美股：09:30-16:00（东部时间）
const FOCUS_TTL = { minute: 15000, five: 60000, day: 60000 };

// 聚焦不是另开窗口：直接把浮窗本身加宽加高，上面照旧是自选列表，下面挂图表。
let focusOn = false;
let focusCode = '';
let focusTab = 'minute';
let focusCache = {};
let focusHotkeyAcc = '';
let focusRestore = null;      // 展开前的窗口位置尺寸，收起时原样还原
let focusChartW = 620;        // 图表栏宽度，拖窗口时自动记住（config.focusChartWidth）
let focusLeftW = 320;         // 展开时左侧列表占的宽度 = 展开前的窗口宽度
let skipResizeUntil = 0;      // 程序化改尺寸期间，别当成用户拖动落盘

function sessionMinutes(code) {
  if (/^hk/i.test(code)) return FOCUS_SESSION_HK;
  if (/^us/i.test(code)) return FOCUS_SESSION_US;
  return FOCUS_SESSION_A;
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

async function buildFocusPayload(code, tab) {
  const snapP = fetchSnapshots([code]).catch(function () { return {}; });
  let name = NAMES[code] || code;
  let price = NaN, pct = NaN, prevClose = NaN, change = NaN;
  let days = [];
  let candles = [];
  let session = sessionMinutes(code);

  if (tab === 'day') {
    const rows = await fetchKlineRaw(code, 'day', 160);
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
    const j = await fetchTencentJson('/appstock/app/day/query?code=' + encodeURIComponent(code));
    const block = j && j.data && j.data[code];
    const arr = (block && block.data) || [];
    // 接口按「今天 → 前 4 天」倒序给，画图要正序
    const list = arr.slice().sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });
    days = list.map(function (d) {
      const pts = parseMinuteLines(d.data || []);
      return { date: String(d.date || ''), prec: num(d.prec), points: pts };
    }).filter(function (d) { return d.points.length > 1; });
    if (days.length) {
      const lastDay = days[days.length - 1];
      const lastPt = lastDay.points[lastDay.points.length - 1];
      price = lastPt.price;
      prevClose = lastDay.prec;
      if (!isFinite(prevClose) || !prevClose) prevClose = days[0].points[0].price;
      pct = ((price - prevClose) / prevClose) * 100;
      change = price - prevClose;
    }
  } else {
    const j = await fetchTencentJson('/appstock/app/minute/query?code=' + encodeURIComponent(code));
    const block = j && j.data && j.data[code];
    const lines = (block && block.data && block.data.data) || [];
    const qt = (block && block.qt && block.qt[code]) || [];
    const pts = parseMinuteLines(lines);
    if (pts.length > 1) {
      days = [{ date: String((block.data && block.data.date) || ''), prec: num(qt[4]), points: pts }];
      const lastPt = pts[pts.length - 1];
      price = lastPt.price;
      prevClose = num(qt[4]);
      pct = num(qt[32]);
      change = num(qt[31]);
      if (qt[1]) name = qt[1];
      if (!isFinite(prevClose) || !prevClose) prevClose = pts[0].price;
      if (!isFinite(pct)) pct = ((price - prevClose) / prevClose) * 100;
    }
  }

  const snap = await snapP;
  if (snap && snap[code]) {
    if (snap[code].name) name = snap[code].name;
    if (!isFinite(price) && isFinite(snap[code].price)) price = snap[code].price;
    if (!isFinite(prevClose) && isFinite(snap[code].prevClose)) prevClose = snap[code].prevClose;
    if (!isFinite(pct) && isFinite(snap[code].pct)) pct = snap[code].pct;
  }

  const hasData = tab === 'day' ? candles.length > 1 : days.length > 0;
  return {
    code: code, name: name, tab: tab, session: session,
    price: price, pct: pct, prevClose: prevClose, change: change,
    days: days, candles: candles, hasData: hasData, at: Date.now()
  };
}

async function focusPayload(code, tab) {
  const key = code + '|' + tab;
  const hit = focusCache[key];
  if (hit && Date.now() - hit.at < FOCUS_TTL[tab]) return hit.data;
  const data = await buildFocusPayload(code, tab);
  focusCache[key] = { at: Date.now(), data: data };
  return data;
}

// 聚焦时上下键翻的就是左列显示的那几行（config.symbols），
// 而不是背后更长的 watchlist —— 否则高亮行会跟着跑到看不见的地方
function focusList() {
  const shown = (config.symbols || []).filter(Boolean);
  if (shown.length) return shown.slice();
  const wl = (config.watchlist && config.watchlist.length) ? config.watchlist : [];
  return wl.slice();
}

function focusMeta() {
  const list = focusList();
  const hit = focusCache[focusCode + '|' + focusTab];
  return {
    on: focusOn,
    code: focusCode,
    tab: focusTab,
    tabs: FOCUS_TABS,
    list: list,
    index: list.indexOf(focusCode),
    total: list.length,
    name: (hit && hit.data && hit.data.name) || NAMES[focusCode] || focusCode,
    hotkey: focusHotkeyAcc,
    leftW: Math.round(focusLeftW),
    chartW: focusChartW
  };
}

function pushFocusState() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('focus-state', focusMeta()); } catch (e) {}
}

// 展开方式：不改高度，只把窗口往右边加宽（右边顶到屏幕边缘时改往左加宽），
// 左边这一块宽度保持原样，多出来的部分给图表。这样列表位置和字号完全不变。
const FOCUS_CHART_MIN = 320;
const FOCUS_CHART_MAX = 1100;
const FOCUS_CHART_DEFAULT = 620;

function focusTargetBounds() {
  const cur = win.getBounds();
  const area = screen.getDisplayMatching(cur).workArea;
  const leftW = Math.round(cur.width);
  let chartW = Math.round(config.focusChartWidth || FOCUS_CHART_DEFAULT);
  if (!isFinite(chartW)) chartW = FOCUS_CHART_DEFAULT;
  chartW = Math.max(FOCUS_CHART_MIN, Math.min(FOCUS_CHART_MAX, chartW));
  // 屏幕放不下就压缩图表栏，宁可窄一点也不能溢出可视区
  const room = area.width - leftW - 8;
  chartW = Math.max(160, Math.min(chartW, room));
  const width = leftW + chartW;
  const height = Math.min(cur.height, area.height);

  // 优先向右扩；右侧放不下就整体向左挪，右边缘保持不动
  let x = cur.x;
  if (x + width > area.x + area.width) x = cur.x - (width - cur.width);
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(cur.y, area.y + area.height - height));
  return { x: x, y: y, width: width, height: height, leftW: leftW, chartW: chartW };
}

function setFocus(on) {
  if (!win || win.isDestroyed()) return;
  on = !!on;
  if (on === focusOn) { if (on) pushFocusState(); return; }

  if (on) {
    const list = focusList();
    if (!focusCode || list.indexOf(focusCode) < 0) {
      const first = (config.symbols || []).filter(function (c) { return list.indexOf(c) >= 0; })[0];
      focusCode = first || list[0] || 'sh000001';
    }
    const b = focusTargetBounds();
    focusRestore = win.getBounds();
    focusLeftW = b.leftW;
    focusChartW = b.chartW;
    focusOn = true;
    // maxWidth 平时卡在 640，展开前先放开，否则 setBounds 会被裁回 640
    try { win.setMaximumSize(1600, 900); } catch (e) {}
    skipResizeUntil = Date.now() + 900;
    resizingAt = Date.now();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.focus();
    logLine('[focus]', '展开图表 ' + focusCode + ' tab=' + focusTab + ' 宽度 ' + b.leftW + '+' + b.chartW);
  } else {
    focusOn = false;
    const r = focusRestore;
    focusRestore = null;
    try { win.setMaximumSize(640, 900); } catch (e) {}
    if (r) {
      skipResizeUntil = Date.now() + 900;
      resizingAt = Date.now();
      win.setBounds(r);
    }
    logLine('[focus]', '收起图表');
  }
  pushFocusState();
}

function focusStep(dir) {
  if (!focusOn) return;
  const list = focusList();
  if (!list.length) return;
  let i = list.indexOf(focusCode);
  if (i < 0) i = 0;
  i = (i + (dir > 0 ? 1 : -1) + list.length) % list.length;
  focusCode = list[i];
  logLine('[focus]', '切换标的自选 ' + focusCode);
  pushFocusState();
}

function focusSetTab(tab) {
  if (FOCUS_TABS.indexOf(tab) < 0 || tab === focusTab) return;
  focusTab = tab;
  pushFocusState();
}

// Ctrl+Alt+F 全局唤起；再按一次收起
function toggleFocus() { setFocus(!focusOn); }

function registerFocusHotkey() {
  const acc = config.focusHotkey || 'CommandOrControl+Alt+F';
  try { if (focusHotkeyAcc) globalShortcut.unregister(focusHotkeyAcc); } catch (e) {}
  let ok = false;
  try { ok = globalShortcut.register(acc, function () { logLine('[hotkey]', '触发 ' + acc); toggleFocus(); }); } catch (e) {}
  focusHotkeyAcc = acc;
  logLine('[hotkey]', '聚焦图表 ' + acc + (ok ? ' 注册成功' : ' 注册失败（可能被其它程序占用）'));
}

/* ---------------- 背景明暗自动检测 ---------------- */
// 直接截屏采样"窗口背后"那块区域 —— 桌面壁纸、浏览器、编辑器、视频画面都算在内，
// 取亮度中位数决定文字该配亮色还是暗色。窗口自己的文字和折线在采样区里占比很小，
// 中位数天然会把它们忽略掉，所以不需要隐藏窗口，也就不会闪烁。

const LUMA_TO_DARK = 0.62;   // 背景亮到这个程度 → 换暗色文字
const LUMA_TO_LIGHT = 0.42;  // 背景暗到这个程度 → 换亮色文字
const PROBE_INTERVAL_DEFAULT = 4000;  // 默认轮询间隔（4 秒），可在设置里调
const SCREEN_RETRY_EVERY = 8;  // 截屏失败后隔这么多个周期重试一次（约 30 秒）

let autoTextMode = 'light';
let autoSettled = false;   // 是否已完成首次判定（首次直接用 0.5 分界，之后才走迟滞）
let probeTimer = null;
let probeBusy = false;
let probeFails = 0;
let probeTick = 0;
let probeMoveTimer = null;

function effectiveTextMode() {
  if (config.textMode !== 'auto') return config.textMode === 'dark' ? 'dark' : 'light';
  return autoTextMode;
}

function statePayload() {
  return Object.assign({}, config, { effectiveTextMode: effectiveTextMode() });
}

// toBitmap 的通道顺序随平台而异，取三通道均值判断明暗不受影响
function medianLuma(img) {
  if (!img || img.isEmpty()) return null;
  const buf = img.toBitmap();
  if (!buf || buf.length < 4) return null;
  const vals = [];
  for (let i = 0; i + 3 < buf.length; i += 4) {
    vals.push((buf[i] + buf[i + 1] + buf[i + 2]) / 765);
  }
  if (!vals.length) return null;
  vals.sort(function (a, b) { return a - b; });
  return vals[vals.length >> 1];
}

// 锁屏 / 远程桌面 / 部分显卡驱动下，desktopCapturer 会"成功"返回一张纯黑图，
// 既不报错也没缩略图缺失。这时亮度恒为 0，文字会永远停在亮色，
// 用户看到的就是"不再跟着背景切换了"。这里识别出来当作失败处理。
// 注意：真正的暗背景（深色编辑器、黑壁纸）虽然平均亮度也很低，但有文字/图标/
// 渐变细节，不是全黑；只有像素几乎全 0 的图才是截屏失败。
function isBlankShot(img) {
  if (!img || img.isEmpty()) return true;
  const buf = img.toBitmap();
  if (!buf || buf.length < 4) return true;
  let n = 0, lit = 0;
  for (let i = 0; i + 3 < buf.length; i += 4) {
    // 单通道超过 12（约 0.05）就算"有内容"，真正的黑屏失败图全是 0
    if (buf[i] > 12 || buf[i + 1] > 12 || buf[i + 2] > 12) lit++;
    n++;
  }
  // 少于 1% 的像素有内容，认为是黑屏失败
  return n === 0 || (lit / n) < 0.01;
}

// 截当前屏幕，裁出窗口所在的矩形
// 抓取时按 1/4 分辨率取样：全尺寸每帧要 400ms 上下，1/4 只要 10ms 左右，
// 而判断明暗只需要几千个像素的中位数，缩了完全不影响结果。
async function grabWindowRegion() {
  const bounds = win.getBounds();
  const disp = screen.getDisplayMatching(bounds);
  const sf = disp.scaleFactor || 1;
  const physW = Math.round(disp.size.width * sf);
  const physH = Math.round(disp.size.height * sf);
  const thumbW = Math.max(320, Math.round(physW / 4));
  const thumbH = Math.max(180, Math.round(physH / 4));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
    fetchWindowIcons: false
  });
  if (!sources || !sources.length) return null;

  let src = null;
  for (let i = 0; i < sources.length; i++) {
    if (String(sources[i].display_id) === String(disp.id)) { src = sources[i]; break; }
  }
  if (!src) src = sources[0];
  if (!src.thumbnail || src.thumbnail.isEmpty()) return null;

  const img = src.thumbnail;
  const sz = img.getSize();
  const kx = sz.width / physW;
  const ky = sz.height / physH;

  const x = Math.round((bounds.x - disp.bounds.x) * sf * kx);
  const y = Math.round((bounds.y - disp.bounds.y) * sf * ky);
  const w = Math.round(bounds.width * sf * kx);
  const h = Math.round(bounds.height * sf * ky);

  const cx = Math.max(0, Math.min(sz.width - 1, x));
  const cy = Math.max(0, Math.min(sz.height - 1, y));
  const cw = Math.max(1, Math.min(sz.width - cx, w));
  const ch = Math.max(1, Math.min(sz.height - cy, h));

  const cropped = img.crop({ x: cx, y: cy, width: cw, height: ch })
    .resize({ width: 30, height: 16, quality: 'good' });
  if (isBlankShot(cropped)) return null;
  return cropped;
}

// 截屏不可用时（受限环境）退回读系统壁纸缓存
function grabWallpaperRegion() {
  try {
    const p = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const img = nativeImage.createFromPath(p);
    if (!img || img.isEmpty()) return null;

    const bounds = win.getBounds();
    const disp = screen.getDisplayMatching(bounds);
    const sf = disp.scaleFactor || 1;
    const sw = disp.size.width * sf;
    const sh = disp.size.height * sf;
    const sz = img.getSize();

    // 近似 Windows「填充」：放大到覆盖屏幕后居中裁切，再取窗口对应区域
    const s = Math.max(sw / sz.width, sh / sz.height);
    const offX = (sw - sz.width * s) / 2;
    const offY = (sh - sz.height * s) / 2;

    const x = Math.round(((bounds.x - disp.bounds.x) * sf - offX) / s);
    const y = Math.round(((bounds.y - disp.bounds.y) * sf - offY) / s);
    const w = Math.max(1, Math.round(bounds.width * sf / s));
    const h = Math.max(1, Math.round(bounds.height * sf / s));

    const cx = Math.max(0, Math.min(sz.width - 1, x));
    const cy = Math.max(0, Math.min(sz.height - 1, y));
    const cw = Math.max(1, Math.min(sz.width - cx, w));
    const ch = Math.max(1, Math.min(sz.height - cy, h));

    const cropped = img.crop({ x: cx, y: cy, width: cw, height: ch })
      .resize({ width: 30, height: 16, quality: 'good' });
    if (isBlankShot(cropped)) return null;
    return cropped;
  } catch (e) {
    return null;
  }
}

function applyLuma(luma, useWallpaper) {
  let next;
  if (!autoSettled) {
    // 首次判定没有历史状态可参考，直接按中点分界，避免灰底两边都不上不下
    next = luma >= 0.5 ? 'dark' : 'light';
    autoSettled = true;
  } else {
    // 之后用迟滞区间，防止背景在临界值附近晃动导致文字反复跳色
    next = autoTextMode;
    if (luma >= LUMA_TO_DARK) next = 'dark';
    else if (luma <= LUMA_TO_LIGHT) next = 'light';
  }
  if (next === autoTextMode) return;
  autoTextMode = next;
  logLine('[bg]', '文字切换为' + (next === 'dark' ? '暗色' : '亮色') +
    '（背景亮度 ' + luma.toFixed(2) + (useWallpaper ? '，采样来源=壁纸兜底' : '') + '）');
  if (config.textMode === 'auto') broadcast();
}

async function probeBackground(force) {
  if (probeBusy || !win || win.isDestroyed()) return;
  // 拖动期间跳过采样：desktopCapturer 会抢渲染线程导致 setPosition 卡顿
  if (dragBase) return;
  // 手动指定了配色就不用白费力气截屏
  if (!force && config.textMode !== 'auto') return;

  probeBusy = true;
  probeTick++;
  let useWallpaper = false;
  try {
    let small = null;
    // 连续失败 3 次先退回壁纸兜底，但每 SCREEN_RETRY_EVERY 个周期重试一次截屏。
    // 否则启动瞬间若是锁屏 / 远程桌面 / 截屏受限，一次失败就会钉死成壁纸模式，
    // 之后窗口挪到任何界面上文字都不再跟背景变——用户看到的就是"不自动切换了"。
    const tryScreen = probeFails < 3 || probeTick % SCREEN_RETRY_EVERY === 0;
    if (tryScreen) {
      try { small = await grabWindowRegion(); } catch (e) { small = null; }
      if (small) {
        if (probeFails >= 3) {
          logLine('[bg]', '实时截屏已恢复（之前是壁纸兜底，共失败 ' + probeFails + ' 次）');
        }
        probeFails = 0;
      } else {
        probeFails++;
      }
    }
    if (!small) {
      small = grabWallpaperRegion();
      useWallpaper = true;
    }
    let luma = medianLuma(small);
    // 开了衬底时，截图像素混了半透明底色，反推底下真实亮度，避免自反馈切不过去。
    // 深色衬底 ≈ luma 0.04；浅色衬底 = luma 1.0；不透明度由用户设置控制（默认 0.4）
    if (luma != null && config.backdrop && !useWallpaper) {
      const alpha = Math.max(0, Math.min(0.95, (config.backdropOpacity || 40) / 100));
      if (alpha > 0.02) {
        if (autoTextMode === 'light') {
          luma = (luma - alpha * 0.04) / (1 - alpha);
        } else {
          luma = (luma - alpha * 1.0) / (1 - alpha);
        }
      }
    }
    if (luma != null) applyLuma(luma, useWallpaper);
    if (process.env.TICKER_DEBUG_BG) {
      console.log('[bg] luma=' + (luma == null ? 'null' : luma.toFixed(3)) + ' mode=' + autoTextMode + ' fails=' + probeFails);
    }
  } catch (e) {
    // 探测失败保持当前配色，不影响主流程
  } finally {
    probeBusy = false;
  }
}

function startBackgroundProbe() {
  if (probeTimer) clearInterval(probeTimer);
  const ms = Math.max(1000, Math.min(15000, config.probeIntervalMs || PROBE_INTERVAL_DEFAULT));
  probeTimer = setInterval(function () { probeBackground(false); }, ms);
  setTimeout(function () { probeBackground(false); }, 1500);
}

function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  if (dragProbeTimer) { clearInterval(dragProbeTimer); dragProbeTimer = null; }
  dragBase = null;
}

function broadcast() {
  if (win) win.webContents.send('state-changed', statePayload());
}

function setAndBroadcast(patch, clearCache) {
  Object.assign(config, patch);
  if (patch.alwaysOnTop !== undefined && win) win.setAlwaysOnTop(!!patch.alwaysOnTop);
  if (patch.width !== undefined && win && isFinite(patch.width)) {
    const w = Math.max(220, Math.min(640, Math.round(patch.width)));
    const h = win.getSize()[1];
    win.setSize(w, h);
  }
  if (clearCache) seriesCache = { at: 0, map: {}, period: null };
  // 刚从手动切回自动时立刻测一次，不用等下一个轮询周期
  if (patch.textMode === 'auto') probeFails = 0;
  saveConfig();
  broadcast();
  if (patch.textMode === 'auto') probeBackground(true);
}

function setPeriod(p) {
  if (PERIODS.indexOf(p) < 0 || config.period === p) return;
  setAndBroadcast({ period: p }, true);
}

function toggleSymbol(code, on) {
  const list = config.symbols.slice();
  const i = list.indexOf(code);
  const changed = (on && i < 0) || (!on && i >= 0);
  if (!changed) return;
  if (on) list.push(code); else list.splice(i, 1);
  if (list.length === 0) return; // 至少留一个标的
  setAndBroadcast({ symbols: list }, true);
}


ipcMain.handle('get-state', function () {
  return {
    textMode: config.textMode,
    effectiveTextMode: effectiveTextMode(),
    backdrop: !!config.backdrop,
    showName: config.showName !== false,
    baseline: config.baseline !== false,
    period: config.period,
    interval: config.interval,
    symbols: config.symbols,
    locked: !!config.locked,
    alwaysOnTop: !!config.alwaysOnTop
  };
});

ipcMain.handle('get-quotes', async function () {
  try {
    const list = await fetchAll();
    const ok = list.some(function (x) { return x.ok; });
    return { ok: ok, list: list, period: config.period, at: Date.now() };
  } catch (e) {
    return { ok: false, error: e.message, list: [], period: config.period, at: Date.now() };
  }
});

ipcMain.on('set-height', function (e, h) {
  if (!win || !isFinite(h)) return;
  const height = Math.max(24, Math.round(h));
  autoFitHeight = height;
  // 用户手动拖过高度，或者正在拖，都别按内容改回去
  if (config.height > 0 || Date.now() - resizingAt < 600) return;
  // 聚焦展开时窗口高度 = 列表 + 图表，列表本身的高度只记在 autoFitHeight 里
  if (focusOn) return;
  if (win.getSize()[1] === height) return;
  const pos = win.getPosition();
  win.setBounds({ x: pos[0], y: pos[1], width: config.width || 320, height: height });
});

// 设置面板滑块实时预览宽度：只调窗口尺寸，不落盘；取消/关闭时由设置面板发回原始宽度还原
ipcMain.on('preview-width', function (e, w) {
  if (!win) return;
  const n = parseInt(w, 10);
  if (!isFinite(n)) return;
  const width = Math.max(220, Math.min(640, Math.round(n)));
  if (win.getSize()[0] === width) return;
  win.setSize(width, win.getSize()[1]);
});

ipcMain.on('drag-start', function () {
  if (!win || config.locked) return;
  const pos = win.getPosition();
  const cur = screen.getCursorScreenPoint();
  dragBase = { dx: cur.x - pos[0], dy: cur.y - pos[1] };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(function () {
    if (!win || !dragBase) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragBase.dx, p.y - dragBase.dy);
  }, 16);
  // 拖动期间不暂停轮询，但 probeBackground 会跳过采样，松手后下一周期自然恢复
});

ipcMain.on('drag-end', function () {
  stopDrag();
  saveConfig();
  // 拖动后落点换了，背后可能是完全不同的画面，稍等一下再测
  setTimeout(function () { probeBackground(true); }, 400);
});

// 图钉固定：开启后窗口不可拖动/拉伸，且鼠标穿透到下层应用
let pinned = false;
ipcMain.on('set-pinned', function (e, on) {
  if (!win || win.isDestroyed()) return;
  pinned = !!on;
  win.setMovable(!pinned);
  win.setResizable(!pinned);
  win.setIgnoreMouseEvents(pinned, { forward: true });
});

// 鼠标移到右上角图钉按钮区域时临时恢复点击，移出后恢复穿透
ipcMain.on('set-pin-zone', function (e, on) {
  if (!win || win.isDestroyed()) return;
  if (!pinned) return;
  win.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on('save-config', function (e, patch) {
  if (!patch || typeof patch !== 'object') return;
  setAndBroadcast(patch, false);
});

/* ---------------- 尾盘提醒 ---------------- */

let alertTimer = null;
let firedKey = '';

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// 判断今天是不是交易日：看上证指数快照里的时间戳是不是今天
async function isTradingToday() {
  try {
    const snap = await fetchSnapshots(['sh000001']);
    const s = snap['sh000001'];
    if (!s || !s.time) return false;
    const d = new Date();
    const today = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    return String(s.time).slice(0, 8) === today;
  } catch (e) {
    return false;
  }
}

async function checkAlert() {
  const a = config.alert || {};
  if (!a.enabled) return;

  const d = new Date();
  if (pad2(d.getHours()) + ':' + pad2(d.getMinutes()) !== a.time) return;

  const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + a.time;
  if (firedKey === key) return;
  firedKey = key;

  if (!(await isTradingToday())) return;
  await fireAlert(true);
}

async function fireAlert(countdown) {
  let list = [];
  try { list = await fetchAll(); } catch (e) {}
  const rows = list.filter(function (x) { return x.ok; });

  let title;
  if (countdown) {
    const d = new Date();
    const mins = Math.max(0, Math.round(15 * 60 - (d.getHours() * 60 + d.getMinutes())));
    title = '尾盘提醒 · 距 15:00 申赎截止还有 ' + mins + ' 分钟';
  } else {
    title = '盯盘提醒（测试）';
  }

  const body = rows.slice(0, 6).map(function (x) {
    const pct = isFinite(x.pct) ? (x.pct > 0 ? '+' : '') + x.pct.toFixed(2) + '%' : '--';
    return x.name + '  ' + pct;
  }).join('\n') || '（暂无数据）';

  try {
    const n = new Notification({ title: title, body: body });
    n.on('click', function () {
      if (win) { win.show(); win.focus(); }
    });
    n.show();
  } catch (e) {
    console.error('[alert] 通知失败:', e.message);
  }

  try { shell.beep(); } catch (e) {}

  if (win) {
    try {
      win.flashFrame(true);
      setTimeout(function () {
        try { if (win) win.flashFrame(false); } catch (e) {}
      }, 60000);
    } catch (e) {}
  }
}

function startAlertTimer() {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = setInterval(function () { checkAlert(); }, 20000);
}

/* ---------------- 交易时段：收盘自动退出 / 开盘自启 ---------------- */

const TASK_NAME = 'MiniTicker_AutoOpen';
// 计划任务启动时会带上 --scheduled，用来区分「定时拉起」和「用户手动打开」
const SCHEDULED_LAUNCH = process.argv.indexOf('--scheduled') >= 0 || process.env.TICKER_SCHEDULED === '1';

let autoExitTimer = null;
let closingForDay = false;
// 启动时已经过了收盘时间（比如晚上手动打开看收盘数据）→ 本次会话不自动退出
let sessionAfterClose = false;
let sessionDay = '';

function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function startAutoExitTimer() {
  if (autoExitTimer) clearInterval(autoExitTimer);
  sessionDay = todayKey();
  const exitAt = minutesOf(config.autoExit.time);
  sessionAfterClose = !!(exitAt != null && nowMinutes() >= exitAt);

  autoExitTimer = setInterval(function () {
    if (closingForDay) return;
    if (!config.autoExit || !config.autoExit.enabled) return;

    // 周末不收市，手动开着的窗口不主动踢掉
    const wd = new Date().getDay();
    if (wd === 0 || wd === 6) return;

    // 跨天重置：晚上打开的会话不该拖到第二天还不退
    const day = todayKey();
    if (day !== sessionDay) {
      sessionDay = day;
      sessionAfterClose = false;
    }
    if (sessionAfterClose) return;

    const at = minutesOf(config.autoExit.time);
    if (at == null || nowMinutes() < at) return;

    closingForDay = true;
    console.log('[auto-exit] 已到 ' + config.autoExit.time + '，收盘退出');
    saveConfig();
    app.quit();
  }, 30000);
}

/* ---- 开盘自启：Windows 计划任务 ---- */

const AUTOSTART_PS = path.join(ROOT, 'scripts', 'autostart.ps1');

function startCmdPath() {
  return path.join(ROOT, 'start-auto.cmd');
}

// 用 PowerShell 的 ScheduledTasks 模块而不是 schtasks.exe：
// 前者不改注册表、不受部分安全软件对 schtasks 的拦截影响。
function runAutostartPs(args, cb) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTOSTART_PS].concat(args),
    { windowsHide: true, timeout: 25000 },
    function (err, stdout, stderr) {
      const out = String(stdout || '').trim();
      const msg = String(stderr || '').trim();
      cb(err, out || msg);
    }
  );
}

function autoStartInstalled(cb) {
  runAutostartPs(['-Mode', 'query', '-TaskName', TASK_NAME], function (err, out) {
    cb(!err && /INSTALLED/.test(out));
  });
}

// 计划任务状态缓存：设置面板每次打开都去问一次太慢，启动/保存时刷新即可
let taskInstalledCache = false;

function refreshTaskInstalledCache() {
  autoStartInstalled(function (ok) {
    taskInstalledCache = ok;
    broadcast();
  });
}

// 安装/更新计划任务：工作日定点拉起 start-auto.cmd
function installAutoStart(time, cb) {
  const at = /^\d{2}:\d{2}$/.test(time) ? time : '09:25';
  runAutostartPs([
    '-Mode', 'install', '-TaskName', TASK_NAME,
    '-StartTime', at, '-ScriptPath', startCmdPath()
  ], function (err, out) {
    const ok = !err && /\bOK\b/.test(out);
    if (!ok) console.error('[autostart] 创建计划任务失败:', out);
    else console.log('[autostart] 计划任务已创建：工作日 ' + at + ' 启动');
    cb(ok, ok ? '' : out);
  });
}

function removeAutoStart(cb) {
  runAutostartPs(['-Mode', 'remove', '-TaskName', TASK_NAME], function () { cb(true); });
}

// 计划任务拉起时，非交易日（法定假日/调休放假）自动关掉，避免空转
function startScheduledTradingCheck() {
  if (!SCHEDULED_LAUNCH) return;

  const MAX_TRIES = 4;
  const RETRY_GAP = 2 * 60 * 1000;
  let tries = 0;

  function check() {
    tries++;
    isTradingToday().then(function (ok) {
      if (ok) {
        console.log('[autostart] 今天是交易日，正常运行');
        return;
      }
      if (tries >= MAX_TRIES) {
        console.log('[autostart] 连续 ' + tries + ' 次判定非交易日，退出');
        app.quit();
        return;
      }
      setTimeout(check, RETRY_GAP);
    }).catch(function () {
      if (tries < MAX_TRIES) setTimeout(check, RETRY_GAP);
    });
  }

  // 先让窗口显示出来，再开始检测
  setTimeout(check, 40000);
}


/* ---------------- 设置面板 ---------------- */

function isValidCode(c) {
  if (typeof c !== 'string') return false;
  return /^(sh|sz|bj|hk|us|hf)[a-z0-9._]{1,12}$/i.test(c) || /^\d{6}$/.test(c);
}

ipcMain.handle('settings-get', async function () {
  const codes = [];
  (config.watchlist || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
  (config.symbols || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });

  const names = {};
  codes.forEach(function (c) { if (NAMES[c]) names[c] = NAMES[c]; });
  try {
    const snap = await fetchSnapshots(codes);
    Object.keys(snap).forEach(function (k) {
      if (snap[k] && snap[k].name) names[k] = snap[k].name;
    });
  } catch (e) {}

  // 打开面板时现场问一次计划任务状态：缓存可能还没查完，用户也可能在别处删过任务
  let installed = taskInstalledCache;
  try {
    installed = await new Promise(function (res) { autoStartInstalled(res); });
    taskInstalledCache = installed;
  } catch (e) {}

  return {
    symbols: config.symbols.slice(),
    watchlist: config.watchlist.slice(),
    names: names,
    period: config.period,
    interval: config.interval,
    textMode: config.textMode,
    backdrop: !!config.backdrop,
    showName: config.showName !== false,
    baseline: config.baseline !== false,
    alwaysOnTop: !!config.alwaysOnTop,
    locked: !!config.locked,
    width: config.width,
    alert: Object.assign({}, config.alert),
    autoExit: Object.assign({}, config.autoExit),
    autoStart: Object.assign({}, config.autoStart),
    taskInstalled: installed
  };
});

ipcMain.handle('validate-symbol', async function (e, raw) {
  const code = String(raw || '').trim();
  if (!isValidCode(code)) {
    return { ok: false, msg: '代码格式不对：行情类形如 sh600519 / hkHSI / usDJI，场外基金是 6 位数字如 001186' };
  }

  // 场外基金
  if (isFundCode(code)) {
    try {
      const est = await fetchFundEstimates([code]);
      if (est[code]) return { ok: true, code: code, name: est[code].name, fund: true };
      const nav = await fetchFundNav(code);
      if (nav && nav.name && nav.rows.length) return { ok: true, code: code, name: nav.name, fund: true };
      return { ok: false, msg: '没查到这只基金，检查下 6 位代码' };
    } catch (err) {
      return { ok: false, msg: '查询失败：' + err.message };
    }
  }

  try {
    const snap = await fetchSnapshots([code]);
    const keys = Object.keys(snap);
    if (!keys.length) return { ok: false, msg: '没查到这只标的，检查下代码' };
    const k = keys[0];
    return { ok: true, code: k, name: (snap[k] && snap[k].name) || k };
  } catch (err) {
    return { ok: false, msg: '查询失败：' + err.message };
  }
});

ipcMain.handle('search-symbol', async function (e, q) {
  try {
    return { ok: true, list: await searchSymbols(q) };
  } catch (err) {
    return { ok: false, msg: '搜索失败：' + err.message, list: [] };
  }
});

ipcMain.handle('settings-save', async function (e, patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, msg: '数据无效' };

  const symbols = (Array.isArray(patch.symbols) ? patch.symbols : []).filter(isValidCode);
  if (symbols.length === 0) return { ok: false, msg: '至少要勾选一个标的' };

  const watchlist = (Array.isArray(patch.watchlist) ? patch.watchlist : []).filter(isValidCode);
  symbols.forEach(function (c) { if (watchlist.indexOf(c) < 0) watchlist.push(c); });

  const period = PERIODS.indexOf(patch.period) >= 0 ? patch.period : config.period;

  let interval = parseInt(patch.interval, 10);
  if (!isFinite(interval)) interval = config.interval;
  interval = Math.max(1000, Math.min(60000, interval));

  let width = parseInt(patch.width, 10);
  if (!isFinite(width)) width = config.width;
  width = Math.max(220, Math.min(640, width));

  let backdropOpacity = parseInt(patch.backdropOpacity, 10);
  if (!isFinite(backdropOpacity)) backdropOpacity = config.backdropOpacity;
  backdropOpacity = Math.max(0, Math.min(95, backdropOpacity));

  let probeIntervalMs = parseInt(patch.probeIntervalMs, 10);
  if (!isFinite(probeIntervalMs)) probeIntervalMs = config.probeIntervalMs;
  probeIntervalMs = Math.max(1000, Math.min(15000, probeIntervalMs));

  const alertCfg = {
    enabled: !(patch.alert && patch.alert.enabled === false),
    time: (patch.alert && /^\d{2}:\d{2}$/.test(patch.alert.time)) ? patch.alert.time : config.alert.time
  };

  const autoExitCfg = {
    enabled: !!(patch.autoExit && patch.autoExit.enabled),
    time: (patch.autoExit && /^\d{2}:\d{2}$/.test(patch.autoExit.time)) ? patch.autoExit.time : config.autoExit.time
  };

  const autoStartCfg = {
    enabled: !!(patch.autoStart && patch.autoStart.enabled),
    time: (patch.autoStart && /^\d{2}:\d{2}$/.test(patch.autoStart.time)) ? patch.autoStart.time : config.autoStart.time
  };

  setAndBroadcast({
    symbols: symbols,
    watchlist: watchlist,
    period: period,
    interval: interval,
    textMode: 'auto',
    backdrop: !!patch.backdrop,
    backdropOpacity: backdropOpacity,
    probeIntervalMs: probeIntervalMs,
    showName: patch.showName !== false,
    baseline: patch.baseline !== false,
    alwaysOnTop: !!patch.alwaysOnTop,
    locked: !!patch.locked,
    width: width,
    alert: alertCfg,
    autoExit: autoExitCfg,
    autoStart: autoStartCfg
  }, true);

  // 轮询间隔改了，重启定时器让新值立即生效
  startBackgroundProbe();

  // 计划任务跟着保存动作同步：开了就装/更新，关了就把任务删掉
  let taskMsg = '';
  const taskOk = await new Promise(function (res) {
    if (autoStartCfg.enabled) installAutoStart(autoStartCfg.time, res);
    else removeAutoStart(function () { res(true); });
  });
  if (!taskOk) taskMsg = '，但写入开盘自启任务失败（可尝试用管理员身份运行一次）';
  taskInstalledCache = autoStartCfg.enabled && taskOk;

  // 收盘退出时间/开关改了，定时器要按新配置重算
  sessionDay = todayKey();
  const exitAt = minutesOf(autoExitCfg.time);
  sessionAfterClose = !!(autoExitCfg.enabled && exitAt != null && nowMinutes() >= exitAt);

  return { ok: true, msg: taskMsg };
});

ipcMain.on('open-settings', function () { openSettings(); });

/* ---------------- 聚焦图表 IPC ---------------- */

ipcMain.handle('focus-state', function () { return focusMeta(); });

ipcMain.handle('focus-data', async function () {
  try {
    const data = await focusPayload(focusCode, focusTab);
    return Object.assign({ ok: true }, data);
  } catch (e) {
    logLine('[focus]', '取数失败 ' + focusCode + ' (' + focusTab + ')：' + e.message);
    return { ok: false, error: e.message, code: focusCode, tab: focusTab, name: NAMES[focusCode] || focusCode };
  }
});

ipcMain.on('focus-open', function (e, code) {
  if (code && focusList().indexOf(code) >= 0) focusCode = code;
  setFocus(true);
});
ipcMain.on('focus-toggle', function () { toggleFocus(); });
ipcMain.on('focus-step', function (e, dir) { focusStep(dir); });
ipcMain.on('focus-tab', function (e, tab) { focusSetTab(tab); });
ipcMain.on('focus-close', function () { logLine('[focus]', 'IPC focus-close'); setFocus(false); });

ipcMain.on('set-period', function (e, p) {
  if (PERIODS.indexOf(p) >= 0) setPeriod(p);
});

ipcMain.on('settings-close', function () {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

ipcMain.on('open-menu', function () {
  if (!win) return;
  // 菜单只留盯盘当下要用的：其余开关都在设置面板里
  const menu = Menu.buildFromTemplate([
    { label: '设置…', accelerator: 'CmdOrCtrl+,', click: function () { openSettings(); } },
    {
      label: '聚焦图表',
      type: 'checkbox',
      checked: focusOn,
      sublabel: focusHotkeyAcc || 'Ctrl+Alt+F',
      click: function () { toggleFocus(); }
    },
    { type: 'separator' },
    {
      label: '周期',
      submenu: PERIODS.map(function (p, i) {
        return {
          label: PERIOD_LABEL[p],
          type: 'radio',
          checked: config.period === p,
          sublabel: 'Ctrl+' + (i + 1),
          click: function () { setPeriod(p); }
        };
      })
    },
    { label: '立即刷新', click: function () { win.webContents.send('force-refresh'); } },
    {
      label: '高度跟随内容',
      type: 'checkbox',
      checked: !(config.height > 0),
      click: function () {
        config.height = 0;
        resizingAt = 0;
        saveConfig();
        // 让渲染层重新量一次内容高度
        if (win && !win.isDestroyed()) win.webContents.send('refit-height');
      }
    },
    { type: 'separator' },
    { label: '重启', click: function () { app.relaunch(); app.exit(0); } },
    { label: '退出', click: function () { app.quit(); } }
  ]);
  menu.popup({ window: win });
});

ipcMain.on('test-alert', function () { fireAlert(false); });

/* ---------------- 闪退排查埋点 ---------------- */

logLine('[boot]', 'pid=' + process.pid + ' scheduled=' + SCHEDULED_LAUNCH +
  ' argv=' + JSON.stringify(process.argv.slice(1)));

process.on('uncaughtException', function (e) {
  logLine('[uncaught]', (e && e.stack) || String(e));
});
process.on('unhandledRejection', function (e) {
  logLine('[unhandled]', (e && e.stack) || String(e));
});

// 包一层 app.quit：谁让它退的、从哪一行调的，全留档
const rawQuit = app.quit.bind(app);
app.quit = function () {
  const st = String(new Error().stack || '').split('\n').slice(2, 5).map(function (s) {
    return s.trim();
  }).join(' <- ');
  logLine('[quit]', st);
  return rawQuit();
};

app.on('child-process-gone', function (e, d) { logLine('[child-gone]', JSON.stringify(d)); });
app.on('render-process-gone', function (e, wc, d) { logLine('[render-gone]', JSON.stringify(d)); });

// 每 5 分钟记一次内存：机器本来就吃紧，判断是不是被挤掉的关键
setInterval(function () {
  try {
    const m = process.memoryUsage();
    const per = {};
    app.getAppMetrics().forEach(function (x) {
      per[x.type] = (per[x.type] || 0) + Math.round(x.memory.workingSetSize / 1024);
    });
    logLine('[mem]', 'main-rss=' + Math.round(m.rss / 1048576) + 'MB ' + JSON.stringify(per));
  } catch (e) {}
}, 300000).unref();

// 单实例：重复启动（比如连点两次 start.cmd）只保留一个窗口，
// 否则多个进程会同时写 config.json，位置和设置互相覆盖。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logLine('[second]', '已有实例在运行，本次启动直接退出');
  app.quit();
} else {
  app.on('second-instance', function () {
    logLine('[second]', '检测到重复启动，激活已有窗口');
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // 闪一下任务栏：否则用户以为「点了没反应 / 闪退」
      try {
        win.flashFrame(true);
        setTimeout(function () {
          try { if (win && !win.isDestroyed()) win.flashFrame(false); } catch (e) {}
        }, 2000);
      } catch (e) {}
    }
  });

  app.whenReady().then(function () {
    logLine('[ready]', 'Electron ready');
    // 关机 / 休眠会让计划任务在错过 09:25 后被 Windows 补跑。
    // 如果补跑发生在收盘之后，开窗也没有行情可看，直接不打开。
    if (SCHEDULED_LAUNCH && nowMinutes() >= 15 * 60) {
      console.log('[autostart] 已过 15:00，跳过本次自动启动');
      app.quit();
      return;
    }

    app.setAppUserModelId('com.miniticker.watch');
    createWindow();
    registerFocusHotkey();
    startAlertTimer();
    startBackgroundProbe();
    startAutoExitTimer();
    startScheduledTradingCheck();
    refreshTaskInstalledCache();
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', function () {
  logLine('[window-all-closed]', '所有窗口已关闭，准备退出');
  stopDrag();
  app.quit();
});

app.on('before-quit', function () {
  logLine('[before-quit]', '准备退出');
  saveConfig();
});

app.on('will-quit', function () {
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

app.on('quit', function (e, code) {
  logLine('[quit-done]', 'exit code=' + code);
});
