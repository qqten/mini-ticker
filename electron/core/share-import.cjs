'use strict';

// 同花顺「关注分组」分享链接 -> 可导入的分组草稿。
//
// 分享页是 Vue SPA：hash 里的 id / st / bk 定位分享，主数据由页面自己的公开
// noauth 接口返回。这里只做「链接解析 + 返回结构规范化」：
//   - 不复制页面的登录态 / Cookie，只读用户主动贴进来的那一条分享；
//   - 不直接写配置，导入结果先交给设置面板做预览，保存仍走「保存并应用」。
// 网络请求在 data/share-import.cjs，保持 core 模块纯函数、可单测。

const GROUP_NAME_MAX = 24;
// 一个分组正常几十条，1000 足够兜住异常返回，避免把整页数据都塞进草稿。
const MAX_ITEMS = 1000;

// 同花顺市场号 -> 交易所前缀。
// 16 / 17 / 20 是上海（17 是 A 股，20 是基金 / ETF 子市场），
// 32 / 33 / 36 是深圳（33 是 A 股，36 是基金子市场）。
// 港股 / 美股 / 北交所 / 债券等市场还没有实测样本，先不猜：标记成「未识别」，
// 在预览里让用户自己决定，避免把代码硬套成错误的交易所。
const MARKET_PREFIX = {
  '16': 'sh', '17': 'sh', '20': 'sh',
  '32': 'sz', '33': 'sz', '36': 'sz'
};

// 页面里 status_code 的语义（bundle 里的分支 + 提示文案）。
const SHARE_ERRORS = {
  '30001': '分享不存在或者已过期',
  '30002': '分享已过期',
  '30003': '该分组已被作者删除',
  '30004': '没有权限查看这个分组',
  '-10006': '分组已被删除'
};

function str(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function decode(value) {
  try {
    return decodeURIComponent(String(value == null ? '' : value).replace(/\+/g, ' '));
  } catch (error) {
    return String(value == null ? '' : value);
  }
}

// 解析 a=b&c=d。允许整段是 "/index?id=..." 或 "?id=..."，只取 ? 之后。
function parsePairs(text) {
  const out = Object.create(null);
  if (!text) return out;
  let s = String(text);
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(q + 1);
  s = s.replace(/^[#?]+/, '');
  s.split('&').forEach(function (part) {
    if (!part) return;
    const i = part.indexOf('=');
    const key = decode(i < 0 ? part : part.slice(0, i));
    const value = i < 0 ? '' : decode(part.slice(i + 1));
    // 同名参数以第一个为准：分享链接里 id 只会出现一次，重复多半是粘贴了两段。
    if (key && !Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  });
  return out;
}

// 分享链接有两种参数：? 后面的分享归因参数（client_userid / share_hxapp …），
// 和 # 后面真正定位数据的 id / st / bk。两段都解析，hash 优先。
function parseShareLink(input) {
  const raw = str(input);
  if (!raw) return { ok: false, msg: '把同花顺分享链接粘进来' };

  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const hashPart = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  const outer = parsePairs(beforeHash.indexOf('=') >= 0 ? beforeHash : '');
  const inner = parsePairs(hashPart);

  const id = str(inner.id) || str(outer.id);
  if (!id) return { ok: false, msg: '链接里没有 id 参数，确认是完整的分享链接' };
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return { ok: false, msg: '链接里的 id 格式不对' };

  // st: 1 = 自选分享，2 = 分组分享；缺省按自选处理（和页面的 transformSt 一致）。
  const st = parseInt(str(inner.st) || str(outer.st) || '0', 10);
  const sourceType = str(inner.source_type) || str(outer.source_type);
  let shareType;
  if (sourceType === 'UGC_SELF_GROUP') shareType = 'selfgroup';
  else if (sourceType === 'UGC_SELF_STOCK') shareType = 'selfstock';
  else shareType = st === 2 ? 'selfgroup' : 'selfstock';

  return {
    ok: true,
    id: id,
    idType: str(inner.id_type) || str(outer.id_type) || 'share',
    st: isFinite(st) ? st : 0,
    shareType: shareType,
    bk: str(inner.bk) || str(outer.bk),
    from: 'sjcg_web'
  };
}

// 只有 6 位数字的 A 股 / ETF 代码才补前缀。补不上就返回空串，交给预览标成未识别。
function symbolOf(market, code) {
  const m = str(market);
  // 同花顺把上海指数写成 1A0001 / 1B0300 这类内部代码，
  // 转成应用内部使用的 sh000001 / sh000300。
  if (m === '16' && /^1[AB]\d{4}$/.test(code)) {
    return 'sh' + code.slice(2).padStart(6, '0');
  }
  const prefix = MARKET_PREFIX[m];
  if (prefix && /^\d{6}$/.test(code)) return prefix + code;
  return '';
}

// 接口返回结构（已实测）：
// { status_code: 0, data: { group_name, share_name, selfstock: [{market, code}], share_meta … } }
function normalizeShareData(payload, parsed) {
  const body = payload && payload.data;
  if (!body || typeof body !== 'object') return { ok: false, msg: '接口没有返回分享数据' };

  const rawList = Array.isArray(body.selfstock) ? body.selfstock : [];
  const type = (parsed && parsed.shareType) || 'selfgroup';
  const items = [];
  const seen = Object.create(null);
  let duplicate = 0;
  let unmapped = 0;
  let invalid = 0;

  rawList.slice(0, MAX_ITEMS).forEach(function (entry) {
    const market = str(entry && entry.market);
    const code = str(entry && entry.code).toUpperCase();
    if (!code) {
      invalid++;
      return;
    }
    const symbol = symbolOf(market, code);
    // 未识别的市场用 market:code 去重，避免不同市场同名代码被误合并。
    const key = symbol || market + ':' + code;
    if (seen[key]) {
      duplicate++;
      return;
    }
    seen[key] = true;
    if (!symbol) unmapped++;
    items.push({
      code: code,
      market: market,
      symbol: symbol,
      mapped: !!symbol,
      order: items.length + 1
    });
  });

  const name = str(body.group_name) || str(body.share_name) ||
    (type === 'selfgroup' ? '分组' : '自选');
  const meta = body.share_meta && typeof body.share_meta === 'object' ? body.share_meta : {};

  return {
    ok: true,
    source: '10jqka',
    shareType: type,
    shareId: str(parsed && parsed.id) || str(body.share_id),
    groupName: name.slice(0, GROUP_NAME_MAX),
    bizKey: str(meta.biz_key) || str(parsed && parsed.bk),
    metaId: str(meta.meta_id),
    createdAt: Number(body.share_ctime) || 0,
    // 0 表示分享没设过期时间；接口仍可能因为作者取消 / 删除而失效。
    expiredAt: Number(body.expired_at) || 0,
    total: rawList.length,
    items: items,
    counts: {
      total: rawList.length,
      ready: items.filter(function (item) { return item.mapped; }).length,
      duplicate: duplicate,
      unmapped: unmapped,
      invalid: invalid,
      truncated: Math.max(0, rawList.length - MAX_ITEMS)
    }
  };
}

function shareStatusMessage(code) {
  const key = String(code);
  if (SHARE_ERRORS[key]) return SHARE_ERRORS[key];
  return '读取分享失败（状态码 ' + key + '）';
}

module.exports = {
  GROUP_NAME_MAX,
  MAX_ITEMS,
  MARKET_PREFIX,
  SHARE_ERRORS,
  parseShareLink,
  normalizeShareData,
  shareStatusMessage
};
