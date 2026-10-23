(function () {
  var VW = 240, VH = 100, PAD = 7;

  var app = document.getElementById('app');
  var head = document.getElementById('head');
  head.innerHTML = '<span id="period-label"></span><svg id="pin-btn" width="10" height="12" viewBox="0 0 10 12" title="固定窗口（点击穿透，不可拖动）"><path d="M5 0C2.8 0 1 1.8 1 4c0 1.5.8 2.8 2 3.5V11l2-1.5V7.5c1.2-.7 2-2 2-3.5 0-2.2-1.8-4-2-4z"/></svg>';
  var periodLabel = document.getElementById('period-label');
  var rowMap = {};
  var PERIOD_LABEL = { minute: '分时', day: '日线', month: '月线', year: '年线' };
  var timer = null;
  var showBaseline = true;
  var currentPeriod = 'minute';
  var lastHeight = 0;
  var dragging = false;
  var lastList = [];

  var SPARK_SVG =
    '<svg class="spark" viewBox="0 0 240 100" preserveAspectRatio="none">' +
    '<line class="baseline" x1="0" y1="50" x2="240" y2="50"></line>' +
    '<polyline points=""></polyline>' +
    '</svg>';

  function colorVar(pct) {
    if (!isFinite(pct)) return 'var(--flat)';
    if (pct > 0) return 'var(--up)';
    if (pct < 0) return 'var(--down)';
    return 'var(--flat)';
  }

  function clsOf(pct) {
    return colorVar(pct).replace('var(--', '').replace(')', '');
  }

  function fmtPrice(v, isFund) {
    if (!isFinite(v)) return '--';
    return isFund ? v.toFixed(4) : v.toFixed(2);
  }

  function fmtPct(v) {
    if (!isFinite(v)) return '--';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  // 列表只报「上下多少点」，不再报绝对点位：+12.34 比 3714.48 更容易扫
  function fmtChange(v, isFund) {
    if (!isFinite(v)) return '--';
    return (v > 0 ? '+' : '') + v.toFixed(isFund ? 4 : 2);
  }

  function paintSpark(row, item) {
    var poly = row.poly;
    var base = row.base;
    var pts = item.points || [];
    var prev = item.prevClose;

    if (showBaseline) base.removeAttribute('stroke-opacity');
    else base.setAttribute('stroke-opacity', '0');

    if (pts.length < 2 || !isFinite(prev) || prev === 0) {
      poly.setAttribute('points', '');
      base.setAttribute('y1', '50');
      base.setAttribute('y2', '50');
      return;
    }

    var max = pts[0], min = pts[0];
    for (var i = 1; i < pts.length; i++) {
      if (pts[i] > max) max = pts[i];
      if (pts[i] < min) min = pts[i];
    }
    if (max < prev) max = prev;
    if (min > prev) min = prev;

    // A 股交易日共 240 个交易分钟（上午 120 + 下午 120），午休不占宽度。
    // 外盘期货每天交易约 23 小时（北京时间 6:00 到次日 5:00，中间休市 1 小时），
    // 共约 1380 个分钟点。都按交易时间占比映射，开盘初期数据少就只占左边一段。
    var TOTAL_MINUTES_A = 240;
    var TOTAL_MINUTES_HF = 1380;
    var isHf = /^hf_/i.test(item.code || '') || /^usDXY$/i.test(item.code || '');
    var total = isHf ? TOTAL_MINUTES_HF : TOTAL_MINUTES_A;
    var xScale = (currentPeriod === 'minute')
      ? (VW / total)
      : (VW / Math.max(1, pts.length - 1));
    var out = [];
    var baseY;

    if (currentPeriod === 'minute') {
      // 分时：以昨收为中心上下对称，中线始终居中
      var span = Math.max(max - prev, prev - min);
      var floor = Math.abs(prev) * 0.0012;
      if (!(span > floor)) span = floor || 1;
      var usable = (VH - PAD * 2) / 2;
      for (var j = 0; j < pts.length; j++) {
        var y = VH / 2 - ((pts[j] - prev) / span) * usable;
        if (y < 1) y = 1; else if (y > VH - 1) y = VH - 1;
        out.push((j * xScale).toFixed(1) + ',' + y.toFixed(1));
      }
      baseY = VH / 2;
    } else {
      // 日/月/年线：按区间铺满，充分利用高度
      var lo = min, hi = max;
      if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
      var room = VH - PAD * 2;
      for (var k = 0; k < pts.length; k++) {
        var yy = PAD + ((hi - pts[k]) / (hi - lo)) * room;
        out.push((k * xScale).toFixed(1) + ',' + yy.toFixed(1));
      }
      baseY = PAD + ((hi - prev) / (hi - lo)) * room;
    }

    poly.setAttribute('points', out.join(' '));
    poly.style.stroke = colorVar(item.pct);
    base.setAttribute('y1', baseY.toFixed(1));
    base.setAttribute('y2', baseY.toFixed(1));
  }

  function ensureRow(code) {
    var row = rowMap[code];
    if (row) return row;
    var el = document.createElement('div');
    el.className = 'row';
    el.dataset.code = code;
    el.innerHTML = SPARK_SVG + '<div class="grip"></div><span class="name"></span><span class="chg"></span><span class="pct"></span>';
    row = {
      el: el,
      poly: el.querySelector('polyline'),
      base: el.querySelector('.baseline'),
      name: el.querySelector('.name'),
      chg: el.querySelector('.chg'),
      pct: el.querySelector('.pct')
    };
    rowMap[code] = row;
    return row;
  }

  function render(list) {
    lastList = list;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var row = ensureRow(item.code);
      var cls = clsOf(item.change);

      if (item.name) row.name.textContent = item.name;
      // 第二栏显示「现在多少点」，涨跌方向靠颜色和后面的百分比表达
      row.chg.textContent = fmtPrice(item.price, item.fund);
      row.chg.className = 'chg ' + cls;
      row.pct.textContent = fmtPct(item.pct);
      row.pct.className = 'pct ' + clsOf(item.pct);
      // 点位不显示了，鼠标停一下还能看到
      row.el.title = (item.name || item.code) + '  ' + fmtPrice(item.price, item.fund) +
        '  ' + fmtChange(item.change, item.fund) + '  ' + fmtPct(item.pct);

      paintSpark(row, item);

      var atIdx = app.children[i];
      if (atIdx !== row.el) app.insertBefore(row.el, atIdx || null);
    }

    // 清掉已经不在列表里的行
    while (app.children.length > list.length) {
      var dead = app.lastChild;
      delete rowMap[dead.dataset.code];
      app.removeChild(dead);
    }

    syncHeight();
  }

  var ROW_H = 32;   // 每行基准高度，窗口拉高时行会被均分拉伸，所以只能按基准值算

  function naturalHeight() {
    return Math.ceil(app.children.length * ROW_H + 12 + (head ? head.offsetHeight : 0));
  }

  function syncHeight() {
    var h = naturalHeight();
    if (h && h !== lastHeight) {
      lastHeight = h;
      window.ticker.setHeight(h);
    }
  }

  function updatePeriodLabel() {
    if (!periodLabel) return;
    periodLabel.textContent = PERIOD_LABEL[currentPeriod] || '';
  }

  function refresh() {
    return window.ticker.getQuotes().then(function (res) {
      if (res && res.ok) {
        if (res.period && res.period !== currentPeriod) {
          currentPeriod = res.period;
          updatePeriodLabel();
        }
        document.body.classList.remove('stale');
        render(res.list || []);
      } else {
        document.body.classList.add('stale');
      }
    }).catch(function () {
      document.body.classList.add('stale');
    });
  }

  function startTimer(ms) {
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, Math.max(800, ms || 3000));
  }

  function applyState(s) {
    if (!s) return;
    // 自动模式下由主进程给出实际生效的配色
    var mode = s.effectiveTextMode || s.textMode;
    document.body.setAttribute('data-text', mode === 'dark' ? 'dark' : 'light');
    document.body.classList.toggle('backdrop', !!s.backdrop);
    document.body.style.setProperty('--bd-op', ((s.backdropOpacity != null ? s.backdropOpacity : 40) / 100).toFixed(3));
    if (s.sparkWidth != null) document.body.style.setProperty('--spark-w', s.sparkWidth + 'px');
    document.body.classList.toggle('noname', s.showName === false);
    showBaseline = s.baseline !== false;
    if (s.period) currentPeriod = s.period;
    updatePeriodLabel();
  }

  var pinned = false;
  var pinBtn = document.getElementById('pin-btn');

  pinBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    pinned = !pinned;
    document.body.classList.toggle('pinned', pinned);
    window.ticker.setPinned(pinned);
  });

  /* ---- 拖动 / 菜单 ---- */
  // 边缘留 6px 给系统做缩放：否则一按到边上就变成拖窗口，拉不大
  function nearEdge(e) {
    var m = 6;
    return e.clientX < m || e.clientY < m ||
      e.clientX > window.innerWidth - m || e.clientY > window.innerHeight - m;
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (pinned) return; // 固定模式不响应拖动
    if (e.target === pinBtn) return;
    // 图表区（含周期按钮）要能交互，别被当成拖窗口；拖窗口从左列拖
    if (e.target.closest && e.target.closest('#focus')) return;
    // 拖拽调整折线宽度
    if (e.target.classList && e.target.classList.contains('grip')) {
      e.target.classList.add('dragging');
      e.preventDefault();
      try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
      var startX = e.clientX;
      var sparkEl = e.target.parentElement.querySelector('.spark');
      var startW = sparkEl.getBoundingClientRect().width;
      var finalW = startW;
      var onMove = function (ev) {
        var w = Math.max(30, Math.min(400, startW + (ev.clientX - startX)));
        finalW = w;
        document.body.style.setProperty('--spark-w', w + 'px');
      };
      var onUp = function () {
        e.target.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        window.ticker.save({ sparkWidth: Math.round(finalW) });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      return;
    }
    if (nearEdge(e)) return;
    dragging = true;
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    window.ticker.startDrag();
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    window.ticker.endDrag();
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);

  // 固定模式下：平时鼠标穿透到下层应用，鼠标移到右上角图钉按钮区域时临时恢复点击
  var pinZoneActive = false;
  document.addEventListener('mousemove', function (e) {
    if (!pinned) return;
    var rect = pinBtn.getBoundingClientRect();
    var near = e.clientX >= rect.left - 10 && e.clientX <= rect.right + 10 &&
               e.clientY >= rect.top - 4 && e.clientY <= rect.bottom + 10;
    if (near && !pinZoneActive) {
      pinZoneActive = true;
      window.ticker.setPinZone(true);
    } else if (!near && pinZoneActive) {
      pinZoneActive = false;
      window.ticker.setPinZone(false);
    }
  });

  window.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    window.ticker.openMenu();
  });

  // 快捷键：Ctrl+1~4 切周期，Ctrl+R 立即刷新
  var PERIOD_KEYS = { '1': 'minute', '2': 'day', '3': 'month', '4': 'year' };
  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    var p = PERIOD_KEYS[e.key];
    if (p) {
      e.preventDefault();
      window.ticker.setPeriod(p);
    } else if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      refresh();
    }
  });

  window.ticker.onForceRefresh(function () { refresh(); });

  // 菜单里选「高度跟随内容」后重新量一次，把窗口收回内容高度
  window.ticker.onRefitHeight(function () {
    lastHeight = 0;
    syncHeight();
  });

  // 周期/标的变了：整窗淡一下再拉新数据，避免新旧折线跳变
  window.ticker.onStateChanged(function (cfg) {
    applyState(cfg);
    document.body.classList.add('loading');
    refresh().then(function () {
      document.body.classList.remove('loading');
    });
  });

  /* ---- 启动 ---- */
  window.ticker.getState().then(function (s) {
    applyState(s);
    return refresh();
  }).then(function () {
    return window.ticker.getState();
  }).then(function (s) {
    startTimer(s && s.interval);
    syncHeight();
  });

  window.addEventListener('resize', syncHeight);
})();
