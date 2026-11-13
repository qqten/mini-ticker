'use strict';

const { num } = require('../core/utils.cjs');
const { closeSeries, yearlySeries } = require('../core/quotes.cjs');
const {
  isFundCode,
  isValidCode,
  sinaSupported,
  sinaSymbol,
  unescapeUnicode
} = require('../core/symbols.cjs');
const { NAMES, EM_SECID, HF_EM_SECID, INDEX_EM_SECID, TYPE_LABEL } = require('../core/constants.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const HEADERS = { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' };
const SINA_HEADERS = { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' };
const FUND_HEADERS = { 'User-Agent': UA, 'Referer': 'https://fund.eastmoney.com/' };

// 腾讯行情有两个等价入口：主域名被 WAF 拦就换备用域名，数据格式完全一致
const QT_HOSTS = [
  'https://ifzq.gtimg.cn',
  'https://proxy.finance.qq.com/ifzqgtimg'
];

// 新浪 K 线周期：5/15/30/60=分钟，240=日 1200=周 7200=月
const SINA_SCALE = { m5: 5, m15: 15, m30: 30, m60: 60, day: 240, week: 1200, month: 7200 };

// 分钟级 K 线周期 → 腾讯 fqkline 的 key 后缀（m5 / m15 / m30 / m60）与东财 klt（5 / 15 / 30 / 60）。
// 腾讯把分钟 K 放在块内的 qfqm5 这种字段里，东财用 klt 区分，两边对不上时按这两张表转。
const MIN_INTERVAL = { m5: 5, m15: 15, m30: 30, m60: 60 };

function isMinInterval(interval) {
  return Object.prototype.hasOwnProperty.call(MIN_INTERVAL, interval);
}

// 分钟 K 的东财 secid：外盘期货用 HF_EM_SECID，指数/个股用 INDEX_EM_SECID，
// 其余 A 股按前缀推市场号（sh=1 / sz=0 / bj=0）。推不出来就返回空串，走腾讯。
function minuteEmSecid(code) {
  if (EM_SECID[code] || HF_EM_SECID[code]) return EM_SECID[code] || HF_EM_SECID[code];
  if (INDEX_EM_SECID[code]) return INDEX_EM_SECID[code];
  const m = /^(sh|sz|bj)(\d{6})$/.exec(code);
  if (!m) return '';
  return (m[1] === 'sh' ? '1.' : '0.') + m[2];
}

const NAV_TTL = 30 * 60 * 1000;

// 东财 K 线行：[日期, 开, 收, 高, 低, 量, 额, 振幅]
// 接口给的是逗号分隔字符串，测试里也可能直接传数组，这里统一处理
function emFields(row) {
  return Array.isArray(row) ? row : String(row == null ? '' : row).split(',');
}

function mapEmKlineRows(rows) {
  return (rows || []).map(function (r) {
    const f = emFields(r);
    return [String(f[0] || ''), num(f[1]), num(f[2]), num(f[3]), num(f[4]), num(f[5])];
  }).filter(function (x) {
    return x[0] && isFinite(x[1]) && isFinite(x[2]) && isFinite(x[3]) && isFinite(x[4]);
  });
}

function shiftDate(dateStr, delta) {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 东财 5 分钟 K 线 -> 最近 5 个交易日的分时点。24 小时品种凌晨 0-5 点算前一日夜盘，
// 否则一个交易日会被拆成两天，5 日图会多出一截。
function buildFiveDayRows(rows) {
  const list = (rows || []).slice().sort(function (a, b) {
    return String(emFields(a)[0] || '').localeCompare(String(emFields(b)[0] || ''));
  });
  const groups = [];
  let cur = null;
  for (let i = 0; i < list.length; i++) {
    const f = emFields(list[i]);
    const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/.exec(String(f[0] || ''));
    if (!m) continue;
    const price = num(f[2]);
    if (!isFinite(price)) continue;
    let date = m[1];
    if (parseInt(m[2].slice(0, 2), 10) < 6) date = shiftDate(date, -1);
    if (!cur || cur.date !== date) {
      cur = { date: date, prec: NaN, points: [] };
      groups.push(cur);
    }
    const v = num(f[5]);
    cur.points.push({ t: m[2], price: price, vol: isFinite(v) ? v : 0 });
  }
  const days = groups.filter(function (g) { return g.points.length > 1; });
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1].points;
    days[i].prec = prev[prev.length - 1].price;
  }
  return days.slice(-5);
}

