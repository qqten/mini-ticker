'use strict';

// 冒烟测试：用隔离的 user-data-dir 启动真实 Electron，逐个场景截图并检查退出码 / 截图 / 日志。
// 只依赖 Node 内置模块，不碰用户正在运行的实例，也不会读写 %APPDATA%\mini-ticker。
//
// 用法：
//   npm run smoke                         # 开发模式（node_modules 里的 Electron）
//   npm run smoke:pack                    # 打包产物 dist/win-unpacked/MiniTicker.exe
//   TICKER_SMOKE_KEEP=1 npm run smoke     # 保留临时目录，方便看截图和日志
//   TICKER_SMOKE_ONLY=focus,focus-day npm run smoke  # 只跑指定场景
//
// 注意：需要本机已安装 Electron（devDependency）；打包版需要先 npm run pack:dir。

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACKED = process.argv.indexOf('--packed') >= 0;
const PACKED_EXE = path.join(ROOT, 'dist', 'win-unpacked', 'MiniTicker.exe');
const KEEP = process.env.TICKER_SMOKE_KEEP === '1';
const TIMEOUT_MS = 90000;
const MIN_SHOT_BYTES = 5000;

function electronExe() {
  try {
    return require('electron');
  } catch (e) {
    throw new Error('找不到 Electron，请先 npm install：' + e.message);
  }
}

function resolveExe() {
  if (!PACKED) return electronExe();
  if (!fs.existsSync(PACKED_EXE)) {
    throw new Error('找不到打包产物：' + PACKED_EXE + '，请先运行 npm run pack:dir');
  }
  return PACKED_EXE;
}

function isPng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

function baseConfig(extra) {
  return Object.assign({
    textMode: 'light',
    lastEffectiveTextMode: 'light',
    backdrop: true,
    backdropOpacity: 80,
    alwaysOnTop: true,
    // 冒烟不验证收盘退出/提醒，避免运行时间落在 15:05 之后被自动退出
    alert: { enabled: false, time: '14:30' },
    autoExit: { enabled: false, time: '15:05' },
    autoStart: { enabled: false, time: '09:25' }
  }, extra || {});
}

