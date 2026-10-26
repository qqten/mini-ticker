(function () {
  var state = { symbols: [], watchlist: [], names: {} };
  var $ = function (id) { return document.getElementById(id); };

  function setMsg(text, kind) {
    var el = $('msg');
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setFoot(text, kind) {
    var el = $('foot-msg');
    el.textContent = text || '';
    el.className = 'foot-msg' + (kind ? ' ' + kind : '');
  }

  function updateCount() {
    $('count').textContent = state.symbols.length ? '· 已选 ' + state.symbols.length + ' 个' : '';
  }

  function renderList(scrollToNew) {
    var ul = $('symbol-list');
    ul.innerHTML = '';

    state.watchlist.forEach(function (code) {
      var li = document.createElement('li');

      var pick = document.createElement('label');
      pick.className = 'pick';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.symbols.indexOf(code) >= 0;
      cb.addEventListener('change', function () { toggle(code, cb.checked); });
      pick.appendChild(cb);

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = state.names[code] || code;

      var cd = document.createElement('span');
      cd.className = 'cd';
      cd.textContent = code;

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '从候选列表移除';
      del.addEventListener('click', function () { remove(code); });

      li.appendChild(pick);
      li.appendChild(nm);
      li.appendChild(cd);
      li.appendChild(del);
      ul.appendChild(li);
    });

    updateCount();

    // 新加的滚到可见，不然列表一长就看不见自己刚加的那条
    if (scrollToNew && ul.lastElementChild) {
      ul.lastElementChild.scrollIntoView({ block: 'nearest' });
    }
  }

  function toggle(code, on) {
    var i = state.symbols.indexOf(code);
    if (on && i < 0) state.symbols.push(code);
    if (!on && i >= 0) state.symbols.splice(i, 1);
    updateCount();
  }

  function remove(code) {
    state.watchlist = state.watchlist.filter(function (c) { return c !== code; });
    state.symbols = state.symbols.filter(function (c) { return c !== code; });
    renderList();
  }

  function isCodeLike(s) {
    return /^(sh|sz|bj|hk|us)[a-z0-9.]{1,12}$/i.test(s) || /^\d{6}$/.test(s);
  }

  function addByCode(code, hintName) {
    $('add-btn').disabled = true;
    setMsg('查询中…', 'info');

    return window.ticker.validateSymbol(code).then(function (r) {
      $('add-btn').disabled = false;
      if (!r.ok) { setMsg(r.msg, 'err'); return; }

      state.names[r.code] = r.name || hintName || r.code;
      var existed = state.watchlist.indexOf(r.code) >= 0;
      if (!existed) state.watchlist.push(r.code);
      if (state.symbols.indexOf(r.code) < 0) state.symbols.push(r.code);

      $('code-input').value = '';
      setMsg((existed ? '已在列表里，已勾选：' : '已添加：') + state.names[r.code] + '（' + r.code + '）', 'ok');
      renderList(true);
    }).catch(function (e) {
      $('add-btn').disabled = false;
      setMsg('出错：' + e.message, 'err');
    });
  }

  // 名字 / 拼音：先搜再取最匹配的一条；6 位数字优先认作场外基金
  function searchThenAdd(q) {
    $('add-btn').disabled = true;
    setMsg('搜索中…', 'info');

    window.ticker.searchSymbol(q).then(function (r) {
      $('add-btn').disabled = false;
      var list = r.list || [];
      var hit = null;

      if (/^\d{6}$/.test(q)) {
        for (var i = 0; i < list.length; i++) {
          if (/^\d{6}$/.test(list[i].code)) { hit = list[i]; break; }
        }
      }
      if (!hit) hit = list[0];

      if (!hit) { setMsg('没搜到「' + q + '」', 'err'); return; }
      addByCode(hit.code, hit.name);
    }).catch(function (e) {
      $('add-btn').disabled = false;
      setMsg('搜索失败：' + e.message, 'err');
    });
  }

  function add() {
    var q = $('code-input').value.trim();
    if (!q) return;
    hideSuggest();

    // 带市场前缀的直接校验；纯 6 位数字可能是基金也可能是股票代码，交给搜索判断
    if (isCodeLike(q) && !/^\d{6}$/.test(q)) { addByCode(q); return; }
    searchThenAdd(q);
  }

  /* ---- 输入联想：中文名 / 拼音 / 代码 ---- */
  var suggestItems = [];
  var suggestIdx = -1;
  var searchTimer = null;
  var searchSeq = 0;

  function hideSuggest() {
    suggestItems = [];
    suggestIdx = -1;
    $('suggest').innerHTML = '';
  }

  function highlightSuggest() {
    var lis = $('suggest').children;
    for (var i = 0; i < lis.length; i++) {
      lis[i].className = (i === suggestIdx) ? 'on' : '';
    }
  }

  function pickSuggest(i) {
    var it = suggestItems[i];
    if (!it) return;
    hideSuggest();
    $('code-input').value = '';
    addByCode(it.code, it.name);
  }

  function renderSuggest(items, q) {
    suggestItems = items;
    suggestIdx = -1;

    var ul = $('suggest');
    ul.innerHTML = '';

    if (!items.length) {
      var emp = document.createElement('li');
      emp.className = 's-emp';
      emp.textContent = '没搜到「' + q + '」';
      ul.appendChild(emp);
      return;
    }

    items.forEach(function (it, i) {
      var li = document.createElement('li');

      var nm = document.createElement('span');
      nm.className = 's-nm';
      nm.textContent = it.name;

      var cd = document.createElement('span');
      cd.className = 's-cd';
      cd.textContent = it.code;

      li.appendChild(nm);
      li.appendChild(cd);

      if (it.typeLabel) {
        var tp = document.createElement('span');
        tp.className = 's-tp';
        tp.textContent = it.typeLabel;
        li.appendChild(tp);
      }

      // 用 mousedown：click 会先让输入框 blur，候选列表已经被收起来了
      li.addEventListener('mousedown', function (e) {
        e.preventDefault();
        pickSuggest(i);
      });

      ul.appendChild(li);
    });

    // 默认落在第一条上，直接回车就能加
    if (items.length) {
      suggestIdx = 0;
      highlightSuggest();
    }
  }

  /* ---- 计划任务状态提示 ---- */
  var taskInstalled = false;

  function refreshTaskHint(installed) {
    if (typeof installed === 'boolean') taskInstalled = installed;
    var el = $('task-hint');
    var at = $('autoStartTime').value || '09:25';
    if ($('autoStartOn').checked) {
      el.textContent = taskInstalled
        ? '计划任务已生效：工作日 ' + at + ' 自动开浮窗，节假日会自己跳过。'
        : '计划任务尚未写入，点「保存并应用」后生效。';
    } else {
      el.textContent = taskInstalled ? '计划任务仍存在，点「保存并应用」会把它删掉。' : '';
    }
  }

  /* ---- 收盘退出状态提示 ---- */
  // 规则和主进程一致：打开（或改配置）时已经过了退出时间，这次会话就不踢。
  function refreshExitHint() {
    var el = $('exit-hint');
    if (!el) return;
    if (!$('autoExitOn').checked) {
      el.textContent = '已关闭：窗口会一直留着，需要手动退出。';
      return;
    }
    var t = $('autoExitTime').value || '15:05';
    var m = /^(\d{2}):(\d{2})$/.exec(t);
    var at = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
    var d = new Date();
    var now = d.getHours() * 60 + d.getMinutes();
    if (at != null && now >= at) {
      el.textContent = '现在已过 ' + t + '，本次打开的窗口不会自动退出；明天从计划任务启动的那次会正常到点关掉。';
    } else {
      el.textContent = '到 ' + t + ' 会自动关掉浮窗。';
    }
  }

  /* ---- 快捷键录入 ---- */
  var SC_KEYS = ['periodMinute', 'periodDay', 'periodMonth', 'periodYear', 'refresh', 'focus'];
  var SC_DEFAULTS = {
    periodMinute: 'Ctrl+1', periodDay: 'Ctrl+2', periodMonth: 'Ctrl+3', periodYear: 'Ctrl+4',
    refresh: 'Ctrl+R', focus: 'Ctrl+Alt+F'
  };
  var SC_KEY_NAMES = { ' ': 'Space', 'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown', 'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight' };

  function scKeyName(k) {
    if (SC_KEY_NAMES[k]) return SC_KEY_NAMES[k];
    if (/^[a-zA-Z0-9]$/.test(k)) return k.toUpperCase();
    if (/^F\d{1,2}$/i.test(k)) return k.toUpperCase();
    if (k === 'Enter') return 'Enter';
    if (k === 'Escape') return 'Escape';
    if (k === 'Tab') return 'Tab';
    if (k === 'Home') return 'Home';
    if (k === 'End') return 'End';
    if (k === 'PageUp') return 'PageUp';
    if (k === 'PageDown') return 'PageDown';
    if (k === 'Backspace') return 'Backspace';
    if (k === 'Delete') return 'Delete';
    return null;
  }

  function scFromEvent(e) {
    var key = scKeyName(e.key);
    if (!key) return null;
    // 纯修饰键（Ctrl/Alt/Shift/Meta 单独按下）不构成快捷键
    if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null;
    var parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (!parts.length) return null;  // 必须带修饰符，避免裸按键误触发
    parts.push(key);
    return parts.join('+');
  }

  function bindShortcutInput(id) {
    var el = $(id);
    var key = id.replace('sc-', '');
    el.addEventListener('focus', function () {
      el.dataset.editing = '1';
      el.value = '按组合键…';
      el.classList.add('editing');
    });
    el.addEventListener('blur', function () {
      delete el.dataset.editing;
      el.classList.remove('editing');
      el.value = state.shortcuts[key] || SC_DEFAULTS[key];
    });
    el.addEventListener('keydown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        el.value = SC_DEFAULTS[key];
        state.shortcuts[key] = SC_DEFAULTS[key];
        el.blur();
        return;
      }
      var acc = scFromEvent(e);
      if (!acc) return;
      // 冲突检查：同一个组合键不能给两个动作用
      var clash = null;
      for (var i = 0; i < SC_KEYS.length; i++) {
        if (SC_KEYS[i] !== key && state.shortcuts[SC_KEYS[i]] === acc) { clash = SC_KEYS[i]; break; }
      }
      if (clash) {
        el.value = '与「' + $('sc-' + clash).value + '」重复';
        el.classList.add('clash');
        setTimeout(function () { el.classList.remove('clash'); }, 1200);
        return;
      }
      el.value = acc;
      state.shortcuts[key] = acc;
      el.blur();
    });
  }

  function initShortcuts(d) {
    state.shortcuts = {};
    SC_KEYS.forEach(function (k) {
      state.shortcuts[k] = (d.shortcuts && d.shortcuts[k]) || SC_DEFAULTS[k];
      $('sc-' + k).value = state.shortcuts[k];
      bindShortcutInput('sc-' + k);
    });
  }

  /* ---- 更新状态 ---- */
  var updState = { status: 'idle', available: '', progress: 0, message: '' };

  function renderUpdate() {
    var btn = $('updBtn');
    var stateEl = $('updState');
    var hintEl = $('updHint');
    var st = updState.status;

    if (state.updaterOn === false) {
      stateEl.textContent = state.isPortable ? '便携版不支持自动更新' : '开发模式不检查更新';
      btn.style.display = 'none';
      hintEl.textContent = state.isPortable ? '请到 GitHub Releases 下载新版安装包' : '';
      return;
    }
    btn.style.display = '';

    var labels = {
      idle: '未检查', checking: '正在检查…', current: '已是最新版本',
      available: '发现新版 v' + updState.available, downloading: '下载中 ' + (updState.progress || 0) + '%',
      ready: 'v' + updState.available + ' 已下载', error: '检查失败'
    };
    stateEl.textContent = labels[st] || st;
    btn.disabled = (st === 'checking' || st === 'downloading');

    if (st === 'ready') {
      btn.textContent = '重启更新';
      hintEl.textContent = '点击立即重启并安装 v' + updState.available;
    } else if (st === 'error') {
      btn.textContent = '重试';
      hintEl.textContent = (updState.message || '').slice(0, 120) + '（可在日志查看详情）';
    } else {
      btn.textContent = st === 'current' ? '重新检查' : '检查更新';
      hintEl.textContent = st === 'current' ? '当前 v' + state.version + '，点击重新检查' : '';
    }
  }

  function bindUpdate() {
    $('updBtn').addEventListener('click', function () {
      if (updState.status === 'ready') {
        window.ticker.installUpdate();
      } else {
        window.ticker.checkUpdate();
      }
    });
    window.ticker.onUpdateState(function (u) {
      if (u) { updState = u; renderUpdate(); }
    });
  }

  function initUpdate(d) {
    state.version = d.version;
    state.updaterOn = d.updaterOn;
    state.isPortable = d.isPortable;
    $('curVersion').textContent = d.version || '-';
    $('ver').textContent = d.version || '-';
    if (d.update) updState = d.update;
    renderUpdate();
  }

  /* ---- 左侧边栏分类切换 ---- */
  function switchCat(cat) {
    var secs = document.querySelectorAll('section[data-cat]');
    for (var i = 0; i < secs.length; i++) {
      // 显式 block：CSS 默认全部 display:none，不能用 '' 回退
      secs[i].style.display = secs[i].getAttribute('data-cat') === cat ? 'block' : 'none';
    }
    var items = document.querySelectorAll('.nav-item');
    for (var j = 0; j < items.length; j++) {
      items[j].classList.toggle('active', items[j].getAttribute('data-target') === cat);
    }
    var wrap = document.querySelector('.wrap');
    if (wrap) wrap.scrollTop = 0;
  }

  function bindNav() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        switchCat(this.getAttribute('data-target'));
      });
    }
  }

  function save() {
    var periodEl = document.querySelector('input[name="period"]:checked');

    var patch = {
      symbols: state.symbols,
      watchlist: state.watchlist,
      period: periodEl ? periodEl.value : 'minute',
      interval: parseInt($('interval').value, 10),
      textMode: 'auto',
      backdrop: $('backdrop').checked,
      backdropOpacity: parseInt($('backdropOpacity').value, 10),
      probeIntervalMs: parseInt($('probeIntervalSec').value, 10) * 1000,
      sparkWidth: parseInt($('sparkWidth').value, 10),
      showName: $('showName').checked,
      baseline: $('baseline').checked,
      alwaysOnTop: $('alwaysOnTop').checked,
      locked: $('locked').checked,
      width: parseInt($('width').value, 10),
      shortcuts: state.shortcuts,
      alert: {
        enabled: $('alertOn').checked,
        time: $('alertTime').value || '14:30'
      },
      autoExit: {
        enabled: $('autoExitOn').checked,
        time: $('autoExitTime').value || '15:05'
      },
      autoStart: {
        enabled: $('autoStartOn').checked,
        time: $('autoStartTime').value || '09:25'
      }
    };

    if (!patch.symbols.length) { setMsg('至少要勾选一个标的', 'err'); return; }

    setFoot('保存中…');
    window.ticker.saveSettings(patch).then(function (r) {
      if (r && r.ok) {
        if (r.msg) {
          setFoot('已保存' + r.msg, 'err');
          refreshTaskHint(false);
        } else {
          setFoot('已保存并应用', 'ok');
          refreshTaskHint($('autoStartOn').checked);
        }
      } else {
        setFoot((r && r.msg) || '保存失败', 'err');
      }
    });
  }

  /* ---- 初始化 ---- */
  window.ticker.getSettings().then(function (d) {
    state.symbols = d.symbols.slice();
    state.watchlist = d.watchlist.slice();
    state.names = d.names || {};

    var p = document.querySelector('input[name="period"][value="' + d.period + '"]');
    if (p) p.checked = true;

    var sel = $('interval');
    var v = String(d.interval);
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === v) { found = true; break; }
    }
    if (!found) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = (d.interval / 1000) + ' 秒';
      sel.appendChild(o);
    }
    sel.value = v;

    $('backdrop').checked = !!d.backdrop;
    $('backdropOpacity').value = d.backdropOpacity != null ? d.backdropOpacity : 40;
    $('backdropOpacity-val').textContent = $('backdropOpacity').value;
    $('backdropOpacity').disabled = !$('backdrop').checked;
    const pis = Math.round((d.probeIntervalMs != null ? d.probeIntervalMs : 4000) / 1000);
    $('probeIntervalSec').value = pis;
    $('probeIntervalSec-val').textContent = pis;
    $('sparkWidth').value = d.sparkWidth != null ? d.sparkWidth : 120;
    $('sparkWidth-val').textContent = $('sparkWidth').value;
    $('showName').checked = d.showName !== false;
    $('baseline').checked = d.baseline !== false;
    $('alwaysOnTop').checked = !!d.alwaysOnTop;
    $('locked').checked = !!d.locked;

    $('width').value = d.width;
    $('width-val').textContent = d.width;

    $('alertOn').checked = !(d.alert && d.alert.enabled === false);
    $('alertTime').value = (d.alert && d.alert.time) || '14:30';

    $('autoExitOn').checked = !!(d.autoExit && d.autoExit.enabled);
    $('autoExitTime').value = (d.autoExit && d.autoExit.time) || '15:05';
    refreshExitHint();

    $('autoStartOn').checked = !!(d.autoStart && d.autoStart.enabled);
    $('autoStartTime').value = (d.autoStart && d.autoStart.time) || '09:25';
    taskInstalled = !!d.taskInstalled;
    refreshTaskHint();

    initShortcuts(d);
    initUpdate(d);
    bindUpdate();
    bindNav();
    switchCat('symbols');
    renderList();

    // 打开时把焦点放到输入框，方便直接敲代码；列表回滚到顶部
    $('code-input').focus();
    $('symbol-list').scrollTop = 0;
    requestAnimationFrame(function () { $('symbol-list').scrollTop = 0; });
  });

  /* ---- 事件 ---- */
  $('add-btn').addEventListener('click', add);

  $('code-input').addEventListener('input', function () {
    var q = this.value.trim();
    clearTimeout(searchTimer);
    searchSeq++;                          // 让在途的旧请求作废

    if (!q) { hideSuggest(); return; }

    searchTimer = setTimeout(function () {
      var seq = ++searchSeq;
      window.ticker.searchSymbol(q).then(function (r) {
        if (seq !== searchSeq) return;     // 已经有更新的输入了
        if (!r.ok) { hideSuggest(); return; }
        if ($('code-input').value.trim() !== q) return;
        renderSuggest(r.list || [], q);
      }).catch(function () { hideSuggest(); });
    }, 260);
  });

  $('code-input').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' && suggestItems.length) {
      e.preventDefault();
      suggestIdx = (suggestIdx + 1) % suggestItems.length;
      highlightSuggest();
    } else if (e.key === 'ArrowUp' && suggestItems.length) {
      e.preventDefault();
      suggestIdx = suggestIdx <= 0 ? suggestItems.length - 1 : suggestIdx - 1;
      highlightSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestIdx >= 0 && suggestItems[suggestIdx]) pickSuggest(suggestIdx);
      else add();
    } else if (e.key === 'Escape') {
      e.stopPropagation();                // 只收候选，别把设置面板关了
      hideSuggest();
    }
  });

  // 延后收起：留出点击候选的时间
  $('code-input').addEventListener('blur', function () {
    setTimeout(hideSuggest, 130);
  });

  $('save').addEventListener('click', save);
  $('cancel').addEventListener('click', function () { window.ticker.closeSettings(); });
  $('width').addEventListener('input', function () {
    $('width-val').textContent = this.value;
    // 实时预览浮窗宽度；设置窗口关闭时主进程会按 config.width 统一还原
    window.ticker.previewWidth(parseInt(this.value, 10));
  });
  $('backdropOpacity').addEventListener('input', function () {
    $('backdropOpacity-val').textContent = this.value;
    // 衬底浓度实时生效：通过 save-config 即时应用到浮窗，同时落盘
    window.ticker.save({ backdrop: $('backdrop').checked, backdropOpacity: parseInt(this.value, 10) });
  });
  $('probeIntervalSec').addEventListener('input', function () {
    $('probeIntervalSec-val').textContent = this.value;
    window.ticker.save({ probeIntervalMs: parseInt(this.value, 10) * 1000 });
  });
  $('sparkWidth').addEventListener('input', function () {
    $('sparkWidth-val').textContent = this.value;
    window.ticker.save({ sparkWidth: parseInt(this.value, 10) });
  });
  $('backdrop').addEventListener('change', function () {
    $('backdropOpacity').disabled = !this.checked;
    window.ticker.save({ backdrop: this.checked });
  });
  $('test-alert').addEventListener('click', function () {
    window.ticker.testAlert();
    setFoot('已发出测试提醒', 'ok');
  });
  $('autoStartOn').addEventListener('change', function () { refreshTaskHint(); });
  $('autoStartTime').addEventListener('change', function () { refreshTaskHint(); });
  $('autoExitOn').addEventListener('change', function () { refreshExitHint(); });
  $('autoExitTime').addEventListener('change', function () { refreshExitHint(); });

  document.addEventListener('keydown', function (e) {
    // 正在录入快捷键时不触发全局快捷键
    var editing = document.querySelector('.sc.editing');
    if (editing) return;
    if (e.key === 'Escape') window.ticker.closeSettings();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
})();
