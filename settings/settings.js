(function () {
  var state = {
    groups: [{ id: 'default', name: '默认', symbols: [] }],
    activeGroupId: 'default',
    watchlist: [],
    names: {},
    showAll: false
  };
  var groupEditMode = '';
  var dragCode = '';
  var MAX_GROUPS = 32;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

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

  function activeGroup() {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === state.activeGroupId) return state.groups[i];
    }
    return state.groups[0] || null;
  }

  function groupById(id) {
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === id) return state.groups[i];
    }
    return null;
  }

  function allCodes() {
    var out = [];
    function push(c) {
      if (c && out.indexOf(c) < 0) out.push(c);
    }
    state.watchlist.forEach(push);
    state.groups.forEach(function (g) { g.symbols.forEach(push); });
    return out;
  }

  function updateCount() {
    var g = activeGroup();
    if (state.showAll) {
      $('count').textContent = '· 全部 ' + allCodes().length + ' 个';
    } else {
      $('count').textContent = g ? '· ' + g.name + ' ' + g.symbols.length + ' 个' : '';
    }
  }

  function updateGroupHint() {
    var g = activeGroup();
    var el = $('symbol-hint');
    if (!el) return;
    if (state.showAll) {
      el.innerHTML = '「全部标的」用于管理归属：点行内分组标签加入 / 移出分组；这里的 ✕ 会从候选池和所有分组彻底删除。<br />' +
        '新增标的、新建 / 重命名 / 删除分组请先切回具体分组。';
    } else {
      el.innerHTML = '当前分组：<b>' + esc(g ? g.name : '-') + '</b>。拖动行可调整本组顺序；点行内分组标签可加入 / 移出其它分组；✕ 只把标的移出本组。<br />' +
        '输入中文名、拼音首字母或代码都能搜到，回车选第一条，↑↓ 挑，点一下直接加。';
    }
  }

  function renderGroupSelect() {
    var sel = $('group-select');
    sel.innerHTML = '';
    state.groups.forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.name;
      sel.appendChild(o);
    });
    sel.value = state.activeGroupId;
    sel.disabled = state.showAll;
    $('group-add').disabled = state.showAll || state.groups.length >= MAX_GROUPS;
    $('group-rename').disabled = state.showAll;
    $('group-del').disabled = state.showAll || state.groups.length <= 1;
    var i = state.groups.indexOf(activeGroup());
    $('group-up').disabled = state.showAll || i <= 0;
    $('group-down').disabled = state.showAll || i < 0 || i >= state.groups.length - 1;
    $('show-all').checked = state.showAll;
    // 「全部标的」没有明确的归属分组，先切回具体分组才能新增
    $('add-btn').disabled = state.showAll;
    $('code-input').disabled = state.showAll;
    updateCount();
    updateGroupHint();
  }

  function makeTag(code, g) {
    var on = g.symbols.indexOf(code) >= 0;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag' + (on ? ' on' : '');
    b.textContent = g.name;
    b.title = on ? '从「' + g.name + '」移出' : '加入「' + g.name + '」';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleGroup(code, g.id, !on);
    });
    return b;
  }

  function renderList(scrollToNew) {
    var ul = $('symbol-list');
    ul.innerHTML = '';

    var codes = state.showAll
      ? allCodes()
      : (activeGroup() ? activeGroup().symbols.slice() : []);

    codes.forEach(function (code) {
      var li = document.createElement('li');
      li.className = 'grp-row' + (state.showAll ? ' showall' : '');
      li.dataset.code = code;

      if (!state.showAll) {
        li.draggable = true;
        var handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.textContent = '⋮⋮';
        handle.title = '拖动调整本组顺序';
        li.appendChild(handle);

        li.addEventListener('dragstart', function (e) {
          dragCode = code;
          li.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', code); } catch (err) {}
        });
        li.addEventListener('dragend', function () {
          dragCode = '';
          li.classList.remove('dragging');
        });
        li.addEventListener('dragover', function (e) {
          if (!dragCode || dragCode === code) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          li.classList.add('drop-target');
        });
        li.addEventListener('dragleave', function () { li.classList.remove('drop-target'); });
        li.addEventListener('drop', function (e) {
          e.preventDefault();
          li.classList.remove('drop-target');
          moveCode(dragCode, code);
        });
      }

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = state.names[code] || code;

      var cd = document.createElement('span');
      cd.className = 'cd';
      cd.textContent = code;

      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = state.showAll ? '从候选池和所有分组彻底删除' : '从当前分组移出';
      del.addEventListener('click', function () { remove(code); });

      var tags = document.createElement('span');
      tags.className = 'tags';
      state.groups.forEach(function (g) { tags.appendChild(makeTag(code, g)); });

      li.appendChild(nm);
      li.appendChild(cd);
      li.appendChild(del);
      li.appendChild(tags);
      ul.appendChild(li);
    });

    renderGroupSelect();

    // 新加的滚到可见，不然列表一长就看不见自己刚加的那条
    if (scrollToNew && ul.lastElementChild) {
      ul.lastElementChild.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveCode(from, to) {
    var g = activeGroup();
    if (!g || !from || !to || from === to) return;
    var a = g.symbols.indexOf(from);
    var b = g.symbols.indexOf(to);
    if (a < 0 || b < 0) return;
    g.symbols.splice(a, 1);
    if (a < b) b--;
    g.symbols.splice(b, 0, from);
    dragCode = '';
    renderList();
  }

  function toggleGroup(code, groupId, on) {
    var g = groupById(groupId);
    if (!g) return;
    var i = g.symbols.indexOf(code);
    if (on && i < 0) {
      g.symbols.push(code);
      if (state.watchlist.indexOf(code) < 0) state.watchlist.push(code);
    }
    if (!on && i >= 0) g.symbols.splice(i, 1);
    renderList();
  }

  function remove(code) {
    if (state.showAll) {
      var name = state.names[code] || code;
      if (!window.confirm('从候选池和所有分组里彻底删除「' + name + '」？')) return;
      state.watchlist = state.watchlist.filter(function (c) { return c !== code; });
      state.groups.forEach(function (g) {
        g.symbols = g.symbols.filter(function (c) { return c !== code; });
      });
    } else {
      var g = activeGroup();
      if (!g) return;
      g.symbols = g.symbols.filter(function (c) { return c !== code; });
    }
    renderList();
  }

  function newGroupId() {
    var used = {};
    state.groups.forEach(function (g) { used[g.id] = true; });
    var n = 1;
    while (used['g' + n]) n++;
    return 'g' + n;
  }

  function beginGroupEdit(mode) {
    groupEditMode = mode;
    var box = $('group-edit');
    var inp = $('group-name');
    box.hidden = false;
    inp.value = mode === 'rename' && activeGroup() ? activeGroup().name : '';
    inp.focus();
    inp.select();
  }

  function cancelGroupEdit() {
    groupEditMode = '';
    $('group-edit').hidden = true;
    $('group-name').value = '';
  }

  function commitGroupEdit() {
    var name = $('group-name').value.replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!name) {
      setMsg('分组名称不能为空', 'err');
      return;
    }
    if (groupEditMode === 'add') {
      if (state.groups.length >= MAX_GROUPS) {
        setMsg('最多只能建 ' + MAX_GROUPS + ' 个分组', 'err');
        return;
      }
      var id = newGroupId();
      state.groups.push({ id: id, name: name, symbols: [] });
      state.activeGroupId = id;
      state.showAll = false;
      setMsg('已新建分组：' + name, 'ok');
    } else if (groupEditMode === 'rename') {
      var g = activeGroup();
      if (g) g.name = name;
    }
    cancelGroupEdit();
    renderList();
  }

  function deleteGroup() {
    if (state.groups.length <= 1) {
      setMsg('至少要保留一个分组', 'err');
      return;
    }
    var g = activeGroup();
    if (!g) return;
    if (!window.confirm('删除分组「' + g.name + '」？组内标的仍会保留在候选池和其它分组中。')) return;
    var i = state.groups.indexOf(g);
    state.groups.splice(i, 1);
    var next = state.groups[Math.max(0, i - 1)];
    state.activeGroupId = next.id;
    state.showAll = false;
    setMsg('已删除分组：' + g.name, 'ok');
    renderList();
  }

  function moveGroup(dir) {
    var g = activeGroup();
    var i = state.groups.indexOf(g);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= state.groups.length) return;
    state.groups.splice(i, 1);
    state.groups.splice(j, 0, g);
    renderList();
  }

  function isCodeLike(s) {
    return /^(sh|sz|bj|hk|us)[a-z0-9.]{1,12}$/i.test(s) || /^\d{6}$/.test(s);
  }

  function addByCode(code, hintName) {
    $('add-btn').disabled = true;
    setMsg('查询中…', 'info');

    return window.ticker.validateSymbol(code).then(function (r) {
      $('add-btn').disabled = state.showAll;
      if (!r.ok) { setMsg(r.msg, 'err'); return; }

      var g = activeGroup();
      if (!g) { setMsg('请先新建一个分组', 'err'); return; }
      state.names[r.code] = r.name || hintName || r.code;
      var existed = state.watchlist.indexOf(r.code) >= 0;
      if (!existed) state.watchlist.push(r.code);
      if (g.symbols.indexOf(r.code) < 0) g.symbols.push(r.code);

      $('code-input').value = '';
      setMsg((existed ? '已在候选池，已加入「' : '已加入「') + g.name + '」：' +
        state.names[r.code] + '（' + r.code + '）', 'ok');
      state.showAll = false;
      renderList(true);
    }).catch(function (e) {
      $('add-btn').disabled = state.showAll;
      setMsg('出错：' + e.message, 'err');
    });
  }

  // 名字 / 拼音：先搜再取最匹配的一条；6 位数字优先认作场外基金
  function searchThenAdd(q) {
    $('add-btn').disabled = true;
    setMsg('搜索中…', 'info');

    window.ticker.searchSymbol(q).then(function (r) {
      $('add-btn').disabled = state.showAll;
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
      $('add-btn').disabled = state.showAll;
      setMsg('搜索失败：' + e.message, 'err');
    });
  }

  function add() {
    if (state.showAll) {
      setMsg('请先切回一个分组再添加标的', 'err');
      return;
    }
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
  var SC_KEYS = ['periodMinute', 'periodDay', 'periodMonth', 'periodYear', 'refresh', 'focus', 'showHide', 'clickThrough'];
  var SC_DEFAULTS = {
    periodMinute: 'Ctrl+1', periodDay: 'Ctrl+2', periodMonth: 'Ctrl+3', periodYear: 'Ctrl+4',
    refresh: 'Ctrl+R', focus: 'Ctrl+Alt+F', showHide: 'Ctrl+Alt+H', clickThrough: 'Ctrl+Alt+T'
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
    // available 阶段已经在后台准备下载了，再点一次只会重复发起检查
    btn.disabled = (st === 'checking' || st === 'available' || st === 'downloading');

    if (st === 'ready') {
      btn.textContent = '重启更新';
      hintEl.textContent = '点击立即重启并安装 v' + updState.available;
    } else if (st === 'error') {
      btn.textContent = '重试';
      hintEl.textContent = updState.message
        ? updState.message.slice(0, 120) + '（可在日志查看详情）'
        : '可在日志查看详情';
    } else if (st === 'checking') {
      btn.textContent = '检查中…';
      hintEl.textContent = '';
    } else if (st === 'available') {
      btn.textContent = '准备下载…';
      hintEl.textContent = '发现 v' + updState.available + '，正在后台下载…';
    } else if (st === 'downloading') {
      btn.textContent = '下载中…';
      hintEl.textContent = '正在后台下载，完成后会提示重启';
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

  /* ---- 分时级别：勾选图表「分时」下拉里能选到哪几档 ---- */
  var FOCUS_INTERVALS_ALL = [1, 5, 15, 30, 60];
  var FOCUS_INTERVAL_LABELS = { 1: '1分', 5: '5分', 15: '15分', 30: '30分', 60: '60分' };

  // 渲染成一组复选框；至少留一项，全部取消时把刚点的那个勾回来并提示
  function initFocusInterval(d) {
    var box = $('focusIntervalChecks');
    if (!box) return;
    var all = Array.isArray(d.focusIntervalOptions) && d.focusIntervalOptions.length
      ? d.focusIntervalOptions
      : FOCUS_INTERVALS_ALL;
    var checked = Array.isArray(d.focusIntervals) ? d.focusIntervals.slice() : FOCUS_INTERVALS_ALL.slice();
    if (!checked.length) checked = all.slice();
    var label = d.focusIntervalLabel || FOCUS_INTERVAL_LABELS;

    box.innerHTML = '';
    all.forEach(function (n) {
      var lab = document.createElement('label');
      lab.className = 'check';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(n);
      cb.checked = checked.indexOf(n) >= 0;
      var sp = document.createElement('span');
      sp.textContent = label[n] || n + '分';
      lab.appendChild(cb);
      lab.appendChild(sp);
      cb.addEventListener('change', function () {
        if (selectedFocusIntervals().length) return;
        // 一个都不剩下拉就空了：把这一项勾回去，别让用户保存出一个空列表
        cb.checked = true;
        setFoot('至少要勾选一个分时级别', 'err');
      });
      box.appendChild(lab);
    });
  }

  // 按固定顺序取当前勾选的级别（DOM 顺序就是 1/5/15/30/60）
  function selectedFocusIntervals() {
    var box = $('focusIntervalChecks');
    if (!box) return FOCUS_INTERVALS_ALL.slice();
    var out = [];
    var cbs = box.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < cbs.length; i++) {
      if (cbs[i].checked) out.push(parseInt(cbs[i].value, 10));
    }
    return out;
  }

  function save() {
    var periodEl = document.querySelector('input[name="period"]:checked');
    var textModeEl = document.querySelector('input[name="textMode"]:checked');
    var focusSideEl = document.querySelector('input[name="focusChartSide"]:checked');

    var g = activeGroup();
    if (!state.groups.length || !g) { setMsg('至少要保留一个分组', 'err'); return; }

    var patch = {
      symbols: g.symbols.slice(),
      groups: state.groups.map(function (x) {
        return { id: x.id, name: x.name, symbols: x.symbols.slice() };
      }),
      activeGroupId: state.activeGroupId,
      watchlist: state.watchlist.slice(),
      period: periodEl ? periodEl.value : 'minute',
      focusIntervals: selectedFocusIntervals(),
      interval: parseInt($('interval').value, 10),
      textMode: textModeEl ? textModeEl.value : 'auto',
      focusChartSide: focusSideEl ? focusSideEl.value : 'auto',
      backdrop: $('backdrop').checked,
      backdropOpacity: parseInt($('backdropOpacity').value, 10),
      probeIntervalMs: parseInt($('probeIntervalSec').value, 10) * 1000,
      showName: $('showName').checked,
      baseline: $('baseline').checked,
      showTopIndex: $('showTopIndex').checked,
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

  // 只有「自动」配色才会去采样背景，固定配色时采样间隔没有意义
  function syncProbeUi(mode) {
    $('probeIntervalSec').disabled = (mode || 'auto') !== 'auto';
  }

  /* ---- 初始化 ---- */
  window.ticker.getSettings().then(function (d) {
    var groups = (d.groups && d.groups.length)
      ? d.groups
      : [{ id: 'default', name: '默认', symbols: (d.symbols || []).slice() }];
    state.groups = groups.map(function (g) {
      return { id: g.id, name: g.name, symbols: (g.symbols || []).slice() };
    });
    state.activeGroupId = d.activeGroupId || state.groups[0].id;
    if (!groupById(state.activeGroupId)) state.activeGroupId = state.groups[0].id;
    state.watchlist = (d.watchlist || []).slice();
    state.names = d.names || {};

    var p = document.querySelector('input[name="period"][value="' + d.period + '"]');
    if (p) p.checked = true;

    initFocusInterval(d);

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
    var tm = document.querySelector('input[name="textMode"][value="' + (d.textMode || 'auto') + '"]');
    if (tm) tm.checked = true;
    syncProbeUi(d.textMode);
    const pis = Math.round((d.probeIntervalMs != null ? d.probeIntervalMs : 4000) / 1000);
    $('probeIntervalSec').value = pis;
    $('probeIntervalSec-val').textContent = pis;
    $('showName').checked = d.showName !== false;
    $('baseline').checked = d.baseline !== false;
    $('showTopIndex').checked = d.showTopIndex !== false;
    var fcs = document.querySelector('input[name="focusChartSide"][value="' + (d.focusChartSide || 'auto') + '"]');
    if (fcs) fcs.checked = true;

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
    var inputEl = $('code-input');
    inputEl.focus();
    // 窗口是「画完首屏才显示」的，隐藏状态下 focus() 不生效，等第一次拿到焦点时补一次
    window.addEventListener('focus', function () { inputEl.focus(); }, { once: true });
    $('symbol-list').scrollTop = 0;
    requestAnimationFrame(function () { $('symbol-list').scrollTop = 0; });

    // 首屏已经画完，通知主进程放窗口出来（窗口在收到这个之前是隐藏的，
    // 免得用户先看到一个空壳再等列表刷出来）
    if (window.ticker.settingsReady) window.ticker.settingsReady();
  }).catch(function () {
    // 读配置失败也要把窗口显示出来，否则用户面对的是「点了设置没反应」
    if (window.ticker.settingsReady) window.ticker.settingsReady();
  });

  /* ---- 分组事件 ---- */
  $('group-select').addEventListener('change', function () {
    state.activeGroupId = this.value;
    state.showAll = false;
    renderList();
  });
  $('show-all').addEventListener('change', function () {
    state.showAll = this.checked;
    renderList();
  });
  $('group-add').addEventListener('click', function () { beginGroupEdit('add'); });
  $('group-rename').addEventListener('click', function () {
    if (activeGroup()) beginGroupEdit('rename');
  });
  $('group-del').addEventListener('click', deleteGroup);
  $('group-up').addEventListener('click', function () { moveGroup(-1); });
  $('group-down').addEventListener('click', function () { moveGroup(1); });
  $('group-edit-ok').addEventListener('click', commitGroupEdit);
  $('group-edit-cancel').addEventListener('click', cancelGroupEdit);
  $('group-name').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); commitGroupEdit(); }
    else if (e.key === 'Escape') { e.stopPropagation(); cancelGroupEdit(); }
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
  $('backdropOpacity').addEventListener('input', function () {
    $('backdropOpacity-val').textContent = this.value;
    // 衬底浓度实时生效：通过 save-config 即时应用到浮窗，同时落盘
    window.ticker.save({ backdrop: $('backdrop').checked, backdropOpacity: parseInt(this.value, 10) });
  });
  $('probeIntervalSec').addEventListener('input', function () {
    $('probeIntervalSec-val').textContent = this.value;
    window.ticker.save({ probeIntervalMs: parseInt(this.value, 10) * 1000 });
  });
  $('backdrop').addEventListener('change', function () {
    $('backdropOpacity').disabled = !this.checked;
    window.ticker.save({ backdrop: this.checked });
  });
  // 主题色三选一：点了立刻生效，不用等「保存并应用」
  var textModeRadios = document.querySelectorAll('input[name="textMode"]');
  for (var ti = 0; ti < textModeRadios.length; ti++) {
    textModeRadios[ti].addEventListener('change', function () {
      if (!this.checked) return;
      syncProbeUi(this.value);
      window.ticker.save({ textMode: this.value });
    });
  }
  // 聚焦图表方位同理：点了立刻生效并落盘，正在聚焦时窗口会当场重排
  var focusSideRadios = document.querySelectorAll('input[name="focusChartSide"]');
  for (var fi = 0; fi < focusSideRadios.length; fi++) {
    focusSideRadios[fi].addEventListener('change', function () {
      if (!this.checked) return;
      window.ticker.save({ focusChartSide: this.value });
    });
  }
  $('test-alert').addEventListener('click', function () {
    window.ticker.testAlert();
    setFoot('已发出测试提醒', 'ok');
  });
  $('autoStartOn').addEventListener('change', function () { refreshTaskHint(); });
  $('autoStartTime').addEventListener('change', function () { refreshTaskHint(); });
  $('autoExitOn').addEventListener('change', function () { refreshExitHint(); });
  $('autoExitTime').addEventListener('change', function () { refreshExitHint(); });

  /* ---- 晚到的补充数据 ---- */
  // 名称是异步补的：只改已有行的文本，不重建列表，免得列表闪一下还丢滚动位置
  function paintNames(names) {
    if (!names) return;
    Object.keys(names).forEach(function (code) { state.names[code] = names[code]; });
    var rows = $('symbol-list').children;
    for (var i = 0; i < rows.length; i++) {
      var code = rows[i].dataset.code;
      var nm = rows[i].querySelector('.nm');
      if (code && nm && state.names[code]) nm.textContent = state.names[code];
    }
  }
  if (window.ticker.onSettingsNames) {
    window.ticker.onSettingsNames(paintNames);
  }
  if (window.ticker.onAutostartStatus) {
    window.ticker.onAutostartStatus(function (v) { refreshTaskHint(!!v); });
  }

  document.addEventListener('keydown', function (e) {
    // 正在录入快捷键时不触发全局快捷键
    var editing = document.querySelector('.sc.editing');
    if (editing) return;
    if (e.key === 'Escape') window.ticker.closeSettings();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
})();