const SCENARIOS = [
  {
    name: 'main',
    shot: 'main',
    screenshot: 'self.png',
    config: baseConfig({ symbols: ['sh000001', 'sz399001', 'sz399006'], watchlist: ['sh000001', 'sz399001', 'sz399006'] })
  },
  {
    // 分组下拉底部固定一个「管理分组…」，跳到设置面板
    name: 'group-menu-manage',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "(function(){document.getElementById('group-btn').click();" +
        "var b=document.querySelector('#group-menu .gm-manage');" +
        "var normal=document.querySelector('#group-menu .gm-item:not(.gm-manage):not(.on)');" +
        "var r=b?b.getBoundingClientRect():null;var m=document.getElementById('group-menu').getBoundingClientRect();" +
        "return JSON.stringify({text:b?b.textContent:''," +
        "visible:document.getElementById('group-menu').style.display," +
        "sameColor:!!(b&&normal)&&getComputedStyle(b).color===getComputedStyle(normal).color," +
        "inside:!!r&&r.bottom<=m.bottom+0.5&&r.top>=m.top-0.5});})()"
    },
    expect: [/"text":"管理分组…"/, /"visible":"block"/, /"sameColor":true/, /"inside":true/],
    config: baseConfig({
      symbols: ['sh000001'],
      watchlist: ['sh000001'],
      groups: [
        { id: 'default', name: '默认', symbols: ['sh000001'] },
        { id: 'g2', name: '观察', symbols: [] }
      ],
      activeGroupId: 'default'
    })
  },
  {
    // 东财专属指数（中证 931787）：em 前缀走东财快照，列表里能显示名称和点位
    name: 'em-index',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "(function(){var r=document.querySelector('#app .row');" +
        "return JSON.stringify({code:r?r.dataset.code:null,name:r?r.querySelector('.name').textContent:''," +
        "price:r?r.querySelector('.chg').textContent:''});})()"
    },
    expect: [/"code":"em931787"/, /港股创新药/],
    config: baseConfig({ symbols: ['em931787'], watchlist: ['em931787'] })
  },
  {
    // 港股主题的 em 指数：分时走中证，横轴按港股 09:30-11:30 / 13:00-16:00 排
    name: 'em-index-hk-minute',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute' },
    expect: [/\[focus\] 展开图表 em931787/],
    config: baseConfig({ symbols: ['em931787'], watchlist: ['em931787'] })
  },
  {
    // 港股主题的 em 指数：5 日图也要按港股时段排，不能拿东财的 A 股时段硬套
    name: 'em-index-hk-five',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'five' },
    expect: [/\[focus\] 切换周期 five/],
    config: baseConfig({ symbols: ['em931787'], watchlist: ['em931787'] })
  },
  {
    name: 'settings',
    shot: 'settings',
    screenshot: 'settings.png',
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
  },
  {
    // 外观页保留三档配色，标题改为「主题色」
    name: 'settings-theme-color',
    shot: 'settings',
    screenshot: 'settings.png',
    env: {
      TICKER_SHOT_SETTINGS_EVAL: "(function(){" +
        "var n=document.querySelector('.nav-item[data-target=\"appearance\"]');if(n)n.click();" +
        "var f=document.querySelector('input[name=\"textMode\"]');" +
        "return f?f.closest('.field').querySelector('.fl').textContent:'';})()"
    },
    expect: [/\[settings-eval\] 主题色/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    // 分享导入面板：打开、粘贴无效链接、本地就能报错（不需要联网）
    name: 'settings-import',
    shot: 'settings',
    screenshot: 'settings.png',
    env: {
      TICKER_SHOT_SETTINGS_EVAL: "(function(){" +
        "var btn=document.getElementById('group-import');btn.click();" +
        "var panel=document.getElementById('import-panel');var open=!panel.hidden;" +
        "var inp=document.getElementById('import-link');" +
        "inp.value='https://eq.10jqka.com.cn/#/index?st=2';" +
        "document.getElementById('import-read').click();" +
        "return new Promise(function(res){setTimeout(function(){" +
        "res(JSON.stringify({open:open," +
        "status:document.getElementById('import-status').textContent," +
        "cls:document.getElementById('import-status').className}));},800);});})()"
    },
    expect: [/"open":true/, /链接里没有 id 参数/, /"cls":"import-status err"/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'focus',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute' },
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
  },
  {
    name: 'focus-hf',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute' },
    config: baseConfig({ symbols: ['hf_XAU'], watchlist: ['hf_XAU'] })
  },
  {
    name: 'focus-hf-five',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'five' },
    expect: [/\[focus\] 切换周期 five/],
    config: baseConfig({ symbols: ['hf_XAU'], watchlist: ['hf_XAU'] })
  },
  {
    name: 'focus-hf-month',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'month' },
    expect: [/\[focus\] 切换周期 month/],
    config: baseConfig({ symbols: ['hf_XAU'], watchlist: ['hf_XAU'] })
  },
  {
    name: 'focus-day',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'day' },
    expect: [/\[focus\] 切换周期 day/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'focus-month',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'month' },
    expect: [/\[focus\] 切换周期 month/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'focus-side-right',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_FOCUS_SIDE: 'right', TICKER_SHOT_LAYOUT: '1' },
    expect: [
      /\[focus\] 展开图表.*方向 左/,
      /\[layout\][^\n]*"chartLeft":1/
    ],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'focus-side-left',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_FOCUS_SIDE: 'left', TICKER_SHOT_LAYOUT: '1' },
    expect: [
      /\[focus\] 展开图表.*方向 右/,
      /\[layout\][^\n]*"chartLeft":0/
    ],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'focus-click-same',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_CLICKROW: '0' },
    expect: [/再次点击同一标的，收起图表/],
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
  },
  {
    name: 'focus-click-other',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_CLICKROW: '1' },
    expect: [/\[focus\] 点选标的 sz399001/],
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
  },
  {
    // 不在分钟图上：第一下切到当前选中的分钟图，第二下才展开级别列表
    name: 'focus-level-tap',
    shot: 'focus',
    screenshot: 'focus.png',
    env: {
      TICKER_SHOT_FOCUS_TAB: 'minute',
      TICKER_SHOT_EVAL: "(function(){var b=document.getElementById('f-level');b.click();" +
        "return new Promise(function(res){setTimeout(function(){b.click();" +
        "setTimeout(function(){res(JSON.stringify({menu:document.getElementById('f-level-menu').style.display}));},400);},600);});})()"
    },
    expect: [
      /\[focus\] 切换周期 min 5分钟/,
      /"menu":"block"/
    ],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'index-click-same',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_EVAL: "window.ticker.selectIndex('sh000001')" },
    expect: [/再次点击当前指数，收起走势图/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'index-bar-close',
    shot: 'focus',
    screenshot: 'focus.png',
    env: { TICKER_SHOT_FOCUS_TAB: 'minute', TICKER_SHOT_EVAL: "document.getElementById('index-quote').click()" },
    expect: [/IPC focus-close/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    // 窗口偏窄时顶部优先保住分组名，指数条可以让位
    name: 'index-group-name',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "(function(){var n=document.querySelector('#group-btn .gname');" +
        "return JSON.stringify({name:n?n.textContent:'',full:!!n&&n.clientWidth>=n.scrollWidth});})()"
    },
    expect: [/"full":true/],
    config: baseConfig({
      symbols: ['sh000001'],
      watchlist: ['sh000001'],
      width: 260,
      groups: [{ id: 'default', name: '我的自选股', symbols: ['sh000001'] }],
      activeGroupId: 'default'
    })
  },
  {
    // 大盘概览默认显示：四项标签都在，且这一条参与布局（不是 hidden）
    name: 'market-overview',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "(function(){var b=document.getElementById('market-bar');" +
        "return JSON.stringify({hidden:!b||b.hidden,text:b?b.textContent.replace(/\\s+/g,''):''});})()"
    },
    expect: [/"hidden":false/, /成交/, /较昨/],
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'], width: 360 })
  },
  {
    // 设置里关掉后整条不占高度
    name: 'market-overview-off',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "JSON.stringify({hidden:document.getElementById('market-bar').hidden})"
    },
    expect: [/"hidden":true/],
    config: baseConfig({
      symbols: ['sh000001'], watchlist: ['sh000001'], showMarketOverview: false
    })
  },
  {
    // 窄窗从右往左降级：预测项不可见（宽度不够或收盘后收起），成交额始终保留
    name: 'market-overview-narrow',
    shot: 'main',
    screenshot: 'self.png',
    env: {
      TICKER_SHOT_EVAL: "JSON.stringify({" +
        "projHidden:document.querySelector('.mb-proj').offsetWidth===0," +
        "slim:document.body.classList.contains('mb-slim')," +
        "amountVisible:document.querySelector('.mb-amount').offsetWidth>0})"
    },
    expect: [/"projHidden":true/, /"amountVisible":true/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'], width: 240 })
  },
  {
    name: 'focus-interact',
    shot: 'focus',
    screenshot: 'focus.png',
    env: {
      TICKER_SHOT_FOCUS_TAB: 'day',
      TICKER_SHOT_ZOOM: '3',
      TICKER_SHOT_PAN: '120',
      TICKER_SHOT_EDGE: 'r',
      TICKER_SHOT_PERIOD: '2'
    },
    expect: [
      /\[shot\] 滚轮放大 x3/,
      /\[shot\] 拖动 120px/,
      /\[shot\] 悬停右边缘/,
      /\[shot\] 点周期标识 x2/
    ],
    forbid: [/测试失败/],
    config: baseConfig({ symbols: ['sh000001'], watchlist: ['sh000001'] })
  },
  {
    name: 'window-hotkeys',
    shot: 'main',
    screenshot: 'self.png',
    env: { TICKER_SHOT_SHOWHIDE: '1', TICKER_SHOT_THROUGH: '1' },
    expect: [
      /\[hotkey\] 显示\/隐藏 Ctrl\+Alt\+H/,
      /\[hotkey\] 鼠标穿透 Ctrl\+Alt\+T/,
      /\[window\] 快捷键隐藏[\s\S]*\[window\] 快捷键显示/,
      /\[window\] 鼠标穿透 开启[\s\S]*\[window\] 鼠标穿透 关闭/
    ],
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
  }
];

