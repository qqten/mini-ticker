/* 首帧配色。
   主进程用 loadFile(..., { query }) 把「上次判定出来的配色」带进来，
   这里在 DOMContentLoaded 里先写一次 data-text —— 时机早于首帧绘制，
   所以不会出现"先按默认亮色字画一帧、等 get-state 回来才变暗"的闪烁。

   为什么不做成内联脚本：index.html 的 CSP 是 script-src 'self'，内联会被拦。
   为什么用 DOMContentLoaded：<head> 里执行时 body 还不存在。 */
(function () {
  var m = 'light';
  var bd = false;
  var bop = 40;
  try {
    var q = new URLSearchParams(location.search);
    m = q.get('text') === 'dark' ? 'dark' : 'light';
    bd = q.get('bd') === '1';
    var v = parseFloat(q.get('bop'));
    if (isFinite(v)) bop = v;
  } catch (e) {}

  function apply() {
    if (!document.body) return;
    document.body.setAttribute('data-text', m);
    if (bd) {
      document.body.classList.add('backdrop');
      document.body.style.setProperty('--bd-op', (Math.max(0, Math.min(95, bop)) / 100).toFixed(3));
    }
  }

  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply);
})();
