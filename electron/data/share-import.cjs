'use strict';

const { parseShareLink, normalizeShareData, shareStatusMessage } = require('../core/share-import.cjs');

// 同花顺分享页在「非 App 环境」下自己用的公开接口（页面代码里的 noauth 分支）。
// 这里只做一次只读请求：用户把分享链接贴进来 -> 读一次 -> 返回草稿给设置面板预览。
// 不带 Cookie、不带登录态，也不做轮询 / 批量抓取。
const ENDPOINT = {
  selfgroup: 'https://ugc.10jqka.com.cn/optdata/selfgroup/noauth/api/share/v1/query',
  selfstock: 'https://ugc.10jqka.com.cn/optdata/selfstock/noauth/api/share/v1/query'
};

// 接口对 UA / Referer 有要求：缺了会被当成普通脚本请求挡回去。
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://eq.10jqka.com.cn/',
  'Accept': 'application/json, text/plain, */*'
};

function createShareImporter(options) {
  const http = options && options.http;
  if (!http) throw new Error('createShareImporter 需要 http');

  async function resolve(link) {
    const parsed = parseShareLink(link);
    if (!parsed.ok) return parsed;

    const url = ENDPOINT[parsed.shareType] +
      '?id_type=' + encodeURIComponent(parsed.idType) +
      '&id=' + encodeURIComponent(parsed.id) +
      '&support_all=1' +
      '&from=' + encodeURIComponent(parsed.from);

    let payload;
    try {
      payload = await http.fetchJson(url, { headers: HEADERS, timeout: 8000, retries: 1 });
    } catch (error) {
      const message = error && error.message ? error.message : '网络错误';
      return { ok: false, msg: '读取分享失败：' + message };
    }

    if (!payload || typeof payload !== 'object') return { ok: false, msg: '接口没有返回数据' };
    const status = Number(payload.status_code);
    if (!isFinite(status)) return { ok: false, msg: '接口返回格式不对' };
    if (status !== 0) return { ok: false, msg: shareStatusMessage(status) };

    return normalizeShareData(payload, parsed);
  }

  return { resolve };
}

module.exports = { createShareImporter, ENDPOINT, HEADERS };