const FATAL_PATTERNS = [
  /is not defined/,
  /ReferenceError/,
  /renderer-gone/,
  /\[renderer\][^\n]*无响应/,
  /Uncaught/
];

function runScenario(exe, scenario) {
  return new Promise(function (resolve) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ticker-smoke-' + scenario.name + '-'));
    const outPath = path.join(dir, 'stdout.log');
    const errPath = path.join(dir, 'stderr.log');
    const appLog = path.join(dir, 'logs', 'app.log');
    const shotPath = path.join(dir, '.dev', scenario.screenshot);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(scenario.config, null, 2));

    const env = Object.assign({}, process.env, {
      TICKER_SHOT: scenario.shot,
      TICKER_SHOT_BG: '#14161b',
      TICKER_SHOT_TEXT: 'light'
    }, scenario.env || {});
    delete env.ELECTRON_RUN_AS_NODE;

    const args = [
      '--user-data-dir=' + dir,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-compositing'
    ];
    if (!PACKED) args.unshift(ROOT);

    const outFd = fs.openSync(outPath, 'a');
    const errFd = fs.openSync(errPath, 'a');
    const child = spawn(exe, args, {
      cwd: ROOT,
      env: env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true
    });

    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      try { child.kill(); } catch (e) {}
    }, TIMEOUT_MS);

    child.on('error', function (err) {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch (e) {}
      try { fs.closeSync(errFd); } catch (e) {}
      resolve({ ok: false, dir: dir, errors: ['启动失败：' + err.message] });
    });

    child.on('close', function (code) {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch (e) {}
      try { fs.closeSync(errFd); } catch (e) {}

      const errors = [];
      if (timedOut) errors.push('超过 ' + Math.round(TIMEOUT_MS / 1000) + ' 秒未退出');
      if (code !== 0) errors.push('Electron 退出码 ' + code);

      let shotSize = 0;
      let shotBuf = null;
      try {
        shotBuf = fs.readFileSync(shotPath);
        shotSize = shotBuf.length;
      } catch (e) {
        errors.push('缺少截图 ' + shotPath);
      }
      if (shotBuf) {
        if (shotSize < MIN_SHOT_BYTES) {
          errors.push('截图过小（' + shotSize + ' 字节，至少 ' + MIN_SHOT_BYTES + '）');
        }
        if (!isPng(shotBuf)) errors.push('截图不是有效 PNG');
      }

      let log = '';
      try {
        log = fs.readFileSync(appLog, 'utf8');
      } catch (e) {
        errors.push('缺少应用日志 ' + appLog);
      }
      let childOut = '';
      try {
        childOut = fs.readFileSync(outPath, 'utf8') + '\n' + fs.readFileSync(errPath, 'utf8');
      } catch (e) {}

      if (log && log.indexOf('[quit-done] exit code=0') < 0) {
        errors.push('日志里没有 [quit-done] exit code=0');
      }
      if (log && log.indexOf('页面加载完成') < 0) {
        errors.push('页面没有加载完成');
      }

      const combined = log + '\n' + childOut;
      FATAL_PATTERNS.forEach(function (re) {
        if (re.test(combined)) errors.push('日志命中异常：' + re);
      });
      (scenario.expect || []).forEach(function (re) {
        if (!re.test(combined)) errors.push('日志缺少预期：' + re);
      });
      (scenario.forbid || []).forEach(function (re) {
        if (re.test(combined)) errors.push('日志命中禁止项：' + re);
      });

      resolve({
        ok: errors.length === 0,
        dir: dir,
        shotPath: shotPath,
        shotSize: shotSize,
        errors: errors
      });
    });
  });
}

