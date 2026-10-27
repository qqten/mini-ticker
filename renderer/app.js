(function () {
  var VW = 240, VH = 100, PAD = 7;

  var app = document.getElementById('app');
  var head = document.getElementById('head');
  head.innerHTML = '<button id="sort-btn" type="button" title="按涨跌幅排序：点一下 涨幅从高到低，再点从低到高，第三下恢复自选顺序">涨幅</button><span id="period-label"></span><svg id="pin-btn" width="10" height="12" viewBox="0 0 10 12" title="固定窗口（点击穿透，不可拖动）"><path d="M5 0C2.8 0 1 1.8 1 4c0 1.5.8 2.8 2 3.5V11l2-1.5V7.5c1.2-.7 2-2 2-3.5 0-2.2-1.8-4-2-4z"/></svg>';
  var periodLabel = document.getElementById('period-label');
  var sortBtn = document.getElementById('sort-btn');
  var rowMap = {};
  var PERIOD_LABEL = { minute: '分时', day: '日线', month: '月线', year: '年线' };
  var timer = null;
  var showBaseline = true;
  var currentPeriod = 'minute';
  var lastHeight = 0;
  var dragging = false;
  var suppressClick = false;
  var lastList = [];
  // 列表排序：off 自选顺序 / pct-desc 涨幅从高到低 / pct-asc 从低到高
  var SORT_ORDER = ['off', 'pct-desc', 'pct-asc'];
  var SORT_LABEL = { off: '涨幅', 'pct-desc': '涨幅▼', 'pct-asc': '涨幅▲' };
  var sortMode = 'off';

  // 右端那条 short line 是宽度抓手：画在 SVG 里，天然贴着折线右边缘，不参与布局也就不会错位
  var SPARK_SVG =
    '<svg class="spark" viewBox="0 0 240 100" preserveAspectRatio="none">' +
    '<line class="baseline" x1="0" y1="50" x2="240" y2="50"></line>' +
    '<polyline points=""></polyline>' +
    '<line class="grip" x1="238" y1="30" x2="238" y2="70"></line>' +
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
    // 场外基金的估值曲线自带时间位置（xIndex），按真实交易时间摆；其它标的按点数顺序摆
    var xIdx = item.xIndex;

    if (currentPeriod === 'minute') {
      // 分时：以昨收为中心上下对称，中线始终居中
      var span = Math.max(max - prev, prev - min);
      var floor = Math.abs(prev) * 0.0012;
      if (!(span > floor)) span = floor || 1;
      var usable = (VH - PAD * 2) / 2;
      for (var j = 0; j < pts.length; j++) {
        var y = VH / 2 - ((pts[j] - prev) / span) * usable;
        if (y < 1) y = 1; else if (y > VH - 1) y = VH - 1;
        var xi = (xIdx && isFinite(xIdx[j])) ? xIdx[j] : j;
        out.push((xi * xScale).toFixed(1) + ',' + y.toFixed(1));
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
    el.innerHTML = SPARK_SVG + '<span class="name"></span><span class="chg"></span><span class="pct"></span>';
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
  // 「高度跟随内容」最多撑到这么多行，再多的标的靠滚动看。
  // 浮窗要的是不挡视线：撑到 6 行（约 207px）就停，再高就不像浮窗了。
  var MAX_ROWS = 6;

  function naturalHeight() {
    var rows = Math.min(app.children.length, MAX_ROWS);
    return Math.ceil(rows * ROW_H + 12 + (head ? head.offsetHeight : 0));
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

  /* ---- 折线宽度：sparkWidth 是「想要的宽度」，实际还要受窗口宽度约束 ---- */
  var sparkWant = 120;

  // 一行里除了折线和名称，其它列（手柄 / 点位 / 涨跌率）占掉多少
  function sparkMax() {
    var row = app.querySelector('.row');
    if (!row) return sparkWant;
    var kids = row.children, others = 0;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains('spark') || kids[i].classList.contains('name')) continue;
      others += kids[i].getBoundingClientRect().width;
    }
    var cs = getComputedStyle(row);
    var gap = parseFloat(cs.columnGap || cs.gap) || 6;
    others += gap * Math.max(0, kids.length - 1);
    // 名称至少留 46px，剩下的才给折线；再窄也保底 22px，
    // 让「图永远在」，不因为窗口拖窄就整块消失
    return Math.max(22, Math.round(row.clientWidth - others - 46));
  }

  function applySpark(w) {
    sparkWant = Math.max(30, Math.min(400, Math.round(w || sparkWant)));
    var real = Math.min(sparkWant, sparkMax());
    // 极窄的时候折线只占一条迷你带（34px），把宽度让给名称，
    // 否则要么没图、要么名称被截成两个字，两种都不能要
    if (document.body.classList.contains('tight')) real = Math.min(real, 34);
    document.body.style.setProperty('--spark-w', real + 'px');
    return real;
  }

  function applyState(s) {
    if (!s) return;
    // 自动模式下由主进程给出实际生效的配色
    var mode = s.effectiveTextMode || s.textMode;
    document.body.setAttribute('data-text', mode === 'dark' ? 'dark' : 'light');
    document.body.classList.toggle('backdrop', !!s.backdrop);
    document.body.style.setProperty('--bd-op', ((s.backdropOpacity != null ? s.backdropOpacity : 40) / 100).toFixed(3));
    if (s.sparkWidth != null) applySpark(s.sparkWidth);
    document.body.classList.toggle('noname', s.showName === false);
    showBaseline = s.baseline !== false;
    if (s.period) currentPeriod = s.period;
    if (s.shortcuts) rebuildShortcuts(s.shortcuts);
    if (s.sortMode && SORT_ORDER.indexOf(s.sortMode) >= 0 && s.sortMode !== sortMode) {
      sortMode = s.sortMode;
      paintSort();
    }
    updatePeriodLabel();
  }

  /* ---- 涨跌幅排序：右上角一个小按钮，点一下切一档 ---- */
  function paintSort() {
    if (!sortBtn) return;
    sortBtn.textContent = SORT_LABEL[sortMode] || '涨幅';
    sortBtn.classList.toggle('on', sortMode !== 'off');
    sortBtn.title = sortMode === 'pct-desc'
      ? '涨幅从高到低，再点一次改成从低到高'
      : sortMode === 'pct-asc'
        ? '涨幅从低到高，再点一次恢复自选顺序'
        : '按涨跌幅排序：点一下 涨幅从高到低，再点从低到高，第三下恢复自选顺序';
  }

  if (sortBtn) {
    sortBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      sortMode = SORT_ORDER[(SORT_ORDER.indexOf(sortMode) + 1) % SORT_ORDER.length];
      paintSort();
      window.ticker.save({ sortMode: sortMode });
      // 排序由主进程做，立刻拉一轮，不用等下一次轮询
      refresh();
    });
  }
  paintSort();

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
    if (e.target === pinBtn || e.target === sortBtn) return;
    // 图表区（含周期按钮）要能交互，别被当成拖窗口；拖窗口从左列拖
    if (e.target.closest && e.target.closest('#focus')) return;
    if (e.target === splitter) return;   // 分界线有自己的一套拖动
    // 折线本身就是宽度手柄：左右拖改折线宽（不拖窗口、也不触发聚焦）
    var sp = e.target.closest ? e.target.closest('.spark') : null;
    if (sp) {
      sp.classList.add('dragging');
      e.preventDefault();
      var startX = e.clientX;
      var startW = sp.getBoundingClientRect().width;
      var finalW = startW;
      var moved = false;
      var onMove = function (ev) {
        // 拖动过程中就按窗口宽度收边，别让折线把名称挤没了
        if (Math.abs(ev.clientX - startX) > 1) moved = true;
        finalW = applySpark(startW + (ev.clientX - startX));
      };
      var onUp = function () {
        sp.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        window.ticker.save({ sparkWidth: Math.round(finalW) });
        // 拖过宽度就当这次不点行，别顺手展开聚焦
        if (moved) {
          suppressClick = true;
          setTimeout(function () { suppressClick = false; }, 400);
        }
      };
      // 挂 window：鼠标移出折线或系统没给 pointer capture 时也能继续跟手
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
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

  /* ---- 分界线：左右拖动，重新分配「列表 / 图表」的宽度 ---- */
  var splitter = document.getElementById('splitter');
  var splitting = false;

  // 左列 220~640，右边至少留 200 给图表；跟主进程的钳制保持一致，松手后才不会跳一下
  function clampSplit(x) {
    var hi = Math.min(640, window.innerWidth - 200);
    if (hi < 220) hi = Math.max(220, Math.round(window.innerWidth * 0.55));
    return Math.round(Math.max(220, Math.min(x, hi)));
  }

  splitter.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    if (!document.body.classList.contains('focus')) return;
    e.preventDefault();
    e.stopPropagation();
    splitting = true;
    document.body.classList.add('splitting');
    try { splitter.setPointerCapture(e.pointerId); } catch (err) {}
  });

  // move/up 挂在 window 上：鼠标拖出分界线（或系统没给 pointer capture）时也能继续跟手
  window.addEventListener('pointermove', function (e) {
    if (!splitting) return;
    document.body.style.setProperty('--left-w', clampSplit(e.clientX) + 'px');
  });

  function endSplit() {
    if (!splitting) return;
    splitting = false;
    document.body.classList.remove('splitting');
    var w = parseInt(document.body.style.getPropertyValue('--left-w'), 10);
    if (isFinite(w)) window.ticker.focusSplit(w);
  }

  window.addEventListener('pointerup', endSplit);
  window.addEventListener('pointercancel', endSplit);
  window.addEventListener('blur', endSplit);

  /* ---- 左键单击：没聚焦时展开图表，已聚焦时切到点的那一行 ---- */
  var downAt = null;
  document.addEventListener('pointerdown', function (e) {
    // 记录屏幕坐标：拖窗口时窗口跟着鼠标跑，clientX 几乎不变，只有屏幕坐标能看出位移
    downAt = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY };
  }, true);

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (suppressClick) { suppressClick = false; return; }
    if (t.closest && (t.closest('#focus') || t.closest('#splitter'))) return;
    if (t === pinBtn || t === sortBtn) return;
    // 拖着窗口跑（起点和落点差得多）不算点击，别顺手展开 / 换标的
    if (downAt && (Math.abs(e.screenX - downAt.sx) > 3 || Math.abs(e.screenY - downAt.sy) > 3 ||
      Math.abs(e.clientX - downAt.x) > 4 || Math.abs(e.clientY - downAt.y) > 4)) return;
    var row = t.closest ? t.closest('.row') : null;
    var code = (row && row.dataset.code) || '';
    if (document.body.classList.contains('focus')) {
      if (code) window.ticker.focusSelect(code);
    } else {
      window.ticker.focusOpen(code);
    }
  });

  /* ---- 左列变窄时先压缩数值列，把宽度让给名称 ---- */
  var leftEl = document.getElementById('left');
  new ResizeObserver(function () {
    var w = leftEl.clientWidth;
    document.body.classList.toggle('compact', w < 300);
    document.body.classList.toggle('tight', w < 240);
    // 窗口宽度变了，折线按新空间重新收边
    applySpark(sparkWant);
  }).observe(leftEl);

  // 固定模式下：平时鼠标穿透到下层应用，鼠标移到右上角这一条（排序按钮 / 图钉）时临时恢复点击
  var pinZoneActive = false;
  document.addEventListener('mousemove', function (e) {
    if (!pinned) return;
    var r = head.getBoundingClientRect();
    var near = e.clientX >= r.left - 6 && e.clientX <= r.right + 6 &&
               e.clientY >= r.top - 4 && e.clientY <= r.bottom + 8;
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

  // 快捷键：Ctrl+1~4 切周期，Ctrl+R 立即刷新（可在设置里改）
  var SHORTCUT_DEFAULTS = {
    periodMinute: 'Ctrl+1', periodDay: 'Ctrl+2', periodMonth: 'Ctrl+3', periodYear: 'Ctrl+4',
    refresh: 'Ctrl+R', focus: 'Ctrl+Alt+F'
  };
  var shortcuts = Object.assign({}, SHORTCUT_DEFAULTS);

  // 把 "Ctrl+Alt+F" 这类字符串转成匹配函数；不认识的格式返回 null
  function shortcutMatcher(acc) {
    if (!acc || typeof acc !== 'string') return null;
    var parts = acc.trim().split('+');
    if (parts.length < 2) return null;  // 必须至少一个修饰符 + 主键
    var mods = { ctrl: false, alt: false, shift: false };
    for (var i = 0; i < parts.length - 1; i++) {
      var m = parts[i].trim().toLowerCase();
      if (m === 'ctrl' || m === 'control') mods.ctrl = true;
      else if (m === 'alt') mods.alt = true;
      else if (m === 'shift') mods.shift = true;
      else return null;
    }
    var key = parts[parts.length - 1].trim().toLowerCase();
    if (!key) return null;
    return function (e) {
      return (e.ctrlKey || e.metaKey) === mods.ctrl &&
        e.altKey === mods.alt &&
        e.shiftKey === mods.shift &&
        e.key.toLowerCase() === key;
    };
  }

  var shortcutHandlers = [];
  function rebuildShortcuts(sc) {
    if (sc) shortcuts = Object.assign({}, SHORTCUT_DEFAULTS, sc);
    shortcutHandlers = [
      { m: shortcutMatcher(shortcuts.periodMinute), fn: function () { window.ticker.setPeriod('minute'); } },
      { m: shortcutMatcher(shortcuts.periodDay), fn: function () { window.ticker.setPeriod('day'); } },
      { m: shortcutMatcher(shortcuts.periodMonth), fn: function () { window.ticker.setPeriod('month'); } },
      { m: shortcutMatcher(shortcuts.periodYear), fn: function () { window.ticker.setPeriod('year'); } },
      { m: shortcutMatcher(shortcuts.refresh), fn: function () { refresh(); } }
    ].filter(function (h) { return !!h.m; });
  }

  document.addEventListener('keydown', function (e) {
    // 设置窗口里的按键（如敲代码搜索）不影响浮窗；这里只处理浮窗本身
    for (var i = 0; i < shortcutHandlers.length; i++) {
      if (shortcutHandlers[i].m(e)) {
        e.preventDefault();
        shortcutHandlers[i].fn();
        return;
      }
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
