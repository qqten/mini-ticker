'use strict';

// 新浪只认 sh / sz / bj 前缀，港股美股它的 K 线接口返回 null
function sinaSupported(code) {
  return /^(sh|sz|bj)/i.test(code);
}

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

function isFundCode(code) {
  return /^\d{6}$/.test(String(code || ''));
}

// 东财专属指数（腾讯 / 新浪都没有，例如中证 931787）。
// 内部代码统一写成 em + 6 位数字，对应的东财 secid 固定是 2.xxxxxx。
function emIndexSecid(code) {
  const m = /^em(\d{6})$/i.exec(String(code || ''));
  return m ? '2.' + m[1] : '';
}

function isEmIndexCode(code) {
  return !!emIndexSecid(code);
}

// 港股比 A 股晚一小时收盘（16:00 对 15:00）。这个判断同时用于：
// 分时图的横轴 / 交易日槽位、自选含港股时的收盘自动退出、自动启动补跑。
// 东财的 em 指数 secid 不带市场信息（港股主题和内地中证指数都是 2.xxxxxx），
// 只能靠名称区分：中证香港系列指数的简称都以「港股 / 香港」开头。
function isHkName(name) {
  return /港股|香港/.test(String(name || ''));
}

function isHkSymbol(code, name) {
  if (/^hk/i.test(String(code || ''))) return true;
  return isEmIndexCode(code) && isHkName(name);
}

function isValidCode(c) {
  if (typeof c !== 'string') return false;
  return /^(sh|sz|bj|hk|us|hf|sge)[a-z0-9._]{1,12}$/i.test(c) ||
    /^\d{6}$/.test(c) || /^em\d{6}$/i.test(c);
}

// smartbox 返回的 name 是 \uXXXX 转义；个别情况直接是中文，两种都兼容
function unescapeUnicode(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
}

module.exports = {
  sinaSupported,
  sinaSymbol,
  isFundCode,
  emIndexSecid,
  isEmIndexCode,
  isHkName,
  isHkSymbol,
  isValidCode,
  unescapeUnicode,
  SINA_ALIAS
};