// 新浪/腾讯日 K 聚合成月 K（东财月 K 不可用时的兜底）
function aggregateMonthlyRows(rows) {
  return aggregateRows(rows, function (date) {
    const ym = date.slice(0, 7);
    return /^\d{4}-\d{2}$/.test(ym) ? ym : '';
  });
}

// 日 K 聚合成周 K：按 ISO 周归一，跨年的那一周不会被切成两段。
// 新浪外盘 / 兜底日 K 没有周 K 接口时用它。
function aggregateWeeklyRows(rows) {
  return aggregateRows(rows, function (date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    if (!m) return '';
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
    // 归到本周四所在的年份 + 周数，ISO 8601 的做法：跨年周按多数天数归属于哪一年
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const year = d.getUTCFullYear();
    const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return year + '-W' + (week < 10 ? '0' + week : week);
  });
}

// 通用聚合：同一 key 内开取首根、收取尾根、高取最大、低取最小、量累加。
// key 返回空串的行直接丢掉（坏日期）。
function aggregateRows(rows, keyOf) {
  const list = (rows || []).slice().sort(function (a, b) {
    return String(emFields(a)[0] || '').localeCompare(String(emFields(b)[0] || ''));
  });
  const out = [];
  let cur = null, key = '';
  for (let i = 0; i < list.length; i++) {
    const f = emFields(list[i]);
    const date = String(f[0] || '');
    const k = keyOf(date);
    if (!k) continue;
    const o = num(f[1]), c = num(f[2]), h = num(f[3]), l = num(f[4]), v = num(f[5]);
    if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l)) continue;
    if (!cur || k !== key) {
      key = k;
      cur = [date, o, c, h, l, isFinite(v) ? v : 0];
      out.push(cur);
    } else {
      cur[0] = date;
      cur[2] = c;
      if (h > cur[3]) cur[3] = h;
      if (l < cur[4]) cur[4] = l;
      if (isFinite(v)) cur[5] += v;
    }
  }
  return out;
}

