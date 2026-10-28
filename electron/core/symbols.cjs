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

function isValidCode(c) {
  if (typeof c !== 'string') return false;
  return /^(sh|sz|bj|hk|us|hf)[a-z0-9._]{1,12}$/i.test(c) || /^\d{6}$/.test(c);
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
  isValidCode,
  unescapeUnicode,
  SINA_ALIAS
};
