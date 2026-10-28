(function () {
  'use strict';

  /* 聚焦图表：画在原浮窗里（不另开窗口），背景保持透明，
     文字用 CSS 变量取当前亮/暗配色的颜色 + 描边光晕，压在任何桌面上都能看清。 */

  var state = { on: false, code: '', tab: 'minute', index: -1, total: 0, name: '' };
  var payload = null;
  var timer = null;
  var seq = 0;
  var resizeTimer = null;

  var panel = document.getElementById('focus');
  var chartEl = document.getElementById('chart');
  var elName = document.getElementById('f-name');
  var elZoom = document.getElementById('f-zoom');
  var tabsEl = document.getElementById('f-tabs');
  var appEl = document.getElementById('app');
  // 上一次点亮的是哪一行：用来判断「换标的了」，只在这时把行滚进视野
  var lastActive = '';

  /* 缩放窗口：s/e 是整幅横向的归一化区间，0..1 就是全部铺满。
     滚轮以光标为不动点收缩/展开，纵轴跟着可见数据重新拟合；
     换标的、换周期、双击图表都会回到 0..1。 */
  var view = { s: 0, e: 1 };
  function resetView() { view.s = 0; view.e = 1; }
  function zoomRatio() { return 1 / Math.max(1e-6, view.e - view.s); }
  function isZoomed() { return view.e - view.s < 0.999; }

  /* ---------------- 小工具 ---------------- */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fx(v, d) { return isNum(v) ? v.toFixed(d == null ? 2 : d) : '--'; }
  function fPct(v) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) + '%' : '--'; }
  function fChg(v) { return isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(2) : '--'; }
  // 指数两位小数就够，几块钱的 ETF / 场外基金要四位
  function fPrice(v) {
    if (!isNum(v)) return '--';
    return v.toFixed(Math.abs(v) < 10 ? 4 : 2);
  }
  function fVol(v) {
    if (!isNum(v)) return '--';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(Math.round(v));
  }

  // 每次绘制都重新取一遍：自动配色切换后，线条颜色要跟着变
  function theme() {
    var cs = getComputedStyle(document.body);
    function v(name, dft) {
      var x = cs.getPropertyValue(name).trim();
      return x || dft;
    }
    return {
      up: v('--up', '#ff3b46'),
      down: v('--down', '#0fb87a'),
      line: v('--chart-line', '#3ba7ff'),
      avg: v('--chart-avg', '#f2c14e'),
      ma10: v('--chart-ma10', '#7aa2f7'),
      ma20: v('--chart-ma20', '#c586f0'),
      grid: v('--chart-grid', 'rgba(255,255,255,.1)'),
      sub: v('--sub', '#9aa4b2')
    };
  }

  function txt(x, y, s, anchor, color, size) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" fill="' + (color || 'currentColor') +
      '" font-size="' + (size || 10) + '" text-anchor="' + (anchor || 'start') + '">' + s + '</text>';
  }

  function empty(msg) {
    chartEl.innerHTML = '<div class="empty">' + msg + '</div>';
  }

  // 横轴文字：靠边的换成 start/end 锚点贴到边上，否则会被面板边缘切掉半截
  function axisLabel(x, y, str, W, color) {
    if (x > W - 18) return txt(W - TICK_INSET, y, str, 'end', color);
    if (x < 18) return txt(TICK_INSET, y, str, 'start', color);
    return txt(x, y, str, 'middle', color);
  }

  function shortDate(d) {
    var s = String(d || '');
    if (/^\d{8}$/.test(s)) return s.slice(4, 6) + '-' + s.slice(6, 8);
    return s.length >= 10 ? s.slice(5, 10) : s;
  }

  // 分钟时间归一：A 股 "0930" -> "09:30"，外盘 "2026-10-26 05:00" -> "05:00"
  function fmtTime(t) {
    var s = String(t || '');
    var m = s.match(/(\d{2}):?(\d{2})$/);
    return m ? m[1] + ':' + m[2] : s;
  }

  // pts 按 x 有序，二分找离目标索引最近的那个点（缩放后画横轴标签用）
  function nearestPt(pts, i) {
    var a = 0, b = pts.length - 1;
    while (a < b) {
      var mid = (a + b) >> 1;
      if (pts[mid].x < i) a = mid + 1; else b = mid;
    }
    var p1 = pts[Math.max(0, a - 1)], p2 = pts[Math.min(pts.length - 1, a)];
    return Math.abs(p1.x - i) <= Math.abs(p2.x - i) ? p1 : p2;
  }

  /* ---------------- 十字光标数值提示 ---------------- */

  var tipCtx = null;   // 当前图的数据/坐标上下文，由 render 末尾赋值
  var tip = document.createElement('div');
  tip.id = 'f-tip';
  document.body.appendChild(tip);

  // 十字线骨架：render 时预置进 SVG（默认隐藏），mousemove 只改坐标
  function crosshairSvg(g) {
    return '<g id="f-cross" opacity="0" pointer-events="none">' +
      '<line class="cx" x1="0" y1="0" x2="0" y2="0" stroke="#8b94a3" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<line class="cy" x1="0" y1="0" x2="0" y2="0" stroke="#8b94a3" stroke-width="1" stroke-dasharray="3 3"/>' +
      '</g>';
  }

  function hideTip() {
    tip.style.display = 'none';
    var cross = chartEl.querySelector('#f-cross');
    if (cross) cross.setAttribute('opacity', '0');
  }

  function showTip(info, mx, my) {
    var c = tipCtx;
    if (!c) return;
    var cross = chartEl.querySelector('#f-cross');
    if (cross) {
      cross.setAttribute('opacity', '1');
      var lx = cross.querySelector('.cx');
      var ly = cross.querySelector('.cy');
      lx.setAttribute('x1', info.x.toFixed(1));
      lx.setAttribute('x2', info.x.toFixed(1));
      lx.setAttribute('y1', c.g.priceTop.toFixed(1));
      lx.setAttribute('y2', c.g.volBot.toFixed(1));
      ly.setAttribute('x1', c.g.padL.toFixed(1));
      ly.setAttribute('x2', (c.g.padL + c.g.plotW).toFixed(1));
      ly.setAttribute('y1', info.y.toFixed(1));
      ly.setAttribute('y2', info.y.toFixed(1));
    }
    tip.innerHTML = info.lines.join('<br/>');
    tip.style.display = 'block';
    // 悬浮框跟鼠标走，贴右侧放不下就翻到左侧；fixed 定位用视口坐标
    var tw = tip.offsetWidth;
    var x = mx + 14;
    if (x + tw > window.innerWidth - 8) x = mx - tw - 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, my - tip.offsetHeight / 2) + 'px';
  }

  // 分时/5日：按 x 找最近数据点
  function tipMinute(c, sx, sy) {
    if (sx < c.g.padL || sx > c.g.padL + c.g.plotW) return null;
    if (sy < c.g.priceTop || sy > c.g.volBot) return null;
    var i = c.xs + ((sx - c.g.padL) / c.g.plotW) * (c.xe - c.xs);
    i = Math.max(0, Math.min(c.total - 1, i));
    var best = nearestPt(c.pts, i);
    var dIdx = Math.floor(best.x / c.session);
    var t = fmtTime(best.t || '');
    var date = c.days[dIdx] ? shortDate(c.days[dIdx].date) : '';
    var head = c.days.length > 1 ? (date + ' ' + t) : t;
    var chg = (isNum(c.prec) && c.prec > 0) ? (best.p - c.prec) / c.prec * 100 : NaN;
    return {
      lines: [
        head,
        '价 ' + fPrice(best.p),
        '涨跌 ' + fChg(best.p - c.prec) + '  ' + fPct(chg),
        '量 ' + fVol(best.v)
      ],
      x: c.X(best.x),
      y: c.Y(best.p)
    };
  }

  // 日K：按 x 命中所在 K 线
  function tipDay(c, sx, sy) {
    if (sx < c.g.padL || sx > c.g.padL + c.g.plotW) return null;
    var n = c.rows.length;
    var i = Math.floor(c.xs + (sx - c.g.padL) / c.step);
    i = Math.max(c.i0, Math.min(c.i1, Math.min(n - 1, i)));
    var r = c.rows[i];
    var chg = r.o > 0 ? (r.c - r.o) / r.o * 100 : NaN;
    return {
      lines: [
        String(r.d || ''),
        '开 ' + fPrice(r.o) + '   收 ' + fPrice(r.c),
        '高 ' + fPrice(r.h) + '   低 ' + fPrice(r.l),
        '涨跌 ' + fChg(r.c - r.o) + '  ' + fPct(chg),
        '量 ' + fVol(r.v)
      ],
      x: c.Xc(i),
      y: c.Y(r.h)
    };
  }

  // 均线：简单移动平均，前 n-1 个点没有值
  function ma(arr, n) {
    var out = [], sum = 0;
    for (var i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      out.push(i >= n - 1 ? sum / n : NaN);
    }
    return out;
  }

  function ema(arr, n) {
    var k = 2 / (n + 1), out = [], prev = arr[0];
    for (var i = 0; i < arr.length; i++) {
      prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  /* ---------------- 版面 ---------------- */

  var TICK_PAD = 9;   // 绘图区左右最小内缩：刻度文字就画在这条缝上（贴面板边）
  var TICK_INSET = 3; // 刻度文字距面板左/右边缘的像素

  function geom(withMacd) {
    // 内边距从样式里读，宽度就是真实可用宽度，不再用写死的 -10 去猜
    var cs = getComputedStyle(chartEl);
    function px(k) { return parseFloat(cs[k]) || 0; }
    var W = Math.max(260, Math.round(chartEl.clientWidth - px('paddingLeft') - px('paddingRight')));
    var H = Math.max(120, Math.round(chartEl.clientHeight - px('paddingTop') - px('paddingBottom')));

    // 刻度贴边：文字直接画在绘图区上、贴着面板左右边，只留一条 9px 的缝。
    // 以前写死 padL=54 / padR=44 装刻度，面板只有 300 多像素时两边吃掉三分之一。
    var padL = TICK_PAD;
    var padR = TICK_PAD;

    var padT = 6, axisH = 16, gap = 7;
    var body = H - padT - axisH - gap * (withMacd ? 2 : 1);
    var volH = Math.round(body * (withMacd ? 0.2 : 0.24));
    var macdH = withMacd ? Math.round(body * 0.22) : 0;
    var priceH = body - volH - macdH;

    var g = {
      W: W, H: H, padL: padL, padR: padR, plotW: W - padL - padR,
      priceTop: padT, priceH: priceH, priceBot: padT + priceH,
      volTop: padT + priceH + gap, volH: volH,
      axisY: H - 4
    };
    g.volBot = g.volTop + volH;
    if (withMacd) {
      g.macdTop = g.volBot + gap;
      g.macdH = macdH;
      g.macdBot = g.macdTop + macdH;
    }
    return g;
  }

  /* ---------------- 分时 / 5日 ---------------- */

  function sessionTicks(code, session) {
    if (/^hk/i.test(code)) {
      return [[0, '09:30'], [100, '11:00'], [182, '13:00'], [272, '15:00'], [session - 1, '16:00']];
    }
    if (/^us/i.test(code)) {
      return [[0, '09:30'], [120, '11:30'], [212, '13:00'], [322, '15:00'], [session - 1, '16:00']];
    }
    return [[0, '09:30'], [60, '10:30'], [120, '13:00'], [180, '14:00'], [session - 1, '15:00']];
  }

  function renderMinute(p) {
    var days = p.days || [];
    if (!days.length) return empty('暂无分时数据');
    var T = theme();

    var session = p.session || 242;
    var total = session * days.length;
    var pts = [];

    for (var d = 0; d < days.length; d++) {
      var arr = days[d].points || [];
      var prec = days[d].prec;
      for (var i = 0; i < arr.length; i++) {
        pts.push({
          x: d * session + i,
          p: arr[i].price,
          v: arr[i].vol,
          a: arr[i].avg,
          prec: prec,
          first: i === 0,
          t: arr[i].t || ''
        });
      }
    }
    if (pts.length < 2) return empty('暂无分时数据');

    // 可见窗口：把 0..1 的缩放区间换成索引区间（浮点，贴边更自然）
    var xs = view.s * (total - 1);
    var xe = view.e * (total - 1);
    if (xe - xs < 1) xe = xs + 1;

    var lo = Infinity, hi = -Infinity, maxV = 0, sumV = 0;
    for (var k = 0; k < pts.length; k++) {
      // 缩放后纵轴只按看得见的那段拟合：放大到某个时段，那一小段的波动才看得清
      if (pts[k].x < xs || pts[k].x > xe) continue;
      if (pts[k].p < lo) lo = pts[k].p;
      if (pts[k].p > hi) hi = pts[k].p;
      if (pts[k].v > maxV) maxV = pts[k].v;
      sumV += pts[k].v;
    }
    if (!isFinite(hi) || !isFinite(lo)) return empty('暂无分时数据');
    if (!(hi > lo)) { hi += 1; lo -= 1; }
    var padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;

    // 右侧涨跌幅刻度：和左边价格刻度是同一个 hi/lo，先算好，等下一起画
    var lastPrec = p.prevClose;
    var pctTicks = [];
    if (isNum(lastPrec) && lastPrec > 0) {
      pctTicks = [fPct(((hi - lastPrec) / lastPrec) * 100), fPct(((lo - lastPrec) / lastPrec) * 100)];
    }
    var g = geom(false);

    var X = function (i) { return g.padL + ((i - xs) / (xe - xs)) * g.plotW; };
    var Y = function (v) { return g.priceBot - ((v - lo) / (hi - lo)) * g.priceH; };
    var VY = function (v) { return g.volBot - (maxV ? (v / maxV) * g.volH : 0); };

    var s = ['<svg width="' + g.W + '" height="' + g.H + '" viewBox="0 0 ' + g.W + ' ' + g.H + '">'];

    // 昨收虚线 + 5日分隔：缩放后可能只露出一段，裁到绘图区内再画
    var leftEdge = g.padL, rightEdge = g.padL + g.plotW;
    for (var dd = 0; dd < days.length; dd++) {
      var pc = days[dd].prec;
      var dx0 = dd * session;
      var dx1 = dd * session + Math.max(1, (days[dd].points || []).length - 1);
      if (dx1 < xs || dx0 > xe) continue;
      if (isNum(pc) && pc > 0) {
        var yb = Y(pc);
        var lx0 = Math.max(leftEdge, X(dx0));
        var lx1 = Math.min(rightEdge, X(dx1));
        if (lx1 > lx0) {
          s.push('<line x1="' + lx0.toFixed(1) + '" y1="' + yb.toFixed(1) + '" x2="' + lx1.toFixed(1) +
            '" y2="' + yb.toFixed(1) + '" stroke="' + T.sub + '" stroke-width="1" stroke-dasharray="2 3" opacity=".45"/>');
        }
      }
      if (dd > 0 && dx0 > xs && dx0 < xe) {
        s.push('<line x1="' + X(dx0).toFixed(1) + '" y1="' + g.priceTop + '" x2="' + X(dx0).toFixed(1) +
          '" y2="' + g.volBot + '" stroke="' + T.grid + '" stroke-dasharray="2 4"/>');
      }
    }

    // 成交量柱：与上一分钟比价定色，当天第一根和昨收比
    var bw = Math.max(1, Math.min(12, (g.plotW / (xe - xs + 1)) * 0.7));
    for (var b = 0; b < pts.length; b++) {
      if (pts[b].x < xs - 1 || pts[b].x > xe + 1) continue;
      var ref = pts[b].first ? pts[b].prec : pts[b - 1].p;
      var col = pts[b].p >= ref ? T.up : T.down;
      var y = VY(pts[b].v);
      var h = Math.max(0.6, g.volBot - y);
      s.push('<rect x="' + (X(pts[b].x) - bw / 2).toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + col + '" opacity=".8"/>');
    }

    // 价格线 + 均价线
    var linePts = [], avgPts = [];
    for (var n = 0; n < pts.length; n++) {
      if (pts[n].x < xs - 1 || pts[n].x > xe + 1) continue;
      var xx = X(pts[n].x).toFixed(1);
      linePts.push(xx + ',' + Y(pts[n].p).toFixed(1));
      if (isNum(pts[n].a)) avgPts.push(xx + ',' + Y(pts[n].a).toFixed(1));
    }
    if (avgPts.length > 1) {
      s.push('<polyline points="' + avgPts.join(' ') + '" fill="none" stroke="' + T.avg +
        '" stroke-width="1" opacity=".9"/>');
    }
    s.push('<polyline points="' + linePts.join(' ') + '" fill="none" stroke="' + T.line +
      '" stroke-width="1.3" stroke-linejoin="round"/>');

    // 价格刻度（左）：贴在面板左边缘，画在图上
    s.push(txt(TICK_INSET, g.priceTop + 9, fx(hi), 'start', T.sub));
    s.push(txt(TICK_INSET, g.priceBot - 1, fx(lo), 'start', T.sub));

    // 涨跌幅刻度（右）
    if (pctTicks.length) {
      s.push(txt(g.W - TICK_INSET, g.priceTop + 9, pctTicks[0], 'end', T.sub));
      s.push(txt(g.W - TICK_INSET, g.priceBot - 1, pctTicks[1], 'end', T.sub));
      var y0 = Y(lastPrec);
      if (y0 > g.priceTop + 16 && y0 < g.priceBot - 6) {
        s.push(txt(g.W - TICK_INSET, y0 + 3, '0%', 'end', T.sub));
      }
    }

    // 成交量总量：放量区左上，别贴右边的涨跌幅刻度（会挤在一起看不清）
    s.push(txt(g.padL + 2, g.volTop + 9, '量 ' + fVol(sumV), 'start', T.sub, 9));

    // 横轴：没缩放时沿用固定刻度（整点 / 整天）；缩放后按可见窗口取几个真实时间点
    if (!isZoomed()) {
      if (days.length > 1) {
        for (var q = 0; q < days.length; q++) {
          var cx = X(q * session + Math.floor(session / 2));
          s.push(axisLabel(cx, g.axisY, shortDate(days[q].date), g.W, T.sub));
        }
      } else {
        var ticks = sessionTicks(p.code, session);
        var right = g.W - g.padR;
        for (var t = 0; t < ticks.length; t++) {
          var tx = Math.max(g.padL, Math.min(right, X(ticks[t][0])));
          // 首尾两个刻度贴边，改锚点避免超出绘图区
          var anchor = tx <= g.padL + 2 ? 'start' : tx >= right - 2 ? 'end' : 'middle';
          s.push(txt(tx, g.axisY, ticks[t][1], anchor, T.sub));
        }
      }
    } else {
      // 5 日图缩放后得带上日期，字长一截，少放两个免得糊成一片
      var nLbl = days.length > 1 ? 3 : 5;
      var lbls = [];
      for (var z = 0; z < nLbl; z++) {
        var zp = nearestPt(pts, xs + ((xe - xs) * z) / (nLbl - 1));
        var zd = days[Math.floor(zp.x / session)];
        var zs2 = days.length > 1
          ? shortDate(zd && zd.date) + ' ' + fmtTime(zp.t)
          : fmtTime(zp.t);
        lbls.push({ x: Math.max(g.padL, Math.min(g.W - TICK_INSET, X(zp.x))), s: zs2, w: zs2.length * 5.4 });
      }
      // 窗口很窄时几个标签会挤到一起：从右往左留，先丢掉中间那些，
      // 首尾两个（本窗口的起止时间）一定留着
      var kept = [], rightBound = Infinity;
      for (var L = lbls.length - 1; L >= 0; L--) {
        var it = lbls[L];
        var lx = it.x > g.W - 18 ? it.x - it.w : (it.x < 18 ? it.x : it.x - it.w / 2);
        if (lx + it.w > rightBound - 6) continue;
        kept.push(it);
        rightBound = lx;
      }
      for (var K = kept.length - 1; K >= 0; K--) {
        s.push(axisLabel(kept[K].x, g.axisY, kept[K].s, g.W, T.sub));
      }
    }

    s.push(crosshairSvg(g));
    s.push('</svg>');
    chartEl.innerHTML = s.join('');
    tipCtx = { type: 'minute', g: g, X: X, Y: Y, pts: pts, days: days, session: session, total: total, prec: p.prevClose, xs: xs, xe: xe, dataEnd: pts[pts.length - 1].x / (total - 1) };
  }

  /* ---------------- 日K（K线 + 均线 + 成交量 + MACD） ---------------- */

  function renderDay(p) {
    var c = p.candles || [];
    if (c.length < 2) return empty('暂无 K 线数据');
    var T = theme();

    var closes = c.map(function (x) { return x.c; });
    var ma5 = ma(closes, 5), ma10 = ma(closes, 10), ma20 = ma(closes, 20);

    var e12 = ema(closes, 12), e26 = ema(closes, 26);
    var dif = closes.map(function (v, i) { return e12[i] - e26[i]; });
    var dea = ema(dif, 9);
    var macd = dif.map(function (v, i) { return (v - dea[i]) * 2; });

    var start = Math.max(0, c.length - 120);
    var rows = [];
    for (var i = start; i < c.length; i++) {
      rows.push({
        d: c[i].d, o: c[i].o, c: c[i].c, h: c[i].h, l: c[i].l, v: c[i].v,
        ma5: ma5[i], ma10: ma10[i], ma20: ma20[i],
        dif: dif[i], dea: dea[i], macd: macd[i]
      });
    }
    var n = rows.length;

    // 可见窗口（索引，浮点）：缩放后只画这一段，纵轴也按这段重新拟合
    var xs = view.s * (n - 1);
    var xe = view.e * (n - 1);
    if (xe - xs < 1) xe = xs + 1;
    var i0 = Math.max(0, Math.floor(xs));
    var i1 = Math.min(n - 1, Math.ceil(xe));

    var hi = -Infinity, lo = Infinity, maxV = 0, maxM = 0, sumV = 0;
    for (var k = i0; k <= i1; k++) {
      var r = rows[k];
      if (r.h > hi) hi = r.h;
      if (r.l < lo) lo = r.l;
      if (r.v > maxV) maxV = r.v;
      sumV += r.v;
      var m = Math.max(Math.abs(r.dif), Math.abs(r.dea), Math.abs(r.macd));
      if (m > maxM) maxM = m;
    }
    if (!isFinite(hi) || !isFinite(lo)) return empty('暂无 K 线数据');
    if (!(hi > lo)) { hi += 1; lo -= 1; }
    var padY = (hi - lo) * 0.06;
    hi += padY;
    lo -= padY;

    // 日K 右边没有刻度，padR 只剩最小空隙，K 线能一路铺到右边缘
    var g = geom(true);

    var step = g.plotW / (xe - xs);
    var cw = Math.max(1.2, Math.min(24, step * 0.66));
    var Xc = function (i) { return g.padL + step * (i - xs + 0.5); };
    var Y = function (v) { return g.priceBot - ((v - lo) / (hi - lo)) * g.priceH; };
    var VY = function (v) { return g.volBot - (maxV ? (v / maxV) * g.volH : 0); };
    var Mzero = g.macdTop + g.macdH / 2;
    var MY = function (v) { return Mzero - (maxM ? (v / maxM) * (g.macdH / 2 - 2) : 0); };

    var s = ['<svg width="' + g.W + '" height="' + g.H + '" viewBox="0 0 ' + g.W + ' ' + g.H + '">'];

    // 淡网格
    [0.25, 0.5, 0.75].forEach(function (rr) {
      var yy = g.priceTop + g.priceH * rr;
      s.push('<line x1="' + g.padL + '" y1="' + yy.toFixed(1) + '" x2="' + (g.padL + g.plotW) +
        '" y2="' + yy.toFixed(1) + '" stroke="' + T.grid + '"/>');
    });

    // 成交量
    for (var v = 0; v < n; v++) {
      if (v < i0 - 1 || v > i1 + 1) continue;
      var rr = rows[v];
      var col = rr.c >= rr.o ? T.up : T.down;
      var vy = VY(rr.v);
      s.push('<rect x="' + (Xc(v) - cw / 2).toFixed(1) + '" y="' + vy.toFixed(1) + '" width="' +
        cw.toFixed(1) + '" height="' + Math.max(0.6, g.volBot - vy).toFixed(1) +
        '" fill="' + col + '" opacity=".75"/>');
    }

    // K 线
    for (var i2 = 0; i2 < n; i2++) {
      if (i2 < i0 - 1 || i2 > i1 + 1) continue;
      var q = rows[i2];
      var cc = q.c >= q.o ? T.up : T.down;
      var x = Xc(i2);
      s.push('<line x1="' + x.toFixed(1) + '" y1="' + Y(q.h).toFixed(1) + '" x2="' + x.toFixed(1) +
        '" y2="' + Y(q.l).toFixed(1) + '" stroke="' + cc + '" stroke-width="1"/>');
      var yTop = Y(Math.max(q.o, q.c));
      var yBot = Y(Math.min(q.o, q.c));
      s.push('<rect x="' + (x - cw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) + '" width="' +
        cw.toFixed(1) + '" height="' + Math.max(1, yBot - yTop).toFixed(1) + '" fill="' + cc + '"/>');
    }

    // 均线
    function lineOf(key, color, width) {
      var pts = [];
      for (var j = 0; j < n; j++) {
        if (j < i0 - 1 || j > i1 + 1) continue;
        if (isNum(rows[j][key])) pts.push(Xc(j).toFixed(1) + ',' + Y(rows[j][key]).toFixed(1));
      }
      if (pts.length < 2) return;
      s.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color +
        '" stroke-width="' + width + '" opacity=".9"/>');
    }
    lineOf('ma5', T.avg, 1);
    lineOf('ma10', T.ma10, 1);
    lineOf('ma20', T.ma20, 1);

    // MACD
    s.push('<line x1="' + g.padL + '" y1="' + Mzero.toFixed(1) + '" x2="' + (g.padL + g.plotW) +
      '" y2="' + Mzero.toFixed(1) + '" stroke="' + T.grid + '"/>');
    for (var m2 = 0; m2 < n; m2++) {
      if (m2 < i0 - 1 || m2 > i1 + 1) continue;
      var mv = rows[m2].macd;
      if (!isNum(mv)) continue;
      var y1 = MY(mv), y0 = Mzero;
      var top = Math.min(y0, y1), hgt = Math.max(0.6, Math.abs(y1 - y0));
      s.push('<rect x="' + (Xc(m2) - cw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' +
        cw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" fill="' + (mv >= 0 ? T.up : T.down) +
        '" opacity=".7"/>');
    }
    function macdLine(key, color) {
      var pts = [];
      for (var j = 0; j < n; j++) {
        if (j < i0 - 1 || j > i1 + 1) continue;
        if (isNum(rows[j][key])) pts.push(Xc(j).toFixed(1) + ',' + MY(rows[j][key]).toFixed(1));
      }
      if (pts.length < 2) return;
      s.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color +
        '" stroke-width="1" opacity=".95"/>');
    }
    macdLine('dif', T.ma10);
    macdLine('dea', T.avg);

    // 刻度
    s.push(txt(TICK_INSET, g.priceTop + 9, fx(hi), 'start', T.sub));
    s.push(txt(TICK_INSET, g.priceBot - 1, fx(lo), 'start', T.sub));
    s.push(txt(g.padL + 2, g.volTop + 9, '量 ' + fVol(sumV), 'start', T.sub, 9));
    s.push(txt(g.padL + 2, g.macdTop + 8, 'MACD(12,26,9)', 'start', T.sub, 8.5));

    // 均线图例
    s.push(txt(g.padL + g.plotW - 112, g.priceTop + 9, 'MA5', 'start', T.avg, 9));
    s.push(txt(g.padL + g.plotW - 80, g.priceTop + 9, 'MA10', 'start', T.ma10, 9));
    s.push(txt(g.padL + g.plotW - 44, g.priceTop + 9, 'MA20', 'start', T.ma20, 9));

    // 横轴日期：按可见根数决定放几个，缩得很近时少放几个免得糊成一片
    var visN = xe - xs + 1;
    var cnt = visN >= 40 ? 5 : visN >= 18 ? 4 : Math.max(2, Math.min(3, Math.round(visN / 6)));
    for (var t = 0; t < cnt; t++) {
      var idx = Math.round(xs + (t * (xe - xs)) / (cnt - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      s.push(axisLabel(Xc(idx), g.axisY, shortDate(rows[idx].d), g.W, T.sub));
    }

    s.push(crosshairSvg(g));
    s.push('</svg>');
    chartEl.innerHTML = s.join('');
    tipCtx = { type: 'day', g: g, Xc: Xc, Y: Y, rows: rows, step: step, n: n, xs: xs, xe: xe, i0: i0, i1: i1 };
  }

  /* ---------------- 头部与行高亮 ---------------- */

  function paintHead(p) {
    // 头部只留票名：价格和涨跌幅在左边列表的当前行已经亮着，
    // 再写一遍既重复又把票名挤成「沪…」
    elName.textContent = p.name || p.code || state.name || '--';
  }

  function paintTabs(tab) {
    var bs = tabsEl.querySelectorAll('button[data-tab]');
    for (var i = 0; i < bs.length; i++) {
      bs[i].classList.toggle('on', bs[i].getAttribute('data-tab') === tab);
    }
  }

  // 当前聚焦的标的，在列表里点亮那一行
  function paintActiveRow(code) {
    if (!appEl) return;
    var rows = appEl.children;
    var hit = null;
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].dataset.code === code;
      rows[i].classList.toggle('active', on);
      if (on) hit = rows[i];
    }
    // 列表能滚动以后：键盘 ↑↓ 切到窗口外那行时，得把它带进视野。
    // 只在「换了标的」时滚，否则每轮刷新都会抢滚动条
    if (hit && code !== lastActive) {
      lastActive = code;
      if (hit.scrollIntoView) hit.scrollIntoView({ block: 'nearest' });
    }
    if (!hit) lastActive = '';
  }

  function render() {
    if (!state.on || !payload) return;
    hideTip();
    if (payload.tab === 'day') renderDay(payload);
    else renderMinute(payload);
  }

  /* ---------------- 数据 ---------------- */

  function load() {
    var mine = ++seq;
    return window.ticker.focusData().then(function (res) {
      if (mine !== seq || !state.on) return;
      if (!res || !res.ok) {
        document.body.classList.add('stale');
        empty(res && res.error ? '取数失败：' + res.error : '暂无数据');
        return;
      }
      document.body.classList.remove('stale');
      payload = res;
      paintHead(res);
      render();
    }).catch(function () {
      if (mine !== seq) return;
      document.body.classList.add('stale');
      empty('取数失败');
    });
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!state.on) return;
    var ms = state.tab === 'minute' ? 4000 : 20000;
    timer = setTimeout(function () {
      load().then(schedule);
    }, ms);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function applyMeta(s) {
    if (!s) return;
    var was = state.on;
    var sameTarget = state.code === s.code && state.tab === s.tab;
    state.on = !!s.on;
    state.code = s.code;
    state.tab = s.tab;
    state.index = s.index;
    state.total = s.total;
    state.name = s.name;

    document.body.classList.toggle('focus', state.on);
    // 左列保持展开前的宽度（主进程算的），右边剩下的全归图表
    if (s.leftW) document.body.style.setProperty('--left-w', Math.round(s.leftW) + 'px');
    // 换标的 / 换周期 = 换了张图，缩放回到整幅；只是尺寸变了则保留当前的缩放
    if (!sameTarget) { resetView(); syncZoomBadge(); }
    paintTabs(s.tab);
    paintActiveRow(s.code);

    if (!state.on) {
      stop();
      payload = null;
      tipCtx = null;
      resetView();
      syncZoomBadge();
      hideTip();
      chartEl.innerHTML = '';
      return;
    }
    // 只是窗口尺寸变了（同标的同周期）就别重新取数，按新宽度重画即可
    if (was && sameTarget && payload) {
      render();
      return;
    }
    load().then(schedule);
  }

  function logOpen() { /* 预留：窗口展开后的首帧重绘由 load 触发 */ }

  /* ---------------- 交互 ---------------- */

  tabsEl.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    e.stopPropagation();
    window.ticker.focusTab(b.getAttribute('data-tab'));
  });

  // 十字光标：鼠标在图上移动显示当时数据，移出图隐藏
  chartEl.addEventListener('mousemove', function (e) {
    if (!state.on || !tipCtx || !payload) return;
    var svg = chartEl.querySelector('svg');
    if (!svg) return;
    var rect = svg.getBoundingClientRect();
    var sx = e.clientX - rect.left;
    var sy = e.clientY - rect.top;
    var info = tipCtx.type === 'minute' ? tipMinute(tipCtx, sx, sy) : tipDay(tipCtx, sx, sy);
    if (!info) { hideTip(); return; }
    showTip(info, e.clientX, e.clientY);
  });
  chartEl.addEventListener('mouseleave', hideTip);

  /* ---------------- 滚轮缩放 ---------------- */

  // 头部那个 ×N 小标：缩放了才出现，双击图表还原
  function syncZoomBadge() {
    if (!elZoom) return;
    var on = isZoomed();
    elZoom.classList.toggle('on', on);
    if (!on) { elZoom.textContent = ''; return; }
    var r = zoomRatio();
    elZoom.textContent = (r >= 10 ? Math.round(r) : r.toFixed(1)) + '×';
  }

  chartEl.addEventListener('wheel', function (e) {
    if (!state.on || !tipCtx) return;
    e.preventDefault();
    var svg = chartEl.querySelector('svg');
    if (!svg) return;
    var g = tipCtx.g;
    var rect = svg.getBoundingClientRect();
    // 光标在绘图区的位置，换算成整幅的归一化坐标（0..1）
    var px = Math.max(g.padL, Math.min(g.padL + g.plotW, e.clientX - rect.left));
    // 盘中数据只画到当前时刻，右边那截是空的：光标落在空区就贴着数据末尾放大，
    // 否则会放大到一片空白（以前实测锚在 60% 宽度处就直接空白了）
    var dataEnd = Math.min(1, tipCtx.dataEnd || 1);
    var anchor = Math.min(view.s + ((px - g.padL) / Math.max(1, g.plotW)) * (view.e - view.s), dataEnd);

    var cur = view.e - view.s;
    var span = cur * (e.deltaY > 0 ? 1.3 : 1 / 1.3);
    // 至少留 12 根，再往里放就没东西可看了
    var total = tipCtx.total || tipCtx.n || 12;
    span = Math.min(1, Math.max(span, Math.min(1, 12 / Math.max(12, total))));

    // 以光标为不动点：光标下的那个点缩放前后停在同一个像素上
    var s0 = anchor - (anchor - view.s) * (span / cur);
    var s1 = s0 + span;
    if (anchor >= dataEnd - 1e-6) { s1 = dataEnd; s0 = s1 - span; }
    if (s0 < 0) { s1 -= s0; s0 = 0; }
    if (s1 > 1) { s0 -= (s1 - 1); s1 = 1; }
    if (s1 - s0 >= 0.999) resetView();
    else { view.s = Math.max(0, s0); view.e = Math.min(1, s1); }
    syncZoomBadge();
    render();
  }, { passive: false });

  // 双击还原整幅
  chartEl.addEventListener('dblclick', function () {
    if (!state.on || !tipCtx || !isZoomed()) return;
    resetView();
    syncZoomBadge();
    render();
  });

  document.addEventListener('keydown', function (e) {
    if (!state.on) return;
    var k = e.key;
    if (k === 'ArrowUp') { e.preventDefault(); window.ticker.focusStep(-1); }
    else if (k === 'ArrowDown') { e.preventDefault(); window.ticker.focusStep(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); cycleTab(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); cycleTab(1); }
    else if (k === '1') { window.ticker.focusTab('minute'); }
    else if (k === '2') { window.ticker.focusTab('five'); }
    else if (k === '3') { window.ticker.focusTab('day'); }
    else if (k === 'Escape') { e.preventDefault(); window.ticker.focusClose(); }
  });

  function cycleTab(dir) {
    var order = ['minute', 'five', 'day'];
    var i = order.indexOf(state.tab);
    if (i < 0) i = 0;
    i = (i + dir + order.length) % order.length;
    window.ticker.focusTab(order[i]);
  }

  window.ticker.onFocusState(applyMeta);

  window.addEventListener('resize', function () {
    if (!state.on) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  // 拖分界线时窗口尺寸没变，只是图表容器变宽/变窄，靠 ResizeObserver 逐帧重画
  var rafId = 0;
  var lastBoxW = 0;
  new ResizeObserver(function () {
    if (!state.on) return;
    var w = Math.round(chartEl.getBoundingClientRect().width);
    if (w === lastBoxW) return;
    lastBoxW = w;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      if (state.on) render();
    });
  }).observe(chartEl);

  // 自动配色切换后线条颜色要跟着换；文字靠 CSS 变量自己变，图里的是内联色，得重画
  var lastTheme = '';
  function themeKey() {
    return document.body.getAttribute('data-text') || 'light';
  }
  new MutationObserver(function () {
    var k = themeKey();
    if (k === lastTheme) return;
    lastTheme = k;
    render();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-text'] });

  /* ---------------- 启动 ---------------- */

  window.ticker.focusGet().then(applyMeta).catch(function () {});
})();
