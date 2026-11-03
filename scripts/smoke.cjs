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
    name: 'settings',
    shot: 'settings',
    screenshot: 'settings.png',
    config: baseConfig({ symbols: ['sh000001', 'sz399001'], watchlist: ['sh000001', 'sz399001'] })
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