async function main() {
  const exe = resolveExe();
  const only = (process.env.TICKER_SMOKE_ONLY || '').split(',').map(function (s) {
    return s.trim();
  }).filter(Boolean);
  const scenarios = only.length
    ? SCENARIOS.filter(function (s) { return only.indexOf(s.name) >= 0; })
    : SCENARIOS;
  if (!scenarios.length) {
    throw new Error('TICKER_SMOKE_ONLY 没有匹配到任何场景：' + only.join(','));
  }

  console.log((PACKED ? '打包版: ' : 'Electron: ') + exe);
  console.log('工作目录: ' + ROOT);

  const failures = [];
  for (const scenario of scenarios) {
    process.stdout.write('[' + scenario.name + '] 运行中... ');
    const result = await runScenario(exe, scenario);
    if (result.ok) {
      console.log('通过（截图 ' + result.shotSize + ' 字节）');
      if (KEEP) console.log('  产物: ' + result.dir);
    } else {
      console.log('失败');
      result.errors.forEach(function (msg) { console.log('  - ' + msg); });
      console.log('  产物: ' + result.dir);
      failures.push({ name: scenario.name, errors: result.errors, dir: result.dir });
    }
    if (!KEEP && result.ok) {
      try { fs.rmSync(result.dir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  if (failures.length) {
    console.log('\n冒烟测试失败：' + failures.map(function (f) { return f.name; }).join(', '));
    process.exit(1);
  }
  console.log('\n冒烟测试全部通过（' + scenarios.length + ' 个场景）');
}

main().catch(function (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
