'use strict';

function defaultFetch() {
  // Electron 的 net.fetch 走 Chromium 网络栈：自动继承系统代理、证书和 PAC，
  // 比 Node 的全局 fetch 更适合公司内网 / 代理环境。
  try {
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      return electron.net.fetch.bind(electron.net);
    }
  } catch (error) {
    // 单元测试在纯 Node 下跑，没有 electron 模块，落到全局 fetch。
  }
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('当前环境没有可用的 fetch');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isAbortError(error) {
  return !!error && (error.name === 'AbortError' || error.name === 'TimeoutError' ||
    error.code === 'ABORT_ERR' || error.code === 'ETIMEDOUT');
}

function normalizeRequestError(error, timeout) {
  if (isAbortError(error)) {
    const timeoutError = new Error('请求超时（' + timeout + 'ms）');
    timeoutError.code = 'ETIMEDOUT';
    timeoutError.cause = error;
    return timeoutError;
  }
  return error;
}

function createHttp(options) {
  options = options || {};
  const fetchImpl = options.fetchImpl || defaultFetch();
  const retryDelay = options.retryDelay != null ? options.retryDelay : 250;
  const inflight = new Map();

  async function request(url, requestOptions) {
    const opts = requestOptions || {};
    const timeout = opts.timeout > 0 ? opts.timeout : 4000;
    const retries = opts.retries >= 0 ? opts.retries : 1;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(function () {
        timedOut = true;
        controller.abort();
      }, timeout);
      try {
        const response = await fetchImpl(url, {
          method: opts.method || 'GET',
          headers: opts.headers,
          body: opts.body,
          signal: controller.signal
        });
        if (!response || typeof response !== 'object') {
          throw new Error('接口没有返回响应');
        }
        if (response.ok === false) {
          const statusError = new Error('HTTP ' + response.status);
          statusError.status = response.status;
          statusError.retryable = response.status === 429 || response.status >= 500;
          throw statusError;
        }
        if (typeof response.status === 'number' && (response.status < 200 || response.status >= 300)) {
          const statusError = new Error('HTTP ' + response.status);
          statusError.status = response.status;
          statusError.retryable = response.status === 429 || response.status >= 500;
          throw statusError;
        }
        return response;
      } catch (error) {
        // 有些实现 abort 后抛的是 TypeError('Failed to fetch')，靠计时器标志兜住，
        // 保证超时永远归类成 ETIMEDOUT，便于上层重试和日志。
        lastError = normalizeRequestError(timedOut ? { name: 'TimeoutError' } : error, timeout);
        const retryable = lastError.code === 'ETIMEDOUT' ||
          !lastError.status || lastError.retryable === true;
        if (attempt >= retries || !retryable) break;
        await sleep(retryDelay * Math.pow(2, attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('请求失败');
  }

  async function fetchText(url, fetchOptions) {
    const opts = fetchOptions || {};
    const response = await request(url, opts);
    let buffer;
    if (typeof response.arrayBuffer === 'function') {
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      buffer = Buffer.from(await response.text(), 'utf8');
    }
    const encoding = String(opts.encoding || 'utf8').toLowerCase();
    if (encoding === 'gbk' || encoding === 'gb18030') {
      try {
        return new TextDecoder('gbk').decode(buffer);
      } catch (error) {
        return buffer.toString('latin1');
      }
    }
    return buffer.toString('utf8');
  }

  function fetchGbk(url, headers, fetchOptions) {
    return fetchText(url, Object.assign({}, fetchOptions, { headers: headers, encoding: 'gbk' }));
  }

  async function fetchJson(url, fetchOptions) {
    const text = await fetchText(url, Object.assign({}, fetchOptions, { encoding: 'utf8' }));
    const head = text.trim().slice(0, 1);
    // 被 WAF 拦下时返回的是 HTML 挑战页（甚至 200 状态码），直接 JSON.parse 会抛 SyntaxError。
    if (head === '<') {
      const error = new Error('接口返回网页（疑似被拦截）');
      error.code = 'EWAF';
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      const parseError = new Error('接口返回不是有效 JSON');
      parseError.code = 'EPARSE';
      parseError.cause = error;
      throw parseError;
    }
  }

  // 同一时刻只允许一个同类请求在跑：轮询间隔比网络慢时，
  // 后来的调用直接复用前一个 Promise，避免请求叠加。
  function singleFlight(key, task) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve().then(task).finally(function () {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return {
    request,
    fetchText,
    fetchGbk,
    fetchJson,
    singleFlight,
    fetchImpl
  };
}

module.exports = { createHttp, defaultFetch };
