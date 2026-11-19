'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseShareLink,
  normalizeShareData,
  shareStatusMessage,
  MARKET_PREFIX
} = require('../electron/core/share-import.cjs');
const { createShareImporter, ENDPOINT } = require('../electron/data/share-import.cjs');

const LINK = 'https://eq.10jqka.com.cn/operation/function/selfstock-share/webpage/index.html' +
  '?client_userid=CRCYD&share_hxapp=gsc&share_action=&back_source=hyperlink' +
  '#/index?id=4ECEHFF5180TN7Z&st=2&bk=574281983_35';

function payload(extra) {
  return {
    status_code: 0,
    data: Object.assign({
      group_name: 'ETF',
      share_name: 'ETF',
      share_ctime: 1793855645154,
      expired_at: 0,
      selfstock: [
        { market: '20', code: '513300' },
        { market: '36', code: '159855' },
        { market: '20', code: '510140' }
      ],
      share_meta: { biz: 'selfstock', biz_key: '574281983_35', meta_id: '4ECEHFF22L0SN7Z' }
    }, extra || {})
  };
}

test('parseShareLink 从 hash 里取 id / st / bk，并把 st=2 判成分组分享', function () {
  const parsed = parseShareLink(LINK);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.id, '4ECEHFF5180TN7Z');
  assert.equal(parsed.st, 2);
  assert.equal(parsed.shareType, 'selfgroup');
  assert.equal(parsed.bk, '574281983_35');
  assert.equal(parsed.idType, 'share');
  // ? 后面的归因参数不参与数据查询，也不该干扰 id
  assert.equal(parsed.from, 'sjcg_web');
});

test('parseShareLink 容忍只贴 hash 片段 / 只贴查询串', function () {
  assert.equal(parseShareLink('#/index?id=4ECEHFF5180TN7Z&st=2').shareType, 'selfgroup');
  assert.equal(parseShareLink('id=4ECEHFF5180TN7Z&st=1').shareType, 'selfstock');
});

test('parseShareLink 缺 id 或 id 形态不对时给出可读错误', function () {
  assert.equal(parseShareLink('').ok, false);
  assert.equal(parseShareLink('https://eq.10jqka.com.cn/#/index?st=2').msg, '链接里没有 id 参数，确认是完整的分享链接');
  assert.equal(parseShareLink('https://eq.10jqka.com.cn/#/index?id=短').msg, '链接里的 id 格式不对');
});

test('parseShareLink 按 st 区分自选 / 分组，source_type 优先', function () {
  assert.equal(parseShareLink('id=4ECEHFF5180TN7Z').shareType, 'selfstock');
  assert.equal(parseShareLink('id=4ECEHFF5180TN7Z&st=1').shareType, 'selfstock');
  assert.equal(parseShareLink('id=4ECEHFF5180TN7Z&st=1&source_type=UGC_SELF_GROUP').shareType, 'selfgroup');
});

test('normalizeShareData 给已知市场补交易所前缀，并保序去重', function () {
  const data = normalizeShareData(payload(), parseShareLink(LINK));
  assert.equal(data.ok, true);
  assert.equal(data.groupName, 'ETF');
  assert.equal(data.bizKey, '574281983_35');
  assert.equal(data.metaId, '4ECEHFF22L0SN7Z');
  assert.deepEqual(data.items.map(function (it) { return it.symbol; }), ['sh513300', 'sz159855', 'sh510140']);
  assert.deepEqual(data.items.map(function (it) { return it.order; }), [1, 2, 3]);
  assert.equal(data.counts.ready, 3);
  assert.equal(data.counts.duplicate, 0);
});

test('normalizeShareData 未识别市场保留原始代码、不硬套前缀', function () {
  const data = normalizeShareData(payload({
    selfstock: [
      { market: '20', code: '513300' },
      { market: '48', code: '00700' },
      { market: '20', code: '513300' }
    ]
  }), parseShareLink(LINK));
  assert.equal(data.items.length, 2);
  assert.equal(data.items[1].symbol, '');
  assert.equal(data.items[1].mapped, false);
  assert.equal(data.counts.ready, 1);
  assert.equal(data.counts.unmapped, 1);
  assert.equal(data.counts.duplicate, 1);
});

