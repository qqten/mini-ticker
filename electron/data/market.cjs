'use strict';

const { num } = require('../core/utils.cjs');
const { closeSeries, yearlySeries } = require('../core/quotes.cjs');
const {
  isFundCode,
  isValidCode,
  sinaSupported,
  sinaSymbol,
  unescapeUnicode,
  emIndexSecid
} = require('../core/symbols.cjs');
const { NAMES, EM_SECID, HF_EM_SECID, INDEX_EM_SECID, SGE_SYMBOL, LOCAL_SEARCH_LABEL, TYPE_LABEL } = require('../core/constants.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const HEADERS = { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/' };
const SINA_HEADERS = { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' };
const FUND_HEADERS = { 'User-Agent': UA, 'Referer': 'https://fund.eastmoney.com/' };
const CSI_HEADERS = { 'User-Agent': UA, 'Referer': 'https://www.csindex.com.cn/' };
const SGE_HEADERS = { 'User-Agent': UA, 'Referer': 'https://www.sge.com.cn/' };

// 腾讯行情有两个等价入口：主域名被 WAF 拦就换备用域名，数据格式完全一致
const QT_HOSTS = [
  'https://ifzq.gtimg.cn',
  'https://proxy.finance.qq.com/ifzqgtimg'
];

// 新浪 K 线周期：1/5/15/30/60=分钟，240=日 1200=周 7200=月
const SINA_SCALE = { m1: 1, m5: 5, m15: 15, m30: 30, m60: 60, day: 240, week: 1200, month: 7200 };

// 新浪外汇日 K：东财 push2his 的 K 线接口对美元指数经常连不上（ERR_EMPTY_RESPONSE），
// 这里用新浪 DINIW 日线兜底，接口原始字段是「日期,开,低,高,收」。
const SINA_FX_SYMBOL = { usDXY: 'DINIW' };

// 分钟级 K 线周期 → 腾讯 fqkline 的 key 后缀（m5 / m15 / m30 / m60）与东财 klt（1 / 5 / 15 / 30 / 60）。
// 腾讯把分钟 K 放在块内的 qfqm5 这种字段里，东财用 klt 区分，两边对不上时按这两张表转。
// 腾讯不支持 m1（返回 bad params），1 分钟只能走东财 klt=1 / 新浪 scale=1。
const MIN_INTERVAL = { m1: 1, m5: 5, m15: 15, m30: 30, m60: 60 };

function isMinInterval(interval) {
  return Object.prototype.hasOwnProperty.call(MIN_INTERVAL, interval);
}

// 搜索接口覆盖不到的品种：腾讯 smartbox 查不到上金所现货 / 国债期货 / 债券指数
// （搜「黄金9999」直接返回空，搜「国债指数」只给场外基金），只能按名称在本地表里匹配。
function isLocalSearchCode(code) {
  return /^(hf|sge|cf)_/i.test(code) ||
    Object.prototype.hasOwnProperty.call(EM_SECID, code) ||
    Object.prototype.hasOwnProperty.call(LOCAL_SEARCH_LABEL, code);
}

// 本地匹配出来的候选，市场标签和类型标签都按前缀 / 名称表给
function localMarketOf(code) {
  if (/^sge_/i.test(code)) return 'sge';
  if (/^cf_/i.test(code)) return 'cf';
  if (/^hf_/i.test(code)) return 'hf';
  if (/^usDXY$/i.test(code)) return 'em';
  const m = /^(sh|sz|bj|hk|us)/i.exec(code);
  return m ? m[1].toLowerCase() : 'em';
}

function localTypeLabelOf(code) {
  if (/^sge_/i.test(code)) return '上金所';
  if (/^cf_/i.test(code)) return '国债期货';
  const label = LOCAL_SEARCH_LABEL[code];
  if (label) return label;
  if (/^hf_/i.test(code)) return '外盘期货';
  return '';
}

// 分钟 K 的东财 secid：外盘期货用 HF_EM_SECID，指数/个股用 INDEX_EM_SECID，
// 其余 A 股按前缀推市场号（sh=1 / sz=0 / bj=0）。推不出来就返回空串，走腾讯。
function minuteEmSecid(code) {
  if (EM_SECID[code] || HF_EM_SECID[code]) return EM_SECID[code] || HF_EM_SECID[code];
  if (INDEX_EM_SECID[code]) return INDEX_EM_SECID[code];
  if (emIndexSecid(code)) return emIndexSecid(code);
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

// 下一个工作日：上金所周五夜盘算到下周一（周末休市）
function nextWeekday(dateStr) {
  const p = String(dateStr).split('-');
  const d = new Date(Date.UTC(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

// 东财 5 分钟 K 线 -> 最近 5 个交易日的分时点。
// 24 小时品种（外盘 / 美元指数）凌晨 0-5 点算前一日夜盘；
// 上金所 T+D 相反：前一天 20:00 之后算下一个交易日（周五夜盘归下周一）。
function buildFiveDayRows(rows, nightNext) {
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
    const hour = parseInt(m[2].slice(0, 2), 10);
    if (nightNext) {
      if (hour >= 20) date = nextWeekday(date);
    } else if (hour < 6) {
      date = shiftDate(date, -1);
    }
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
  const csiInfoCache = {};
  const csiQuoteCache = {};

  function noteSinaFallback() {
    if (sinaFallbackLogged) return;
    sinaFallbackLogged = true;
    log('[quote]', '腾讯行情不可用，已切到新浪财经兜底');
  }

  // 中证官网的指数基本信息：名称 + 币种。港股主题指数的币种是港元，
  // 用来判断 16:00 收盘；东财快照被限流时也能补到名称，列表不会只剩代码。
  async function fetchCsindexInfo(code) {
    const id = String(code || '').replace(/^em/i, '');
    if (!/^[A-Za-z0-9]{6}$/.test(id)) return null;
    if (csiInfoCache[id]) return csiInfoCache[id];
    try {
      const j = await http.fetchJson(
        'https://www.csindex.com.cn/csindex-home/indexInfo/index-basic-info/' + id,
        { headers: CSI_HEADERS, timeout: 4000, retries: 1, tag: 'csi-info' }
      );
      const d = j && j.data;
      if (!d) return null;
      const currency = String(d.currencyCn || '') + ' ' + String(d.currencyEn || '');
      const info = {
        name: String(d.indexShortNameCn || d.indexFullNameCn || ''),
        hk: /港元/.test(currency) || /HKD/i.test(currency)
      };
      if (info.name || info.hk) csiInfoCache[id] = info;
      return info;
    } catch (error) {
      // 失败不缓存，下次还能重试
      return null;
    }
  }

  // 中证官网的指数实时快照：东财 push2 被限流时用它补价格 / 昨收 / 涨跌幅。
  // 15 秒缓存，别每 3 秒轮询都打一次；失败不缓存，下次重试。
  async function fetchCsindexQuote(code) {
    const id = String(code || '').replace(/^em/i, '');
    if (!/^[A-Za-z0-9]{6}$/.test(id)) return null;
    const hit = csiQuoteCache[id];
    if (hit && Date.now() - hit.at < 15000) return hit;
    try {
      const j = await http.fetchJson(
        'https://www.csindex.com.cn/csindex-home/perf/index-perf-oneday?indexCode=' + encodeURIComponent(id),
        { headers: CSI_HEADERS, timeout: 5000, retries: 1, tag: 'csi-quote' }
      );
      const h = j && j.data && j.data.intraDayHeader;
      if (!h) return null;
      const price = num(h.current);
      const prev = num(h.closePre);
      const pct = num(h.changePct);
      const out = {
        at: Date.now(),
        price: price,
        prevClose: prev,
        pct: isFinite(pct) ? pct : (((price - prev) / prev) * 100)
      };
      csiQuoteCache[id] = out;
      return out;
    } catch (error) {
      return null;
    }
  }

  // 实时快照（GBK），一次请求拿全部标的
  async function fetchSnapshots(codes) {
    // 东财特殊品种（美元指数、em 前缀的专属指数）：腾讯不支持，单独走东财快照
    const emCodes = codes.filter(function (c) { return EM_SECID[c] || emIndexSecid(c); });
    const txCodes = codes.filter(function (c) { return !EM_SECID[c] && !emIndexSecid(c); });
    const out = {};

    for (let i = 0; i < emCodes.length; i++) {
      const code = emCodes[i];
      const secid = EM_SECID[code] || emIndexSecid(code);
      let d = null;
      try {
        const j = await http.fetchJson('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid +
          '&fields=f43,f44,f45,f46,f57,f58,f59,f60,f170', {
          headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-snapshot'
        });
        d = j && j.data;
      } catch (error) {
        // 单个特殊品种失败不影响其它标的。
      }
      if (d) {
        // 东财价格是整数，按 f59 给的小数位数还原：美元指数 / 上金所现货 2 位，
        // 国债期货 3 位（110110 是 110.110）。缺省按 2 位。
        const decimals = isFinite(num(d.f59)) ? Math.max(0, Math.min(4, num(d.f59))) : 2;
        const scale = Math.pow(10, decimals);
        const price = (d.f43 || 0) / scale;
        const prev = (d.f60 || 0) / scale;
        out[code] = {
          name: NAMES[code] || d.f58 || code,
          price: price,
          prevClose: prev,
          pct: (d.f170 || 0) / 100,
          change: price - prev,
          time: ''
        };
        continue;
      }
      // 东财快照被限流 / 返回空：em 指数还能从中证官网补到名称和价格。
      // 只补名称会让列表显示错误的涨跌幅（拿最后一分钟和前一分钟比），所以价格也一起补。
      if (emIndexSecid(code)) {
        const info = await fetchCsindexInfo(code);
        const quote = await fetchCsindexQuote(code);
        const name = (NAMES[code] && NAMES[code] !== code)
          ? NAMES[code]
          : ((info && info.name) || code);
        if ((info && info.name) || quote) {
          out[code] = {
            name: name,
            price: quote ? quote.price : NaN,
            prevClose: quote ? quote.prevClose : NaN,
            pct: quote ? quote.pct : NaN,
            change: quote && isFinite(quote.price) && isFinite(quote.prevClose)
              ? quote.price - quote.prevClose
              : NaN,
            time: ''
          };
        }
      }
      // 上金所 T+D：东财快照不可用时走新浪 SGE_AUTD
      if (SGE_SYMBOL[code]) {
        try {
          const alt = await fetchSinaSgeSnapshot(code);
          if (alt) out[code] = alt;
        } catch (error) {
          // 两个源都失败就交给上面的列表逻辑显示 --
        }
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

  // 东财搜索：腾讯 smartbox 查不到的中证 / 国证指数（如 931787 港股创新药）只能从这里找。
  // 市场号 2 的指数腾讯、新浪都没有，内部代码写成 em + 6 位数字；沪深指数仍用 sh / sz。
  async function searchEmIndices(keyword) {
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(keyword) +
      '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10';
    const j = await http.fetchJson(url, {
      headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-search'
    });
    const table = (j && j.QuotationCodeTable) || {};
    const rows = Array.isArray(table.Data) ? table.Data : [];
    const out = [];
    rows.forEach(function (row) {
      if (!row || String(row.SecurityTypeName || '') !== '指数') return;
      const m = /^(\d+)\.([A-Za-z0-9_]+)$/.exec(String(row.QuoteID || ''));
      if (!m || !/^\d{6}$/.test(m[2])) return;
      const id = m[2];
      let code = '';
      if (m[1] === '2') code = 'em' + id;
      else if (m[1] === '1') code = 'sh' + id;
      else if (m[1] === '0') code = 'sz' + id;
      if (!code || !isValidCode(code)) return;
      out.push({
        code: code,
        name: String(row.Name || code),
        market: m[1] === '2' ? 'em' : (m[1] === '1' ? 'sh' : 'sz'),
        type: 'ZS',
        typeLabel: TYPE_LABEL.ZS
      });
    });
    return out;
  }

  async function searchSymbols(keyword) {
    const q = String(keyword || '').trim();
    if (!q) return [];

    const out = [];
    const seen = {};
    // 6 位数字可能是股票、场外基金，也可能是东财专属指数，先交给搜索判断
    const six = /^\d{6}$/.test(q) ? q : '';

    // 用户直接输入代码（如 hf_GC、sge_AU9999、cf_TM、sh518880）时，即使搜索接口没有也直接返回
    if (isValidCode(q) && !six) {
      out.push({
        code: q,
        name: NAMES[q] || q,
        market: localMarketOf(q),
        type: '',
        typeLabel: localTypeLabelOf(q)
      });
      seen[q] = true;
    }

    // 外盘期货（hf_）、东财特殊品种（usDXY / 上金所现货 / 国债期货）和债券指数
    // 搜索接口都不覆盖，按名称本地匹配
    const ql = q.toLowerCase();
    Object.keys(NAMES).forEach(function (code) {
      if (!isLocalSearchCode(code)) return;
      const name = NAMES[code];
      if (seen[code]) return;
      if (name.toLowerCase().indexOf(ql) >= 0 || code.toLowerCase().indexOf(ql) >= 0) {
        out.push({
          code: code,
          name: name,
          market: localMarketOf(code),
          type: '',
          typeLabel: localTypeLabelOf(code)
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

    // 腾讯搜不到时补一次东财：中证系列指数（931787 等）只在东财有。
    // 6 位数字两条搜索都没认出来，才按场外基金兜底。
    if (!out.length) {
      try {
        const emList = await searchEmIndices(q);
        for (let i = 0; i < emList.length; i++) {
          const it = emList[i];
          if (seen[it.code]) continue;
          seen[it.code] = true;
          out.push(it);
        }
      } catch (error) {
        // 东财搜索挂了不影响腾讯结果和下面的基金兜底
      }
    }
    if (six && !out.length) {
      out.push({ code: q, name: NAMES[q] || q, market: q.slice(0, 2).toLowerCase(), type: '', typeLabel: '' });
      seen[q] = true;
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

  // 东财当日分时（trends2）：腾讯不支持的品种走这里，只取价格序列
  async function fetchEmMinuteTrend(secid) {
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + secid +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55&iscr=0&ndays=1';
    const j = await http.fetchJson(url, { headers: HEADERS, timeout: 4000, retries: 1, tag: 'em-minute' });
    const trends = (j && j.data && j.data.trends) || [];
    return trends.map(function (t) { return num(String(t).split(',')[2]); }).filter(isFinite);
  }

  // 东财 trends2 的原始行：[时间, 开, 收, 高, 低, 量, 额, 均价]。
  // ndays=5 时东财一次给 5 个交易日的 1 分钟分时，用来拼 5 日图。
  async function fetchEmTrendsRows(secid, ndays) {
    const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + encodeURIComponent(secid) +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
      '&iscr=0&ndays=' + (ndays > 0 ? ndays : 1);
    const j = await http.fetchJson(url, { headers: HEADERS, timeout: 5000, retries: 1, tag: 'em-trends' });
    const trends = (j && j.data && j.data.trends) || [];
    return trends.map(function (row) {
      const f = String(row).split(',');
      return [f[0], num(f[1]), num(f[2]), num(f[3]), num(f[4]), num(f[5])];
    });
  }

  // 当日分时（一次只能查一个 code）
  async function fetchMinuteSeries(code) {
    // 东财特殊品种（美元指数 / 黄金T+D 等）、外盘期货、em 专属指数：腾讯不支持分时，走东财 trends2
    const emSecid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
    if (emSecid) {
      // 有非东财兜底的品种（美元指数 / 外盘 / 上金所），东财挂了再换源
      const hasAlt = !!SINA_FX_SYMBOL[code] || /^hf_/i.test(code) || !!SGE_SYMBOL[code];
      try {
        const pts = await fetchEmMinuteTrend(emSecid);
        if (pts.length || !hasAlt) return pts;
      } catch (error) {
        if (!hasAlt) throw error;
      }
      const alt = await fetchForeignMinute(code);
      return alt.points.map(function (p) { return p.price; }).filter(isFinite);
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

  // 新浪外汇日 K（美元指数）：原始行是「日期,开,低,高,收」，这里换成
  // [日期, 开, 收, 高, 低, 量]，与腾讯 / 东财的行顺序保持一致。
  // 一次返回 1985 年至今约 1 万行，按 symbol 缓存 60 秒，避免日/周/月各拉一次。
  const sinaFxCache = {};
  async function fetchSinaFxDailyRows(symbol) {
    const now = Date.now();
    const hit = sinaFxCache[symbol];
    if (hit && now - hit.at < 60 * 1000) return hit.rows;
    const url = 'https://vip.stock.finance.sina.com.cn/forex/api/openapi.php/NewForexService.getDayKLine?symbol=' +
      encodeURIComponent(symbol);
    const j = await http.fetchJson(url, { headers: SINA_HEADERS, timeout: 8000, retries: 1, tag: 'sina-fx' });
    const text = String((j && j.result && j.result.data) || '');
    const rows = [];
    const parts = text.split('|');
    for (let i = 0; i < parts.length; i++) {
      const f = parts[i].split(',');
      const date = String(f[0] || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const o = num(f[1]), l = num(f[2]), h = num(f[3]), c = num(f[4]);
      if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l)) continue;
      rows.push([date, o, c, h, l, 0]);
    }
    if (rows.length) sinaFxCache[symbol] = { at: now, rows: rows };
    return rows;
  }

  // 新浪外汇分钟 K：getOldMinKLine 是新浪手机端分时/K 线用的接口，
  // 1 分钟给最近 24 小时（1440 根），5 分钟给最近 5 个交易日。
  // 返回 [日期时间, 开, 收, 高, 低, 量]，和腾讯 / 东财的行顺序一致。
  const sinaFxMinCache = {};
  async function fetchSinaFxMinuteRows(symbol, scale, count) {
    const key = symbol + '|' + scale + '|' + count;
    const now = Date.now();
    const hit = sinaFxMinCache[key];
    if (hit && now - hit.at < 15 * 1000) return hit.rows;
    const url = 'https://vip.stock.finance.sina.com.cn/forex/api/openapi.php/NewForexService.getOldMinKLine' +
      '?symbol=' + encodeURIComponent(symbol) + '&scale=' + scale + '&datalen=' + count;
    const j = await http.fetchJson(url, { headers: SINA_HEADERS, timeout: 8000, retries: 1, tag: 'sina-fx-min' });
    const arr = (j && j.result && j.result.data) || [];
    const rows = [];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i] || {};
        const date = String(r.d || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(date)) continue;
        const o = num(r.o), h = num(r.h), l = num(r.l), c = num(r.c);
        if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l)) continue;
        rows.push([date, o, c, h, l, 0]);
      }
    }
    if (rows.length) sinaFxMinCache[key] = { at: now, rows: rows };
    return rows;
  }

  // 美元指数当日分时：东财 trends2 挂掉时用新浪 getOldMinKLine 的 1 分钟 K。
  // 点的时间保留完整「YYYY-MM-DD HH:MM」，和东财 trends2 的口径一致。
  async function fetchForeignMinute(code) {
    const sge = SGE_SYMBOL[code];
    if (sge) {
      const m = await fetchSgeMinute(code);
      return { date: m.date, points: m.points };
    }
    // 外盘期货（hf_XAU / hf_OIL 等）：新浪外盘分时，只给当天
    if (/^hf_/i.test(code)) {
      const rows = await fetchSinaFutMinuteRows(code);
      return {
        date: rows.length ? String(rows[rows.length - 1].t).slice(0, 10) : '',
        points: rows
      };
    }
    const sym = SINA_FX_SYMBOL[code];
    if (!sym) return { date: '', points: [] };
    const rows = await fetchSinaFxMinuteRows(sym, 1, 1440);
    const points = rows.map(function (r) {
      return { t: String(r[0]), price: num(r[2]), vol: 0 };
    }).filter(function (p) { return p.t && isFinite(p.price); });
    return {
      date: rows.length ? String(rows[rows.length - 1][0]).slice(0, 10) : '',
      points: points
    };
  }

  // 新浪外盘期货分时（GlobalFuturesService.getGlobalFuturesMinLine）：
  // 行是 [时间, 价, 量, 0, 均价, 'YYYY-MM-DD HH:MM:SS']，首行前面多几列，
  // 统一取第 2 列价格、最后一列时间。只覆盖当天，缓存 15 秒。
  const sinaFutMinCache = {};
  async function fetchSinaFutMinuteRows(code) {
    const sym = String(code).replace(/^hf_/i, '').toUpperCase();
    const now = Date.now();
    const hit = sinaFutMinCache[sym];
    if (hit && now - hit.at < 15 * 1000) return hit.rows;
    const url = 'https://stock2.finance.sina.com.cn/futures/api/openapi.php/GlobalFuturesService.getGlobalFuturesMinLine?symbol=' +
      encodeURIComponent(sym);
    const j = await http.fetchJson(url, { headers: SINA_HEADERS, timeout: 5000, retries: 1, tag: 'sina-fut-min' });
    const arr = (j && j.result && j.result.data && j.result.data.minLine_1d) || [];
    const rows = [];
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i] || [];
      const ts = String(r[r.length - 1] || '');
      const price = num(r[1]);
      if (!/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(ts) || !isFinite(price)) continue;
      const v = num(r[2]);
      rows.push({ t: ts.slice(0, 16), price: price, vol: isFinite(v) ? v : 0 });
    }
    if (rows.length) sinaFutMinCache[sym] = { at: now, rows: rows };
    return rows;
  }

  // 上金所日 K（官网 Dailyhq）：原始行是「日期, 开, 收, 低, 高」，
  // 换成 [日期, 开, 收, 高, 低, 量]，和东财 / 腾讯的行顺序一致。
  const sgeDailyCache = {};
  async function fetchSgeDailyRows(code) {
    const sge = SGE_SYMBOL[code];
    if (!sge || !sge.instid) return [];
    const now = Date.now();
    const hit = sgeDailyCache[code];
    if (hit && now - hit.at < 60 * 1000) return hit.rows;
    const j = await http.fetchJson('https://www.sge.com.cn/graph/Dailyhq', {
      method: 'POST',
      headers: Object.assign({}, SGE_HEADERS, {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
      }),
      body: 'instid=' + encodeURIComponent(sge.instid),
      timeout: 8000, retries: 1, tag: 'sge-daily'
    });
    const arr = (j && j.time) || [];
    const rows = [];
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i] || [];
      const date = String(r[0] || '').trim();
      const o = num(r[1]), c = num(r[2]), l = num(r[3]), h = num(r[4]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (!isFinite(o) || !isFinite(c) || !isFinite(h) || !isFinite(l)) continue;
      rows.push([date, o, c, h, l, 0]);
    }
    if (rows.length) sgeDailyCache[code] = { at: now, rows: rows };
    return rows;
  }

  // 上金所当日分时（新浪 SpotService）：行是 [时间, 价, 均价, 量]，
  // 第一行还带昨收和交易日。20:00 起算，跨到第二天 15:30。
  const sgeMinCache = {};
  async function fetchSgeMinute(code) {
    const sge = SGE_SYMBOL[code];
    if (!sge || !sge.sina) return { date: '', prevClose: NaN, points: [] };
    const now = Date.now();
    const hit = sgeMinCache[code];
    if (hit && now - hit.at < 15 * 1000) return hit.data;
    const url = 'https://stock2.finance.sina.com.cn/futures/api/openapi.php/SpotService.getMinLine?symbol=' +
      encodeURIComponent(sge.sina);
    const j = await http.fetchJson(url, { headers: SINA_HEADERS, timeout: 5000, retries: 1, tag: 'sge-min' });
    const arr = (j && j.result && j.result.data) || [];
    const points = [];
    let date = '', prevClose = NaN;
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i] || [];
        const t = String(r[0] || '');
        const price = num(r[1]);
        if (!/^\d{2}:\d{2}$/.test(t) || !isFinite(price)) continue;
        const v = num(r[3]);
        points.push({ t: t, price: price, vol: isFinite(v) ? v : 0 });
        if (!date) {
          const d = String(r[5] || '');
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) date = d;
          if (!isFinite(prevClose)) prevClose = num(r[4]);
        }
      }
    }
    const data = { date: date, prevClose: prevClose, points: points };
    if (points.length) sgeMinCache[code] = { at: now, data: data };
    return data;
  }

  // 上金所日 K + 今天这段实时分时拼成一根当天 K：
  // 官网日 K 要等收盘才更新，不补的话最后一根永远停在昨天。
  async function fetchSgeKlineRows(code) {
    if (!SGE_SYMBOL[code]) return [];
    const rows = (await fetchSgeDailyRows(code)).slice();
    try {
      const m = await fetchSgeMinute(code);
      const last = rows.length ? rows[rows.length - 1][0] : '';
      if (m.points.length > 1 && m.date && m.date > last) {
        let hi = -Infinity, lo = Infinity;
        for (let i = 0; i < m.points.length; i++) {
          const p = m.points[i].price;
          if (p > hi) hi = p;
          if (p < lo) lo = p;
        }
        const open = m.points[0].price;
        const close = m.points[m.points.length - 1].price;
        rows.push([m.date, open, close, hi, lo, 0]);
      }
    } catch (error) {
      // 分时拿不到就只画到昨天，不影响日 K
    }
    return rows;
  }

  // 上金所快照兜底（GBK）：AUTD,黄金延期,Au(T+D),最新,?,昨结,开,高,低,昨收,买,卖,买量,卖量,量,额,时间,涨跌幅
  async function fetchSinaSgeSnapshot(code) {
    const sge = SGE_SYMBOL[code];
    if (!sge || !sge.sina) return null;
    const text = await http.fetchGbk('https://hq.sinajs.cn/list=SGE_' + sge.sina, SINA_HEADERS, {
      timeout: 3500, retries: 1, tag: 'sina-sge'
    });
    const m = /hq_str_SGE_[A-Za-z0-9_]+="([^"]*)"/.exec(text);
    if (!m || !m[1]) return null;
    const a = m[1].split(',');
    const price = num(a[3]);
    if (!isFinite(price) || price <= 0) return null;
    const prev = num(a[9]);
    let pct = num(String(a[17] || '').replace('%', ''));
    if (!isFinite(pct) && isFinite(prev) && prev) pct = ((price - prev) / prev) * 100;
    return {
      name: NAMES[code] || a[2] || code,
      price: price,
      prevClose: prev,
      pct: pct,
      change: isFinite(prev) ? price - prev : NaN,
      time: String(a[16] || '')
    };
  }

  // 外盘 5 日分时 / em 专属指数：东财 5 分钟 K 线，按交易日夜盘归并后取最近 5 天
  async function fetchFiveDay(code) {
    const secid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
    if (!secid) return [];
    // 上金所 T+D 的夜盘属于下一个交易日（20:00 之后），和外盘相反
    const nightNext = !!SGE_SYMBOL[code];
    let rows = [];
    try {
      rows = await fetchEmKlines(secid, 5, 2000);
    } catch (error) {
      // 东财 K 线不可用：下面还有 trends2 / 新浪 / 上金所兜底
    }
    let days = buildFiveDayRows(rows, nightNext);
    if (days.length) return days;
    // push2his 的 K 线接口经常连不上，但 push2 的 trends2 还活着；
    // ndays=5 直接给 5 个交易日的 1 分钟分时，够拼五日图。
    try {
      days = buildFiveDayRows(await fetchEmTrendsRows(secid, 5), nightNext);
      if (days.length) return days;
    } catch (error) {
      // 继续走下面的非东财兜底
    }
    // 上金所 / 外盘 / 美元指数：非东财源只能给当天，至少不画空图
    if (SGE_SYMBOL[code]) {
      // 新浪分时的 date 已经是交易日（前晚 20:00 也归这一天），不能再按小时挪
      const m = await fetchSgeMinute(code);
      if (m.points.length <= 1) return [];
      return [{ date: m.date, prec: NaN, points: m.points }];
    }
    if (/^hf_/i.test(code)) {
      const rows2 = await fetchSinaFutMinuteRows(code);
      return buildFiveDayRows(rows2.map(function (p) {
        return [p.t, p.price, p.price, p.price, p.price, p.vol];
      }));
    }
    const fxSym = SINA_FX_SYMBOL[code];
    if (fxSym) {
      // 美元指数：新浪 5 分钟 K，最近 5 个交易日
      return buildFiveDayRows(await fetchSinaFxMinuteRows(fxSym, 5, 1440));
    }
    return [];
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
          // 东财分钟 K 的 lmt 不一定严格生效（1 分钟尤其明显），这里再裁一次
          if (rows.length) return rows.slice(-count);
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
    const emSecid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
    if (emSecid) {
      try {
        const rows = mapEmKlineRows(await fetchEmKlines(emSecid, emKltOf(interval), count));
        if (rows.length) return isMinInterval(interval) ? rows.slice(-count) : rows;
      } catch (error) {
        // 东财不可用时，外盘继续走新浪日 K 兜底（分钟 K 除外）。
      }
      if (/^hf_/i.test(code)) {
        const rows = await fetchHfDailyRows(code);
        if (isMinInterval(interval) || interval === 'week') return aggregateRowsShape(rows, interval, count);
        return interval === 'month' ? aggregateMonthlyRows(rows).slice(-count) : rows.slice(-count);
      }
      // 上金所 T+D：东财 K 线不可用时走官网日 K（今天的实时段自己拼），周 / 月由日 K 聚合
      if (SGE_SYMBOL[code]) {
        const rows = await fetchSgeKlineRows(code);
        if (isMinInterval(interval) || interval === 'week') return aggregateRowsShape(rows, interval, count);
        return interval === 'month' ? aggregateMonthlyRows(rows).slice(-count) : rows.slice(-count);
      }
      // 美元指数：东财 K 线不可用时走新浪 DINIW 日线，周/月由日线聚合。
      // 分钟级别不在这里兜底，避免拿日线冒充分钟 K。
      const fxSym = SINA_FX_SYMBOL[code];
      if (fxSym && !isMinInterval(interval)) {
        try {
          const rows = await fetchSinaFxDailyRows(fxSym);
          if (rows.length) {
            if (interval === 'week') return aggregateWeeklyRows(rows).slice(-count);
            if (interval === 'month') return aggregateMonthlyRows(rows).slice(-count);
            return rows.slice(-count);
          }
        } catch (error) {
          // 新浪也失败时保持空数据，让图表明确显示「暂无 K 线数据」。
        }
      }
      return [];
    }
    // 未映射的外盘期货：腾讯无 K 线，走新浪外盘日K，周 K 由日 K 聚合
    if (/^hf_/i.test(code)) {
      const rows = await fetchHfDailyRows(code);
      if (isMinInterval(interval) || interval === 'week') return aggregateRowsShape(rows, interval, count);
      return interval === 'month' ? aggregateMonthlyRows(rows).slice(-count) : rows.slice(-count);
    }
    try {
      // 腾讯没有 1 分钟 K：m1 要么返回 bad params，要么塞一根日线形状的数据。
      // 1 分钟只认东财 klt=1 / 新浪 scale=1，宁可空着也不拿日线冒充。
      const rows = interval === 'm1' ? [] : await fetchTencentKlineRows(code, interval, count);
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

  // 分钟 K 没有日 K 可聚合的兜底：东财没给就返回空，绝不能拿日 K 冒充分钟 K
  function aggregateRowsShape(rows, interval, count) {
    if (isMinInterval(interval)) return [];
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
    // 分时（列表小折线）：东财特殊品种 / 外盘期货 / em 指数统一走 fetchMinuteSeries，
    // 里面已经包含东财 trends2 → 新浪 / 上金所的兜底。
    if (period === 'minute') {
      const secid = EM_SECID[code] || HF_EM_SECID[code] || emIndexSecid(code);
      if (secid) return fetchMinuteSeries(code);
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
    Object.keys(csiInfoCache).forEach(function (key) { delete csiInfoCache[key]; });
    Object.keys(csiQuoteCache).forEach(function (key) { delete csiQuoteCache[key]; });
    qtHostIdx = 0;
    sinaFallbackLogged = false;
  }

  return {
    fetchSnapshots,
    fetchSinaSnapshots,
    fetchCsindexInfo,
    fetchCsindexQuote,
    fetchTencentJson,
    searchSymbols,
    fetchMinuteSeries,
    fetchForeignMinute,
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
