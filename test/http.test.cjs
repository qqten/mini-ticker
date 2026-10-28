'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttp } = require('../electron/data/http.cjs');

function response(body, status) {
  const code = status == null ? 200 : status;
  return {
    ok: code >= 200 && code < 300,
    status: code,
    arrayBuffer: async function () { return Buffer.from(body); },
    text: async function () { return String(body); }
  };
}

test('fetchJson 解析 JSON 并带上请求头和超时参数', async function () {
  const calls = [];
  const http = createHttp({
    fetchImpl: async function (url, options) {
      calls.push({ url: url, options: options });
      return response('{"ok":true}');
    }
  });

  const out = await http.fetchJson('https://example.com/a', {
    headers: { 'User-Agent': 'test' }, timeout: 1234
  });

  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['User-Agent'], 'test');
  assert.equal(typeof calls[0].options.signal.aborted, 'boolean');
});

test('fetchJson 遇到 WAF 网页返回 EWAF 而不是 JSON 语法错误', async function () {
  const http = createHttp({ fetchImpl: async function () { return response('<html>blocked</html>'); } });
  await assert.rejects(http.fetchJson('https://example.com/a'), function (error) {
    assert.equal(error.code, 'EWAF');
    return true;
  });
});

test('网络错误默认重试一次，第二次成功', async function () {
  let calls = 0;
  const http = createHttp({
    retryDelay: 0,
    fetchImpl: async function () {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET');
      return response('{"n":2}');
    }
  });

  assert.deepEqual(await http.fetchJson('https://example.com/a'), { n: 2 });
  assert.equal(calls, 2);
});

test('4xx 不重试，错误里保留状态码', async function () {
  let calls = 0;
  const http = createHttp({
    retryDelay: 0,
    fetchImpl: async function () {
      calls++;
      return response('missing', 404);
    }
  });

  await assert.rejects(http.fetchJson('https://example.com/a'), function (error) {
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(calls, 1);
});

test('5xx 会重试', async function () {
  let calls = 0;
  const http = createHttp({
    retryDelay: 0,
    fetchImpl: async function () {
      calls++;
      if (calls < 3) return response('oops', 503);
      return response('{"ok":1}');
    }
  });

  assert.deepEqual(await http.fetchJson('https://example.com/a', { retries: 2 }), { ok: 1 });
  assert.equal(calls, 3);
});

test('超时会被 AbortController 打断并转成 ETIMEDOUT', async function () {
  let calls = 0;
  const http = createHttp({
    fetchImpl: function (url, options) {
      calls++;
      return new Promise(function (resolve, reject) {
        options.signal.addEventListener('abort', function () {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
  });

  await assert.rejects(http.fetchText('https://example.com/slow', { timeout: 20, retries: 0 }),
    function (error) {
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    });
  assert.equal(calls, 1);
});

test('fetchGbk 按 GBK 解码', async function () {
  // “中国” 的 GBK 编码
  const gbk = Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]);
  const http = createHttp({
    fetchImpl: async function () {
      return { ok: true, status: 200, arrayBuffer: async function () { return gbk; } };
    }
  });
  assert.equal(await http.fetchGbk('https://example.com/gbk', {}), '中国');
});

test('singleFlight 合并同类并发请求，结束后释放', async function () {
  let calls = 0;
  let release;
  const http = createHttp({
    fetchImpl: async function () {
      calls++;
      await new Promise(function (resolve) { release = resolve; });
      return response('{"ok":1}');
    }
  });

  const first = http.singleFlight('quotes', function () { return http.fetchJson('https://example.com/a'); });
  const second = http.singleFlight('quotes', function () { return http.fetchJson('https://example.com/a'); });
  assert.equal(first, second);

  // 等任务真正开始
  await new Promise(function (resolve) { setImmediate(resolve); });
  release();
  assert.deepEqual(await first, { ok: 1 });
  assert.equal(calls, 1);

  // 结束后同一个 key 可以重新发起
  const third = http.singleFlight('quotes', async function () { return 42; });
  assert.equal(await third, 42);
});