test('normalizeShareData 识别自选分享里的沪深 A 股与上海指数代码', function () {
  const data = normalizeShareData(payload({
    selfstock: [
      { market: '17', code: '600585' },
      { market: '17', code: '601728' },
      { market: '33', code: '000541' },
      { market: '33', code: '300033' },
      { market: '16', code: '1A0001' },
      { market: '16', code: '1B0300' }
    ]
  }), parseShareLink(LINK));
  assert.deepEqual(data.items.map(function (it) { return it.symbol; }), [
    'sh600585', 'sh601728', 'sz000541', 'sz300033', 'sh000001', 'sh000300'
  ]);
  assert.equal(data.counts.ready, 6);
  assert.equal(data.counts.unmapped, 0);
});

test('normalizeShareData 过滤空代码，分组名缺失时给兜底名', function () {
  const data = normalizeShareData(payload({
    group_name: '   ',
    share_name: '',
    selfstock: [{ market: '20', code: '' }, { market: '20' }]
  }), parseShareLink(LINK));
  assert.equal(data.items.length, 0);
  assert.equal(data.counts.invalid, 2);
  assert.equal(data.groupName, '分组');
});

test('normalizeShareData 截断超长分组名到 24 个字', function () {
  const longName = '这是一个特别特别特别特别长的分组名字用来测试截断';
  const data = normalizeShareData(payload({ group_name: longName }), parseShareLink(LINK));
  assert.equal(data.groupName.length, 24);
});

test('shareStatusMessage 覆盖分享失效的几种状态码', function () {
  assert.equal(shareStatusMessage(30001), '分享不存在或者已过期');
  assert.equal(shareStatusMessage(30003), '该分组已被作者删除');
  assert.equal(shareStatusMessage(-10006), '分组已被删除');
  assert.match(shareStatusMessage(99999), /状态码 99999/);
});

test('createShareImporter 分组分享打 selfgroup 接口并带上 id', async function () {
  const calls = [];
  const http = {
    fetchJson: async function (url, options) {
      calls.push({ url: url, options: options });
      return payload();
    }
  };
  const importer = createShareImporter({ http: http });
  const result = await importer.resolve(LINK);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.indexOf(ENDPOINT.selfgroup + '?') === 0);
  assert.ok(calls[0].url.indexOf('id=4ECEHFF5180TN7Z') > 0);
  assert.ok(calls[0].url.indexOf('id_type=share') > 0);
  assert.ok(calls[0].url.indexOf('support_all=1') > 0);
  assert.match(calls[0].options.headers.Referer, /eq\.10jqka\.com\.cn/);
});

test('createShareImporter 自选分享走 selfstock 接口', async function () {
  const urls = [];
  const http = {
    fetchJson: async function (url) {
      urls.push(url);
      return payload({ group_name: '', share_name: '', selfstock: [{ market: '17', code: '600519' }] });
    }
  };
  const result = await createShareImporter({ http: http }).resolve('id=4ECEHFF5180TN7Z&st=1');
  assert.equal(result.ok, true);
  assert.ok(urls[0].indexOf(ENDPOINT.selfstock) === 0);
  assert.equal(result.items[0].symbol, 'sh600519');
  assert.equal(result.groupName, '自选');
});

test('createShareImporter 把接口状态码翻成可读提示', async function () {
  const http = {
    fetchJson: async function () {
      return { status_code: 30001, data: null };
    }
  };
  const result = await createShareImporter({ http: http }).resolve(LINK);
  assert.equal(result.ok, false);
  assert.equal(result.msg, '分享不存在或者已过期');
});

test('createShareImporter 网络异常和畸形返回都不会抛到渲染层', async function () {
  const boom = {
    fetchJson: async function () { throw new Error('fetch failed'); }
  };
  const failed = await createShareImporter({ http: boom }).resolve(LINK);
  assert.equal(failed.ok, false);
  assert.match(failed.msg, /读取分享失败：fetch failed/);

  const weird = {
    fetchJson: async function () { return { data: null }; }
  };
  const bad = await createShareImporter({ http: weird }).resolve(LINK);
  assert.equal(bad.ok, false);
  assert.equal(bad.msg, '接口返回格式不对');
});

test('市场映射只包含已经验证过的六个市场号', function () {
  assert.deepEqual(Object.keys(MARKET_PREFIX).sort(), ['16', '17', '20', '32', '33', '36']);
  assert.equal(MARKET_PREFIX['17'], 'sh');
  assert.equal(MARKET_PREFIX['20'], 'sh');
  assert.equal(MARKET_PREFIX['33'], 'sz');
  assert.equal(MARKET_PREFIX['36'], 'sz');
});