function createMarket(options) {
  options = options || {};
  const http = options.http;
  const log = typeof options.log === 'function' ? options.log : function () {};

  if (!http) throw new Error('createMarket 需要 http 实例');

  let qtHostIdx = 0;
  let sinaFallbackLogged = false;
  const navCache = {};

  function noteSinaFallback() {
    if (sinaFallbackLogged) return;
    sinaFallbackLogged = true;
    log('[quote]', '腾讯行情不可用，已切到新浪财经兜底');
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
        const j = await http.fetchJson('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid +
          '&fields=f43,f44,f45,f46,f57,f58,f60,f170', {
          headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-snapshot'
        });
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
      } catch (error) {
        // 单个特殊品种失败不影响其它标的。
      }
    }

    if (!txCodes.length) return out;

    // 调试用：TICKER_FORCE_SINA=1 时优先走新浪，验证兜底链路是否可用
    if (process.env.TICKER_FORCE_SINA) {
      try {
        const alt = await fetchSinaSnapshots(txCodes);
        if (Object.keys(alt).length) {
          Object.keys(out).forEach(function (k) { alt[k] = out[k]; });
          return alt;
        }
      } catch (error) {
        // 继续走腾讯。
      }
    }

    try {
      const text = await http.fetchGbk('https://qt.gtimg.cn/q=' + txCodes.join(','), HEADERS, {
        timeout: 3500, retries: 1, tag: 'tencent-snapshot'
      });
      const map = {};
      text.split(';').forEach(function (line) {
        const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
        if (!m) return;
        const code = m[1];
        if (/^hf_/i.test(code)) {
          // 外盘期货用逗号分隔（A股用波浪号）：现价,涨跌幅%,...,最高,最低,时间,昨结,今开,...,日期,名称
          const a = m[2].split(',');
          const price = num(a[0]);
          const pctRaw = num(a[1]);
          const prev = num(a[7]);
          map[code] = {
            name: NAMES[code] || a[13] || code,
            price: price,
            prevClose: prev,
            pct: pctRaw,
            change: (isFinite(price) && isFinite(prev)) ? price - prev : NaN,
            time: (a[12] || '') + ' ' + (a[6] || '')
          };
        } else {
          const a = m[2].split('~');
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
    } catch (error) {
      const alt = await fetchSinaSnapshots(txCodes);
      if (Object.keys(alt).length) {
        Object.keys(out).forEach(function (k) { alt[k] = out[k]; });
        return alt;
      }
      throw error;
    }
  }

  // 新浪快照兜底。新浪各家字段顺序不一样，按代码类型分开解析：
  //   int_ 美股指数：名称, 现价, 涨跌, 涨跌%
  //   hk   港股：    代码, 名称, 今开, 昨收, 最高, 最低, 现价, 涨跌, 涨跌%
  //   A股/指数：     名称, 今开, 昨收, 现价, 最高, 最低, ...
  async function fetchSinaSnapshots(codes) {
    const backward = {};
    codes.forEach(function (c) {
      const s = sinaSymbol(c);
      if (!s) return;
      backward[s] = c;
    });
    const syms = Object.keys(backward);
    if (!syms.length) return {};

    const text = await http.fetchGbk('https://hq.sinajs.cn/list=' + syms.join(','), SINA_HEADERS, {
      timeout: 3500, retries: 1, tag: 'sina-snapshot'
    });
    const map = {};
    text.split(';').forEach(function (line) {
      const m = /hq_str_([A-Za-z0-9_$]+)="([^"]*)"/.exec(line);
      if (!m || !m[2]) return;
      const code = backward[m[1]];
      if (!code) return;

      const a = m[2].split(',');
      let name = a[0];
      let price = NaN;
      let prev = NaN;
      let chg = NaN;
      let pct = NaN;

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

  async function fetchTencentJson(pathAndQuery) {
    let lastError = null;
    for (let i = 0; i < QT_HOSTS.length; i++) {
      const idx = (qtHostIdx + i) % QT_HOSTS.length;
      try {
        const j = await http.fetchJson(QT_HOSTS[idx] + pathAndQuery, {
          headers: HEADERS, timeout: 4000, retries: 1, tag: 'tencent'
        });
        if (idx !== qtHostIdx) {
          qtHostIdx = idx;
          log('[quote]', '已切换到备用行情入口 ' + QT_HOSTS[idx]);
        }
        return j;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('行情接口不可用');
  }

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
        out.push({
          code: code,
          name: name,
          market: /^hf_/i.test(code) ? 'hf' : 'em',
          type: '',
          typeLabel: '外盘期货'
        });
        seen[code] = true;
      }
    });

    const text = await http.fetchGbk('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(q) + '&t=all&c=1',
      HEADERS, { timeout: 4000, retries: 1, tag: 'search' });
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

  function parseSinaJsonp(text) {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch (error) {
      return [];
    }
  }

  async function fetchSinaText(url, tag) {
    return http.fetchText(url, {
      headers: SINA_HEADERS, timeout: 4000, retries: 1, tag: tag || 'sina'
    });
  }

  async function fetchSinaMinute(code) {
    const url = 'https://quotes.sina.cn/cn/api/openapi.php/CN_MinlineService.getMinlineData?symbol=' +
      encodeURIComponent(code) + '&scale=1&dpc=1';
    const j = JSON.parse(await fetchSinaText(url, 'sina-minute'));
    const arr = (j && j.result && j.result.data) || [];
    const pts = [];
    for (let i = 0; i < arr.length; i++) {
      const p = num(arr[i] && arr[i].p);
      if (isFinite(p)) pts.push(p);
    }
    return pts;
  }

  // 转成和腾讯一致的 [日期, 开, 收, 高, 低, 量]，这样 closeSeries 不用改
  async function fetchSinaKline(code, interval, count) {
    const scale = SINA_SCALE[interval] || SINA_SCALE.day;
    const url = 'https://quotes.sina.cn/cn/api/jsonp_v2.php/x=/CN_MarketDataService.getKLineData?symbol=' +
      encodeURIComponent(code) + '&scale=' + scale + '&ma=no&datalen=' + count;
    const arr = parseSinaJsonp(await fetchSinaText(url, 'sina-kline'));
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
      const j = await http.fetchJson(url, { headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute' });
      const trends = (j && j.data && j.data.trends) || [];
      return trends.map(function (t) { return num(String(t).split(',')[2]); }).filter(isFinite);
    }
    if (process.env.TICKER_FORCE_SINA && sinaSupported(code)) {
      try {
        const alt = await fetchSinaMinute(code);
        if (alt.length >= 2) return alt;
      } catch (error) {
        // 落到腾讯。
      }
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
      if (alt.length >= 2) {
        noteSinaFallback();
        return alt;
      }
      return pts;
    } catch (error) {
      if (!sinaSupported(code)) throw error;
      const alt = await fetchSinaMinute(code);
      if (alt.length) {
        noteSinaFallback();
        return alt;
      }
      throw error;
    }
  }

  // 东财 K 线（外盘期货 / 美元指数）。klt: 5=5分钟, 101=日, 103=月
  async function fetchEmKlines(secid, klt, count) {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + encodeURIComponent(secid) +
      '&klt=' + klt + '&fqt=1&lmt=' + count + '&end=20500101' +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
    const j = await http.fetchJson(url, { headers: HEADERS, timeout: 5000, retries: 1, tag: 'em-kline' });
    return (j && j.data && j.data.klines) || [];
  }

  // 新浪外盘期货日 K：[日期, 开, 收, 高, 低, 量]
  async function fetchHfDailyRows(code) {
    const sym = code.slice(3).toUpperCase();
    const url = 'https://stock2.finance.sina.com.cn/futures/api/openapi.php/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=' + sym;
    const j = await http.fetchJson(url, { headers: HEADERS, timeout: 5000, retries: 1, tag: 'hf-kline' });
    const rows = (j && j.result && j.result.data) || [];
    return rows.map(function (r) {
      return [String(r.date || r.day || ''), num(r.open), num(r.close), num(r.high), num(r.low), num(r.volume)];
    }).filter(function (x) {
      return isFinite(x[1]) && isFinite(x[2]) && isFinite(x[3]) && isFinite(x[4]);
    });
  }

  // 外盘 5 日分时：东财 5 分钟 K 线，按交易日夜盘归并后取最近 5 天
  async function fetchFiveDay(code) {
    const secid = EM_SECID[code] || HF_EM_SECID[code];
    if (!secid) return [];
    return buildFiveDayRows(await fetchEmKlines(secid, 5, 2000));
  }

  // K 线原始行：[日期, 开, 收, 高, 低, 量]
  // 周期：m5/m15/m30/m60（分时级别 K）、day、week、month。
  // 外盘期货 / 美元指数走东财，月 K 用 klt=103、周 K 用 klt=102，避免日 K 冒充。
  async function fetchKlineRaw(code, interval, count) {
    // 分钟 K 优先走东财：腾讯的 m5/m15 只返回当天（常常就 1~2 根），
    // 往回翻几天必须换东财，它一次能给 320 根，港股 / 美股指数也都覆盖。
    if (isMinInterval(interval)) {
      const secid = minuteEmSecid(code);
      if (secid) {
        try {
          const rows = mapEmKlineRows(await fetchEmKlines(secid, MIN_INTERVAL[interval], count));
          if (rows.length) return rows;
        } catch (error) {
          // 东财不可用：落到下面的腾讯 / 新浪兜底。
        }
      }
    }
    if (process.env.TICKER_FORCE_SINA && sinaSupported(code)) {
      try {
        const alt = await fetchSinaKline(code, interval, count);
        if (alt.length) return alt;
      } catch (error) {
        // 落到腾讯。
      }
    }
    const emSecid = EM_SECID[code] || HF_EM_SECID[code];
    if (emSecid) {
      try {
        const rows = mapEmKlineRows(await fetchEmKlines(emSecid, emKltOf(interval), count));
        if (rows.length) return rows;
      } catch (error) {
        // 东财不可用时，外盘继续走新浪日 K 兜底。
      }
      if (/^hf_/i.test(code)) {
        const rows = await fetchHfDailyRows(code);
        if (isMinInterval(interval) || interval === 'week') return aggregateRowsShape(rows, interval, count);
        return interval === 'month' ? aggregateMonthlyRows(rows).slice(-count) : rows.slice(-count);
      }
      return [];
    }
    // 未映射的外盘期货：腾讯无 K 线，走新浪外盘日K，周/月 K 由日 K 聚合
    if (/^hf_/i.test(code)) {
      const rows = await fetchHfDailyRows(code);
      if (isMinInterval(interval) || interval === 'week') return aggregateRowsShape(rows, interval, count);
      return interval === 'month' ? aggregateMonthlyRows(rows).slice(-count) : rows.slice(-count);
    }
    try {
      const rows = await fetchTencentKlineRows(code, interval, count);
      if (rows.length) return rows;
      if (!sinaSupported(code)) return [];
      // 周 K / 分钟 K 新浪都支持自己的 scale，日 K 兜底同样可用
      const alt = await fetchSinaKline(code, interval, count);
      if (alt.length) {
        noteSinaFallback();
        return alt;
      }
      return [];
    } catch (error) {
      if (!sinaSupported(code)) throw error;
      const alt = await fetchSinaKline(code, interval, count);
      if (alt.length) {
        noteSinaFallback();
        return alt;
      }
      throw error;
    }
  }

  // 分钟 K 没有日 K 可聚合的兜底：直接返回空，让上层显示「暂无 K 线数据」
  function aggregateRowsShape(rows, interval, count) {
    if (interval === 'week') return aggregateWeeklyRows(rows).slice(-count);
    return rows.slice(-count);
  }

  function emKltOf(interval) {
    if (isMinInterval(interval)) return MIN_INTERVAL[interval];
    if (interval === 'week') return 102;
    if (interval === 'month') return 103;
    return 101;
  }

  // 腾讯 fqkline / usfqkline：周期字段名各不一样，按块里的候选 key 依次取。
  // 分钟 K 用 qfqm5 / m5 这种命名，新浪与腾讯的字段顺序保持一致（开收高低量）。
  async function fetchTencentKlineRows(code, interval, count) {
    const ep = code.slice(0, 2).toLowerCase() === 'us' ? 'usfqkline' : 'fqkline';
    const url = '/appstock/app/' + ep + '/get?param=' +
      code + ',' + interval + ',,,' + count + ',qfq';
    const j = await fetchTencentJson(url);
    const block = j && j.data && j.data[code];
    if (!block) return [];
    const keys = ['qfq' + interval, interval];
    for (let i = 0; i < keys.length; i++) {
      const arr = block[keys[i]];
      if (Array.isArray(arr) && arr.length) return arr;
    }
    return [];
  }

  async function fetchSeries(code, period) {
    // 东财特殊品种（美元指数等）：走东财分时
    if (EM_SECID[code] && period === 'minute') {
      const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + EM_SECID[code] +
        '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
      const j = await http.fetchJson(url, { headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute' });
      const trends = (j && j.data && j.data.trends) || [];
      return trends.map(function (t) { return num(String(t).split(',')[2]); }).filter(isFinite);
    }
    // 外盘期货（hf_ 前缀）：分时走东财 trends2，日/月/年 K 统一走 fetchKlineRaw
    if (/^hf_/i.test(code)) {
      const secid = HF_EM_SECID[code];
      if (secid && period === 'minute') {
        const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
          '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
        const j = await http.fetchJson(url, { headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute' });
        const trends = (j && j.data && j.data.trends) || [];
        return trends.map(function (t) { return num(String(t).split(',')[2]); }).filter(isFinite);
      }
    }
    if (period === 'day') return closeSeries(await fetchKlineRaw(code, 'day', 120));
    if (period === 'month') return closeSeries(await fetchKlineRaw(code, 'month', 120));
    if (period === 'year') return yearlySeries(await fetchKlineRaw(code, 'month', 240));
    return [];
  }

  // 盘中估值：新浪 fu_ 批量接口；货币基金等没有盘中估值的会返回空串
  async function fetchFundEstimates(codes) {
    if (!codes.length) return {};
    const url = 'https://hq.sinajs.cn/list=' + codes.map(function (c) { return 'fu_' + c; }).join(',');
    const text = await http.fetchGbk(url, SINA_HEADERS, {
      timeout: 4000, retries: 1, tag: 'fund-estimate'
    });
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
  async function fetchFundNav(code) {
    const hit = navCache[code];
    if (hit && Date.now() - hit.at < NAV_TTL) return hit;

    const text = await http.fetchText('https://fund.eastmoney.com/pingzhongdata/' + code + '.js', {
      headers: FUND_HEADERS, encoding: 'utf8', timeout: 6000, retries: 1, tag: 'fund-nav'
    });

    const nameM = text.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
    const nwM = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);

    let rows = [];
    if (nwM) {
      try {
        const arr = JSON.parse(nwM[1]);
        rows = arr.map(function (r) { return [r.x, num(r.y)]; }).filter(function (r) { return isFinite(r[1]); });
      } catch (error) {
        // 净值解析失败时保留空序列，由界面显示无数据。
      }
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

  function clearCaches() {
    Object.keys(navCache).forEach(function (key) { delete navCache[key]; });
    qtHostIdx = 0;
    sinaFallbackLogged = false;
  }

  return {
    fetchSnapshots,
    fetchSinaSnapshots,
    fetchTencentJson,
    searchSymbols,
    fetchMinuteSeries,
    fetchKlineRaw,
    fetchFiveDay,
    fetchSeries,
    fetchFundEstimates,
    fetchFundNav,
    clearCaches,
    isFundCode
  };
}

module.exports = {
  createMarket,
  HEADERS,
  SINA_HEADERS,
  FUND_HEADERS,
  QT_HOSTS,
  mapEmKlineRows,
  buildFiveDayRows,
  aggregateMonthlyRows,
  aggregateWeeklyRows,
  aggregateRows,
  isMinInterval,
  MIN_INTERVAL,
  SINA_SCALE
};
