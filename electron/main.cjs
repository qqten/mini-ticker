const { app, BrowserWindow, ipcMain, Menu, screen, shell, Notification, dialog, desktopCapturer, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { NAMES, PERIODS } = require('./core/constants.cjs');
const { pad2 } = require('./core/utils.cjs');
const { isValidCode, isFundCode } = require('./core/symbols.cjs');
const {
  migrateConfig,
  loadConfig,
  saveConfig: writeConfigFile,
  normalizeShortcuts
} = require('./core/config.cjs');
const { createHttp } = require('./data/http.cjs');
const { createMarket } = require('./data/market.cjs');
const { createFundMinuteStore } = require('./data/fund-minutes.cjs');
const { createQuoteService } = require('./data/quote-service.cjs');
const { createFocusService, FOCUS_TABS } = require('./data/focus.cjs');
const { applySettingsPatch } = require('./core/settings.cjs');

// 极简浮窗不需要 GPU 合成，禁用硬件加速可避免部分机器上 GPU 进程崩溃、并降低功耗
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

// 资源目录（只读）：renderer / settings / scripts 都从这里读
const RES_DIR = path.join(__dirname, '..');
// 数据目录（可写）：配置 / 日志 / 缓存统一放用户目录（%APPDATA%\mini-ticker）。
// 两种形态共用同一份，避免「npm start 和 exe 各存一套、自选对不上」。
// 打包后程序目录在只读的 asar 里，本来也写不进去。
const DATA_DIR = app.getPath('userData');
const ROOT = DATA_DIR;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/* ---------------- 运行日志（闪退排查用） ---------------- */

const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

function logLine(tag, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > 512 * 1024) {
        try { fs.unlinkSync(LOG_FILE + '.old'); } catch (e) {}
        fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      }
    } catch (e) {}
    const d = new Date();
    const ts = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    fs.appendFileSync(LOG_FILE, '[' + ts + '] ' + tag + ' ' + msg + '\n');
  } catch (e) {}
}

/* ---------------- 配置 ---------------- */

// 首次启动：把 exe 旁边 / 项目目录里的老配置接到用户目录，只跑一次。
migrateConfig({
  resDir: RES_DIR,
  dataDir: DATA_DIR,
  configPath: CONFIG_PATH,
  log: logLine
});
let config = loadConfig({ configPath: CONFIG_PATH, log: logLine });
logLine('[config]', '配置文件：' + CONFIG_PATH);

// 各处只关心「把当前 config 存盘」，路径和原子写入细节留在 core/config。
function saveConfig() {
  writeConfigFile({ configPath: CONFIG_PATH, config: config, log: logLine });
}

/* ---------------- 行情 / 数据服务 ---------------- */

const http = createHttp();
const market = createMarket({ http: http, log: logLine });
const fundStore = createFundMinuteStore({
  file: path.join(ROOT, 'cache', 'fund-minute.json'),
  log: logLine
});
const quoteService = createQuoteService({
  market: market,
  http: http,
  fundStore: fundStore,
  log: logLine,
  getConfig: function () { return config; }
});
const focusService = createFocusService({ market: market, http: http });

// 窗口 / 聚焦图表直接用的几个取数入口，保留原有函数名，调用点不用跟着改。
const fetchSnapshots = market.fetchSnapshots;
const searchSymbols = market.searchSymbols;
const fetchFundEstimates = market.fetchFundEstimates;
const fetchFundNav = market.fetchFundNav;

function fetchAll() {
  return quoteService.fetchAll();
}

let win = null;
// 渲染层最近一次算出的"内容自然高度"，用来区分用户手动拖高还是内容撑开
let autoFitHeight = 0;
// 最近一次拖动调尺寸的时间戳：拖动期间不允许内容高度插手，否则会互相抢
let resizingAt = 0;
let settingsWin = null;
let dragTimer = null;
let dragProbeTimer = null;
let dragBase = null;

/* ---------------- 窗口 ---------------- */

function createWindow() {
  const opts = {
    width: config.width || 320,
    height: config.height > 0 ? config.height : 200,
    frame: false,
    transparent: true,
    // alpha 给到 1（而不是 0）：Windows 对全透明像素会跳过命中测试，导致右键/拖动漏到桌面
    backgroundColor: '#01000000',
    hasShadow: false,
    resizable: true,
    minWidth: 220,
    maxWidth: 640,
    minHeight: 56,
    maxHeight: 900,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    title: '盯盘',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  };

  if (config.pos && isFinite(config.pos.x) && isFinite(config.pos.y)) {
    opts.x = config.pos.x;
    opts.y = config.pos.y;
  }

  win = new BrowserWindow(opts);
  win.setAlwaysOnTop(!!config.alwaysOnTop);
  // 把配色通过 query 传进去：页面里 boot.js 在首帧之前就按它写好 data-text，
  // 否则透明窗口会先用 CSS 默认的亮色字画一帧（白底桌面上就是一片空白），
  // 等 get-state 回来才纠正。
  win.loadFile(path.join(RES_DIR, 'renderer', 'index.html'), {
    query: {
      text: effectiveTextMode(),
      bd: config.backdrop ? '1' : '0',
      bop: String(config.backdropOpacity == null ? 40 : config.backdropOpacity)
    }
  });
  logLine('[window]', 'BrowserWindow 已创建 pos=' + JSON.stringify(config.pos) +
    ' text=' + effectiveTextMode());

  win.once('ready-to-show', function () {
    logLine('[window]', 'ready-to-show');
    win.show();
  });

  win.webContents.once('did-finish-load', function () {
    logLine('[window]', '页面加载完成');
  });
  win.webContents.on('render-process-gone', function (e, d) {
    logLine('[renderer-gone]', JSON.stringify(d));
  });
  win.webContents.on('unresponsive', function () {
    logLine('[renderer]', '界面无响应');
  });

  // 调试：TICKER_SHOT=main|settings|alert
  if (process.env.TICKER_SHOT) {
    win.webContents.once('did-finish-load', function () {
      const which = process.env.TICKER_SHOT;

      // 调试：TICKER_SHOT_BG=#14161b 给截图垫一层底色。
      // 窗口本身是透明的，直接截图是透明底 + 跟随背景的浅色字，
      // 贴到白底页面上字就看不见了。
      if (process.env.TICKER_SHOT_BG) {
        win.webContents.insertCSS(
          'html,body{background:' + process.env.TICKER_SHOT_BG + '!important;}'
        ).catch(function () {});
      }
      // 调试：TICKER_SHOT_TEXT=dark 强制深色字（配合浅色 BG 假装窗口在亮背景上），
      // 自动配色采样的是真实屏幕，截图环境里没法真的把窗口挪到白底上
      if (process.env.TICKER_SHOT_TEXT) {
        const m = process.env.TICKER_SHOT_TEXT === 'dark' ? 'dark' : 'light';
        setTimeout(function () {
          if (!win || win.isDestroyed()) return;
          win.webContents.executeJavaScript(
            "document.body.setAttribute('data-text','" + m + "');'ok'"
          ).catch(function () {});
        }, 3600);
      }

      if (which === 'alert') {
        setTimeout(function () {
          fireAlert(false).then(function () {
            setTimeout(function () { app.quit(); }, 2000);
          });
        }, 2000);
        return;
      }

      // 调试：TICKER_SHOT_KEY=2 模拟 Ctrl+数字，验证快捷键链路
      if (process.env.TICKER_SHOT_KEY) {
        setTimeout(function () {
          if (!win || win.isDestroyed()) return;
          win.webContents.executeJavaScript(
            "document.dispatchEvent(new KeyboardEvent('keydown',{key:" +
            JSON.stringify(process.env.TICKER_SHOT_KEY) +
            ",ctrlKey:true,bubbles:true}));"
          ).catch(function () {});
        }, 3000);
      }

      if (which === 'settings') {
        openSettings();
        // 调试：TICKER_SHOT_QUERY=茅台 会把关键词打进搜索框，方便截候选列表
        if (process.env.TICKER_SHOT_QUERY) {
          setTimeout(function () {
            if (!settingsWin || settingsWin.isDestroyed()) return;
            settingsWin.webContents.executeJavaScript(
              "var el=document.getElementById('code-input');el.value=" +
              JSON.stringify(process.env.TICKER_SHOT_QUERY) +
              ";el.focus();el.dispatchEvent(new Event('input'));"
            ).catch(function () {});
          }, 4000);
        }
        // 调试：TICKER_SHOT_PICK=1 自动点候选第一条，验证「选中 -> 入列表」整条链路
        if (process.env.TICKER_SHOT_PICK) {
          setTimeout(function () {
            if (!settingsWin || settingsWin.isDestroyed()) return;
            settingsWin.webContents.executeJavaScript(
              "var li=document.querySelector('#suggest li');" +
              "if(li)li.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));"
            ).catch(function () {});
          }, 5600);
        }
      }
      if (which === 'focus') {
        setFocus(true);
        // 调试：TICKER_SHOT_FOCUS_TAB=day/five/minute 指定周期；TICKER_SHOT_FOCUS_STEP=1 切换下一个自选
        if (process.env.TICKER_SHOT_FOCUS_TAB) {
          setTimeout(function () { focusSetTab(process.env.TICKER_SHOT_FOCUS_TAB); }, 1600);
        }
        if (process.env.TICKER_SHOT_FOCUS_STEP) {
          setTimeout(function () {
            focusStep(Number(process.env.TICKER_SHOT_FOCUS_STEP) || 1);
          }, 2400);
        }
        // 调试：TICKER_SHOT_FOCUS_CLOSE=1 展开后收起，验证窗口能还原
        if (process.env.TICKER_SHOT_FOCUS_CLOSE) {
          setTimeout(function () { setFocus(false); }, 3800);
        }
        // 调试：TICKER_SHOT_ROW=2 点第 3 行，验证「鼠标点行切标的」
        if (process.env.TICKER_SHOT_ROW) {
          setTimeout(function () {
            if (!win || win.isDestroyed()) return;
            win.webContents.executeJavaScript(
              "(function(){var rows=document.querySelectorAll('#app .row');" +
              "var r=rows[" + (Number(process.env.TICKER_SHOT_ROW) || 0) + "];" +
              "if(!r)return 'no-row';r.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));" +
              "return r.dataset.code;})()"
            ).then(function (c) { logLine('[focus]', '调试点行 ' + c); }).catch(function () {});
          }, 2800);
        }
        // 调试：TICKER_SHOT_SPLIT=520 从分界线拖到 x=520，验证「拖动 -> 重绘 -> 落盘」整条链路
        if (process.env.TICKER_SHOT_SPLIT) {
          setTimeout(async function () {
            if (!win || win.isDestroyed()) return;
            const to = Number(process.env.TICKER_SHOT_SPLIT);
            let sx = 0;
            try {
              sx = await win.webContents.executeJavaScript(
                "(function(){var b=document.getElementById('splitter').getBoundingClientRect();" +
                "return Math.round(b.x+b.width/2);})()"
              );
            } catch (e) { logLine('[focus]', '取分界线位置失败 ' + e.message); return; }
            const y = 40;
            win.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: y, button: 'left', clickCount: 1 });
            for (let i = 1; i <= 6; i++) {
              const x = Math.round(sx + (to - sx) * i / 6);
              win.webContents.sendInputEvent({ type: 'mouseMove', x: x, y: y, button: 'left' });
            }
            win.webContents.sendInputEvent({ type: 'mouseUp', x: to, y: y, button: 'left', clickCount: 1 });
            logLine('[focus]', '调试拖分界线 ' + sx + ' -> ' + to);
          }, 3400);
        }
      }

      // 调试：TICKER_SHOT_CROSS=0.55 在聚焦图表里模拟悬停，截十字光标 + 数值提示
      // 0~1 是横向位置比例，纵向固定落在价格区（成交量/MACD 区不弹提示）
      if (process.env.TICKER_SHOT_CROSS) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          let box = null;
          try {
            box = await win.webContents.executeJavaScript(
              "(function(){var c=document.getElementById('chart');if(!c)return null;" +
              "var b=c.getBoundingClientRect();" +
              "return {x:b.x,y:b.y,w:b.width,h:b.height};})()"
            );
          } catch (e) { logLine('[shot]', '取图表位置失败 ' + e.message); return; }
          if (!box || !box.w) { logLine('[shot]', '没有图表区，跳过悬停'); return; }
          const fx = Math.min(0.9, Math.max(0.1, Number(process.env.TICKER_SHOT_CROSS) || 0.55));
          const x = Math.round(box.x + box.w * fx);
          const y = Math.round(box.y + box.h * 0.3);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x, y: y });
          logLine('[shot]', '悬停图表 ' + x + ',' + y);
        }, 5600);
      }

      // 调试：TICKER_SHOT_SCROLL=3 在列表里滚几下滚轮，截图验证「列表能滚」
      if (process.env.TICKER_SHOT_SCROLL) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          let box = null;
          try {
            box = await win.webContents.executeJavaScript(
              "(function(){var a=document.getElementById('app');if(!a)return null;" +
              "var b=a.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};})()"
            );
          } catch (e) { logLine('[shot]', '取列表位置失败 ' + e.message); return; }
          if (!box || !box.h) return;
          const x = Math.round(box.x + box.w / 2);
          const y = Math.round(box.y + box.h / 2);
          const times = Math.max(1, Math.min(30, parseInt(process.env.TICKER_SHOT_SCROLL, 10) || 3));
          win.webContents.sendInputEvent({ type: 'mouseMove', x: x, y: y });
          for (let i = 0; i < times; i++) {
            win.webContents.sendInputEvent({
              type: 'mouseWheel', x: x, y: y, deltaX: 0, deltaY: -120, canScroll: true
            });
          }
          const top = await new Promise(function (resolve) {
            // 滚轮是平滑动画，立刻读 scrollTop 会读到 0/半截，等动画走完再读
            setTimeout(function () {
              win.webContents.executeJavaScript("document.getElementById('app').scrollTop")
                .then(resolve).catch(function () { resolve(-1); });
            }, 400);
          });
          logLine('[shot]', '滚轮 ' + times + ' 次 → scrollTop=' + top);
        }, 4300);
      }

      // 调试：TICKER_SHOT_ZOOM=4 在聚焦图表上连续向上滚，验证「滚轮缩放」
      //       给负数就是向下滚（缩小），-9 一路缩到全幅看全部历史
      if (process.env.TICKER_SHOT_ZOOM) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const raw = parseInt(process.env.TICKER_SHOT_ZOOM, 10) || 2;
          const times = Math.max(1, Math.min(20, Math.abs(raw)));
          const dy = raw < 0 ? 120 : -120;
          try {
            const r = await win.webContents.executeJavaScript(
              "(function(){var c=document.getElementById('chart');if(!c)return 'no-chart';" +
              "var b=c.getBoundingClientRect();if(!b.width)return 'no-box';" +
              "var x=b.x+b.width*0.6,y=b.y+b.height*0.35;" +
              "for(var i=0;i<" + times + ";i++){" +
              "c.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:" + dy + ",clientX:x,clientY:y}));}" +
              "var z=document.getElementById('f-zoom');" +
              "var ax=[].map.call(c.querySelectorAll('svg text'),function(t){return t.textContent})" +
              ".filter(function(t){return /^\\d{2}-\\d{2}$/.test(t)});" +
              "return (z&&z.textContent?z.textContent:'-')+' | rect='+c.querySelectorAll('svg rect').length" +
              "+' | 轴='+(ax.length?ax[0]+'..'+ax[ax.length-1]:'-');" +
              ";})()"
            );
            logLine('[shot]', '滚轮' + (dy < 0 ? '放大' : '缩小') + ' x' + times + ' → ' + r);
          } catch (e) { logLine('[shot]', '缩放测试失败 ' + e.message); }
        }, 5000);
      }

      // 调试：TICKER_SHOT_PAN=120 在图表上按住往右拖 120px，验证「拖动平移」
      if (process.env.TICKER_SHOT_PAN) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const px = parseInt(process.env.TICKER_SHOT_PAN, 10) || 120;
          try {
            const r = await win.webContents.executeJavaScript(
              "(function(){var c=document.getElementById('chart');if(!c)return 'no-chart';" +
              "var b=c.getBoundingClientRect();if(!b.width)return 'no-box';" +
              "var y=b.y+b.height*0.4,x=b.x+b.width*0.7;" +
              "c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));" +
              "window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,clientX:x+" + px + ",clientY:y}));" +
              "window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:x+" + px + ",clientY:y}));" +
              "var z=document.getElementById('f-zoom');" +
              "return (z&&z.textContent?z.textContent:'-')+' | rect='+c.querySelectorAll('svg rect').length;" +
              ";})()"
            );
            logLine('[shot]', '拖动 ' + px + 'px → ' + r);
          } catch (e) { logLine('[shot]', '拖动测试失败 ' + e.message); }
        }, 5000);
      }

      // 调试：TICKER_SHOT_EDGE=l|r 把鼠标停在左/右边缘，验证箭头出现且持续平移
      if (process.env.TICKER_SHOT_EDGE) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const dir = String(process.env.TICKER_SHOT_EDGE).toLowerCase() === 'r' ? 'r' : 'l';
          try {
            const r = await win.webContents.executeJavaScript(
              "(function(){var c=document.getElementById('chart');if(!c)return 'no-chart';" +
              "var b=c.getBoundingClientRect();if(!b.width)return 'no-box';" +
              "var x=" + (dir === 'r' ? "b.x+b.width-6" : "b.x+6") + ",y=b.y+b.height*0.45;" +
              "c.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,cancelable:true,clientX:x,clientY:y}));" +
              "return 'moved';})()"
            );
            logLine('[shot]', '悬停' + (dir === 'r' ? '右' : '左') + '边缘 → ' + r);
          } catch (e) { logLine('[shot]', '边缘测试失败 ' + e.message); }
        }, 6000);
      }

      // 调试：TICKER_SHOT_SORT=1 点几下排序按钮，验证排序真的生效
      if (process.env.TICKER_SHOT_SORT) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const times = Math.max(1, Math.min(3, parseInt(process.env.TICKER_SHOT_SORT, 10) || 1));
          const js =
            "(async function(){" +
            "var b=document.getElementById('sort-btn');if(!b)return 'no-btn';" +
            "for(var i=0;i<" + times + ";i++){b.click();await new Promise(function(r){setTimeout(r,350);});}" +
            "await new Promise(function(r){setTimeout(r,900);});" +
            "var rows=document.querySelectorAll('#app .row');" +
            "var out=[];for(var j=0;j<rows.length;j++){" +
            "out.push(rows[j].dataset.code+' '+rows[j].querySelector('.pct').textContent);}" +
            "return 'btn='+b.textContent+' on='+b.classList.contains('on')+' | '+out.join(' , ');" +
            "})()";
          try {
            const ret = await win.webContents.executeJavaScript(js);
            logLine('[shot]', '排序 cnt=' + times + ' → ' + ret);
            logLine('[shot]', 'config.sortMode=' + config.sortMode);
          } catch (e) { logLine('[shot]', '排序调试失败 ' + e.message); }
        }, 1200);
      }

      // 调试：TICKER_SHOT_PERIOD=3 点几下右上角周期标识，验证点击轮换周期
      if (process.env.TICKER_SHOT_PERIOD) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const times = Math.max(1, Math.min(5, parseInt(process.env.TICKER_SHOT_PERIOD, 10) || 1));
          const js =
            "(async function(){" +
            "var b=document.getElementById('period-label');if(!b)return 'no-label';" +
            "var log=[b.textContent];" +
            "for(var i=0;i<" + times + ";i++){b.click();await new Promise(function(r){setTimeout(r,380);});log.push(b.textContent);}" +
            "return log.join('→');" +
            "})()";
          try {
            const ret = await win.webContents.executeJavaScript(js);
            logLine('[shot]', '点周期标识 x' + times + ' → ' + ret);
            logLine('[shot]', 'config.period=' + config.period);
          } catch (e) { logLine('[shot]', '周期点击测试失败 ' + e.message); }
        }, 1200);
      }

      // 调试：TICKER_SHOT_MENU=1 打出右键菜单项，验证只剩设置 / 退出
      if (process.env.TICKER_SHOT_MENU) {
        setTimeout(function () {
          try {
            const items = buildMainMenu().items.map(function (i) { return i.label || i.type; });
            logLine('[menu]', items.join(' | '));
          } catch (e) { logLine('[menu]', '构建失败 ' + e.message); }
        }, 3000);
      }
      // 调试：TICKER_SHOT_HOVER=0 把鼠标移到第 1 行的折线上，验证 hover 时的拖动标识
      if (process.env.TICKER_SHOT_HOVER) {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const idx = Number(process.env.TICKER_SHOT_HOVER) || 0;
          let pt = null;
          try {
            pt = await win.webContents.executeJavaScript(
              "(function(){var r=document.querySelectorAll('#app .row')[" + idx + "];" +
              "if(!r)return null;var s=r.querySelector('.spark');if(!s)return null;" +
              "var b=s.getBoundingClientRect();" +
              "return {x:Math.round(b.x+b.width-6),y:Math.round(b.y+b.height/2),w:Math.round(b.width)};})()"
            );
          } catch (e) { logLine('[hover]', '取折线位置失败 ' + e.message); return; }
          if (!pt) { logLine('[hover]', '调试悬停：没找到折线'); return; }
          win.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
          logLine('[hover]', '调试悬停 x=' + pt.x + ' y=' + pt.y + ' 折线宽=' + pt.w);
        }, 2600);
      }
      // 调试：TICKER_SHOT_CLICKROW=2 普通模式下点第 3 行，验证「单击进聚焦」
      if (process.env.TICKER_SHOT_CLICKROW && which !== 'focus') {
        setTimeout(async function () {
          if (!win || win.isDestroyed()) return;
          const idx = Number(process.env.TICKER_SHOT_CLICKROW) || 0;
          let pt = null;
          try {
            pt = await win.webContents.executeJavaScript(
              "(function(){var r=document.querySelectorAll('#app .row')[" + idx + "];" +
              "if(!r)return null;var b=r.getBoundingClientRect();" +
              "return {x:Math.round(b.x+40),y:Math.round(b.y+b.height/2),code:r.dataset.code,cls:document.body.className};})()"
            );
          } catch (e) { logLine('[focus]', '取行位置失败 ' + e.message); return; }
          if (!pt) { logLine('[focus]', '调试点行：没找到第 ' + idx + ' 行'); return; }
          win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
          logLine('[focus]', '调试单击行 ' + pt.code + ' 之前 body=' + pt.cls);
        }, 2600);
      }
      setTimeout(async function () {
        const target = (which === 'settings' && settingsWin) ? settingsWin : win;
        if (!target || target.isDestroyed()) return;
        // 调试：TICKER_SHOT_DUMP=1 打出每支标的的点数 / x 轴长度 / 昨收，排查折线画不出来
        if (process.env.TICKER_SHOT_DUMP) {
          try {
            const txt = await target.webContents.executeJavaScript(
              "window.ticker.getQuotes().then(function(r){return JSON.stringify({period:r.period,list:(r.list||[]).map(function(x){" +
              "return {c:x.code,pts:(x.points||[]).length,xi:x.xIndex?x.xIndex.length:-1,prev:x.prevClose,ok:x.ok};})});})"
            );
            logLine('[dump]', String(txt));
            const dom = await target.webContents.executeJavaScript(
              "JSON.stringify([].slice.call(document.querySelectorAll('#app .row')).map(function(r){" +
              "var p=r.querySelector('polyline');var s=p?p.getAttribute('points')||'':'';" +
              "return {c:r.dataset.code,len:s.length,head:s.slice(0,44),stroke:p?getComputedStyle(p).stroke:''};}))"
            );
            logLine('[dom]', String(dom));
          } catch (e) { logLine('[dump]', 'fail ' + e.message); }
        }
        // 调试：TICKER_SHOT_LAYOUT=1 时把各区块实际尺寸打进日志，排查布局问题
        if (process.env.TICKER_SHOT_LAYOUT) {
          try {
            const txt = await target.webContents.executeJavaScript(
              "(function(){var r=function(id){var e=document.getElementById(id);if(!e)return null;" +
              "var b=e.getBoundingClientRect();return [Math.round(b.x),Math.round(b.y),Math.round(b.width),Math.round(b.height)];};" +
              "var row=document.querySelector('.row');var rb=row?row.getBoundingClientRect():null;" +
              "return JSON.stringify({win:[innerWidth,innerHeight],left:r('left'),app:r('app'),focus:r('focus'),chart:r('chart')," +
              "splitter:r('splitter')," +
              "scroll:(function(){var a=document.getElementById('app');return a?[a.scrollHeight,a.clientHeight]:null;})()," +
              "row:rb?[Math.round(rb.width),Math.round(rb.height)]:null,lw:getComputedStyle(document.body).getPropertyValue('--left-w')," +
              "active:(function(){var a=document.querySelector('.row.active');return a?a.dataset.code:null;})()," +
              "sort:(function(){var b=document.getElementById('sort-btn');if(!b)return null;" +
              "return [b.textContent,b.className,Math.round(b.getBoundingClientRect().width),Math.round(b.getBoundingClientRect().height)];})()," +
              "cls:document.body.className,dbg:(function(){var c=document.getElementById('chart');return c?(c.dataset.dbg||''):'';})()});})()"
            );
            logLine('[layout]', String(txt));
          } catch (e) {
            logLine('[layout]', 'fail ' + e.message);
          }
        }
        const img = await target.webContents.capturePage();
        // 打包后 ROOT 在只读的 app.asar 里，截图得落到可写的 DATA_DIR
        const dir = path.join(DATA_DIR, '.dev');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        const file = which === 'settings' ? 'settings.png' : which === 'focus' ? 'focus.png' : 'self.png';
        fs.writeFileSync(path.join(dir, file), img.toPNG());
        app.quit();
      }, which === 'settings' ? 7000 : which === 'focus' ? 6500 : 5000);
    });
  }

  win.on('moved', function () {
    if (!win) return;
    const pos = win.getPosition();
    config.pos = { x: pos[0], y: pos[1] };
    // 拖到别处后背景可能完全变了，落定重采一次（和 drag-end 共用同一套去抖，
    // 以前两边各发一次，一次拖动结束会连截两张图）
    if (probeMoveTimer) clearTimeout(probeMoveTimer);
    probeMoveTimer = setTimeout(function () {
      // 不重置 autoSettled：迟滞状态保持连续，按当前配色的衬底阈值重判一次
      scheduleProbe(0);
    }, 260);
  });

  // 四边都能拖：宽 220-640、高 56-900，min/max 已在窗口选项里限死。
  // 手动调过高度后就以手动值为准，不再被内容自动撑开；
  // 如果拖回去正好等于内容高度，就自动恢复成"跟随内容"。
  let sizeSaveTimer = null;
  win.on('resize', function () {
    if (!win || win.isDestroyed()) return;
    resizingAt = Date.now();
    if (Date.now() < skipResizeUntil) return;   // 聚焦展开/收起是程序改的，别当成用户拖动
    if (sizeSaveTimer) clearTimeout(sizeSaveTimer);
    sizeSaveTimer = setTimeout(function () {
      if (!win || win.isDestroyed()) return;
      const size = win.getSize();
      const w = size[0];
      const h = size[1];
      if (focusOn) {
        // 聚焦时拖的是图表栏宽度：总宽减去左侧列表宽度，列表宽度不变
        focusChartW = Math.max(160, Math.min(1200, w - focusLeftW));
        config.focusChartWidth = focusChartW;
        saveConfig();
        broadcast();
        return;
      }
      config.width = Math.max(220, Math.min(640, w));
      config.height = Math.abs(h - autoFitHeight) > 4 ? h : 0;
      saveConfig();
      broadcast();
    }, 300);
  });

  win.on('closed', function () {
    win = null;
    focusOn = false;
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const winH = Math.max(520, Math.min(560, area.height - 70));

  settingsWin = new BrowserWindow({
    width: 650,
    height: winH,
    minWidth: 580,
    minHeight: 480,
    title: '盯盘设置',
    backgroundColor: '#14171d',
    autoHideMenuBar: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.loadFile(path.join(RES_DIR, 'settings', 'index.html'));
  // 设置面板关闭时，主窗口宽度回到 config.width：
  // 没点保存 → 滑块预览没写进 config，自然还原到原始宽度；
  // 点了保存 → config.width 已是新值，保持新宽度。
  settingsWin.on('closed', function () {
    settingsWin = null;
    if (win && !win.isDestroyed() && !focusOn) {
      // 聚焦展开时保持当前尺寸（列表+图表栏），收起时再回 config.width
      const w = Math.max(220, Math.min(640, Math.round(config.width || 320)));
      win.setSize(w, win.getSize()[1]);
    }
  });
}

/* ---------------- 聚焦图表：单标的分时 / 5日 / 日K ---------------- */

// 聚焦不是另开窗口：直接把浮窗本身加宽加高，上面照旧是自选列表，下面挂图表。
let focusOn = false;
let focusCode = '';
let focusTab = 'minute';
let focusHotkeyAcc = '';
let focusRestore = null;      // 展开前的窗口位置尺寸，收起时原样还原
let focusChartW = 620;        // 图表栏宽度，拖窗口时自动记住（config.focusChartWidth）
let focusLeftW = 320;         // 展开时左侧列表占的宽度 = 展开前的窗口宽度
let skipResizeUntil = 0;      // 程序化改尺寸期间，别当成用户拖动落盘

// 聚焦时上下键翻的就是左列显示的那几行（config.symbols），
// 而不是背后更长的 watchlist —— 否则高亮行会跟着跑到看不见的地方
function focusList() {
  const shown = (config.symbols || []).filter(Boolean);
  const base = shown.length
    ? shown.slice()
    : ((config.watchlist && config.watchlist.length) ? config.watchlist.slice() : []);
  // 开了涨跌幅排序时，↑↓ 和「第几个/共几个」要跟着屏幕上的顺序走。
  // 只在两份清单是同一批标的时才替换，避免刚改完自选、行情还没刷新时错位。
  const displayCodes = quoteService.getDisplayCodes();
  if (displayCodes.length === base.length &&
      displayCodes.every(function (c) { return base.indexOf(c) >= 0; })) {
    return displayCodes;
  }
  return base;
}

function focusMeta() {
  const list = focusList();
  const hit = focusService.peek(focusCode, focusTab);
  return {
    on: focusOn,
    code: focusCode,
    tab: focusTab,
    tabs: FOCUS_TABS,
    list: list,
    index: list.indexOf(focusCode),
    total: list.length,
    name: (hit && hit.name) || NAMES[focusCode] || focusCode,
    hotkey: focusHotkeyAcc,
    leftW: Math.round(focusLeftW),
    chartW: focusChartW
  };
}

function pushFocusState() {
  if (!win || win.isDestroyed()) return;
  try { win.webContents.send('focus-state', focusMeta()); } catch (e) {}
}

// 拖分界线：窗口总宽不变，只是把宽度在「列表」和「图表」之间重新分配。
// 松手后把左列宽度写回 config.width，这样收起窗口后列表宽度跟手调的一致，下次展开也沿用它。
function focusSetSplit(leftW) {
  if (!win || win.isDestroyed() || !focusOn) return;
  const total = win.getSize()[0];
  const maxLeft = Math.max(FOCUS_LEFT_MIN, Math.min(FOCUS_LEFT_MAX, total - FOCUS_CHART_KEEP));
  const lw = Math.max(FOCUS_LEFT_MIN, Math.min(Math.round(leftW), maxLeft));
  focusLeftW = lw;
  focusChartW = Math.max(120, total - lw);
  config.width = lw;
  config.focusChartWidth = focusChartW;
  // 收起时要还原到的宽度也跟着改，否则列表会被裁掉一截
  if (focusRestore) focusRestore.width = lw;
  saveConfig();
  logLine('[focus]', '分界线 ' + lw + ' / 图表 ' + focusChartW);
  pushFocusState();
}

// 展开方式：不改高度，只把窗口往右边加宽（右边顶到屏幕边缘时改往左加宽），
// 左边这一块宽度保持原样，多出来的部分给图表。这样列表位置和字号完全不变。
const FOCUS_CHART_MIN = 320;
const FOCUS_CHART_MAX = 1100;
const FOCUS_CHART_DEFAULT = 620;
// 拖分界线时的边界：左列不能窄于收起状态的最小窗口宽度，也不能宽过 640（收起时的 maxWidth），
// 右边永远给图表留 200px，否则 K 线挤成一团没法看
const FOCUS_LEFT_MIN = 220;
const FOCUS_LEFT_MAX = 640;
const FOCUS_CHART_KEEP = 200;

function focusTargetBounds() {
  const cur = win.getBounds();
  const area = screen.getDisplayMatching(cur).workArea;
  const leftW = Math.round(cur.width);
  let chartW = Math.round(config.focusChartWidth || FOCUS_CHART_DEFAULT);
  if (!isFinite(chartW)) chartW = FOCUS_CHART_DEFAULT;
  chartW = Math.max(FOCUS_CHART_MIN, Math.min(FOCUS_CHART_MAX, chartW));
  // 屏幕放不下就压缩图表栏，宁可窄一点也不能溢出可视区
  const room = area.width - leftW - 8;
  chartW = Math.max(160, Math.min(chartW, room));
  const width = leftW + chartW;
  const height = Math.min(cur.height, area.height);

  // 优先向右扩；右侧放不下就整体向左挪，右边缘保持不动
  let x = cur.x;
  if (x + width > area.x + area.width) x = cur.x - (width - cur.width);
  x = Math.max(area.x, Math.min(x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(cur.y, area.y + area.height - height));
  return { x: x, y: y, width: width, height: height, leftW: leftW, chartW: chartW };
}

function setFocus(on) {
  if (!win || win.isDestroyed()) return;
  on = !!on;
  if (on === focusOn) { if (on) pushFocusState(); return; }

  if (on) {
    const list = focusList();
    if (!focusCode || list.indexOf(focusCode) < 0) {
      const first = (config.symbols || []).filter(function (c) { return list.indexOf(c) >= 0; })[0];
      focusCode = first || list[0] || 'sh000001';
    }
    const b = focusTargetBounds();
    focusRestore = win.getBounds();
    focusLeftW = b.leftW;
    focusChartW = b.chartW;
    focusOn = true;
    // maxWidth 平时卡在 640，展开前先放开，否则 setBounds 会被裁回 640
    try { win.setMaximumSize(1600, 900); } catch (e) {}
    skipResizeUntil = Date.now() + 900;
    resizingAt = Date.now();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    win.focus();
    logLine('[focus]', '展开图表 ' + focusCode + ' tab=' + focusTab + ' 宽度 ' + b.leftW + '+' + b.chartW);
  } else {
    focusOn = false;
    const r = focusRestore;
    focusRestore = null;
    try { win.setMaximumSize(640, 900); } catch (e) {}
    if (r) {
      skipResizeUntil = Date.now() + 900;
      resizingAt = Date.now();
      win.setBounds(r);
    }
    logLine('[focus]', '收起图表');
  }
  pushFocusState();
}

function focusStep(dir) {
  if (!focusOn) return;
  const list = focusList();
  if (!list.length) return;
  let i = list.indexOf(focusCode);
  if (i < 0) i = 0;
  i = (i + (dir > 0 ? 1 : -1) + list.length) % list.length;
  focusCode = list[i];
  logLine('[focus]', '切换标的自选 ' + focusCode);
  pushFocusState();
}

// 鼠标点行切换标的（跟 ↑↓ 走同一条路，只是不用键盘）
function focusSelect(code) {
  if (!focusOn || !code || code === focusCode) return;
  const list = focusList();
  if (list.indexOf(code) < 0) return;
  focusCode = code;
  logLine('[focus]', '点选标的 ' + code);
  pushFocusState();
}

function focusSetTab(tab) {
  if (FOCUS_TABS.indexOf(tab) < 0 || tab === focusTab) return;
  focusTab = tab;
  pushFocusState();
}

// Ctrl+Alt+F 全局唤起；再按一次收起
function toggleFocus() { setFocus(!focusOn); }

function registerFocusHotkey() {
  // 优先用新 shortcuts.focus，兼容旧 focusHotkey 字段
  const acc = (config.shortcuts && config.shortcuts.focus) || config.focusHotkey || 'Ctrl+Alt+F';
  try { if (focusHotkeyAcc) globalShortcut.unregister(focusHotkeyAcc); } catch (e) {}
  let ok = false;
  try { ok = globalShortcut.register(acc, function () { logLine('[hotkey]', '触发 ' + acc); toggleFocus(); }); } catch (e) {}
  focusHotkeyAcc = acc;
  logLine('[hotkey]', '聚焦图表 ' + acc + (ok ? ' 注册成功' : ' 注册失败（可能被其它程序占用）'));
}

/* ---------------- 背景明暗自动检测 ---------------- */
// 直接截屏采样"窗口背后"那块区域 —— 桌面壁纸、浏览器、编辑器、视频画面都算在内，
// 用亮度统计量决定文字该配亮色还是暗色。窗口自己的文字和折线在采样区里占比很小，
// 统计时天然会被忽略，所以不需要隐藏窗口，也就不会闪烁。

const PROBE_INTERVAL_DEFAULT = 4000;  // 默认轮询间隔（4 秒），可在设置里调
const SCREEN_RETRY_EVERY = 8;  // 截屏失败后隔这么多个周期重试一次（约 30 秒）

let autoTextMode = config.lastEffectiveTextMode === 'dark' ? 'dark' : 'light';
let autoSettled = false;   // 是否已完成首次判定
let probeTimer = null;
let probeBusy = false;
let probeFails = 0;
let probeTick = 0;
let probeMoveTimer = null;

function effectiveTextMode() {
  if (config.textMode !== 'auto') return config.textMode === 'dark' ? 'dark' : 'light';
  return autoTextMode;
}

function statePayload() {
  return Object.assign({}, config, { effectiveTextMode: effectiveTextMode() });
}

// 只跟"配色"有关的那几个字段
function themePayload() {
  return {
    effectiveTextMode: effectiveTextMode(),
    backdrop: !!config.backdrop,
    backdropOpacity: config.backdropOpacity
  };
}

// 单个像素的感知亮度。toBitmap 的通道顺序随平台而异（Windows 是 BGRA，
// macOS 是 RGBA），但两种排布里通道 1 都是绿色，红蓝互换。
// 所以绿色按真实权重给足、红蓝各取一半权重，既不吃通道顺序的亏，
// 又比原来的等权平均准得多：等权平均会把纯绿（0,255,0）算成 0.33 判成"暗"，
// 结果在亮绿底上强上浅色字，根本看不清。
function pixelLuma(buf, i) {
  return (0.1424 * buf[i] + 0.7152 * buf[i + 1] + 0.1424 * buf[i + 2]) / 255;
}

// 统计量优先用「众数」：采样区里大面积的是同一种背景（单一亮度、形成主峰），
// 浮窗自己的文字/数字/折线只是小面积分散像素，主峰天然落在背景值上。
// 但主峰不可信时（渐变壁纸、半个屏幕白半个屏幕黑这类高对比画面，直方图是平的
// 或者双峰）众数就是个随机数，会来回跳。这时退回中位数：中位数对"少数文字像素"
// 和"大片渐变"都稳。主峰占比就是这个可信度指标。
function lumaFromBins(bins, n) {
  if (!n) return null;
  const BINS = bins.length;
  let peak = 0;
  for (let k = 1; k < BINS; k++) if (bins[k] > bins[peak]) peak = k;

  const lo = Math.max(0, peak - 2);
  const hi = Math.min(BINS - 1, peak + 2);
  let inPeak = 0;
  for (let k = lo; k <= hi; k++) inPeak += bins[k];

  // 主峰只占三成以下：画面没有明确主色，众数不可信，用直方图中位数兜底。
  // 半黑半白这种双峰画面，中位数落在中间空档 → 落在迟滞带里 → 保持当前配色不乱切。
  if (inPeak / n < 0.30) {
    let acc2 = 0;
    for (let k = 0; k < BINS; k++) {
      acc2 += bins[k];
      if (acc2 * 2 >= n) return (k + 0.5) / BINS;
    }
    return 0.5;
  }

  // 主峰 ±2 bin 邻域加权平均，平滑直方图量化误差
  let acc = 0, cnt = 0;
  for (let k = lo; k <= hi; k++) {
    if (!bins[k]) continue;
    acc += ((k + 0.5) / BINS) * bins[k];
    cnt += bins[k];
  }
  return cnt ? acc / cnt : null;
}

// 把几张采样图并成一个直方图再统计：采样窗口外面一圈时是好几条边，
// 分开统计再平均没有意义，合成一张直方图才等价于"整圈一起看"
const LUMA_BINS = 128;
function lumaFromImages(images) {
  const bins = new Array(LUMA_BINS).fill(0);
  let n = 0;
  for (let j = 0; j < images.length; j++) {
    const img = images[j];
    if (!img || img.isEmpty()) continue;
    const buf = img.toBitmap();
    if (!buf || buf.length < 4) continue;
    const cnt = Math.floor(buf.length / 4);
    for (let i = 0; i < cnt; i++) {
      bins[Math.min(LUMA_BINS - 1, Math.floor(pixelLuma(buf, i * 4) * LUMA_BINS))]++;
      n++;
    }
  }
  return lumaFromBins(bins, n);
}

// 给 getSources 这类"可以永远不返回"的调用加超时：
// 锁屏、UAC 提示、远程桌面、显卡驱动异常时它都可能挂住，一旦挂住而没人打断，
// probeBusy 就永远为 true，配色从此不再更新（而且日志里一个字都不留）。
function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(tag + ' 超时')); }, ms);
    })
  ]);
}

// 截当前屏幕，裁出要统计的那块画面。
// 抓取时按 1/4 分辨率取样：全尺寸每帧要 400ms 上下，1/4 只要 10ms 左右，
// 而判断明暗只需要几千个像素，缩了完全不影响结果。
// 返回若干张小图（窗口里面一张，或窗口外面一圈四张）；返回 null 表示这次截屏失败。
const PROBE_RING_DIP = 42;   // 采样环的宽度（DIP），够大才稳、又不会圈进太远的其它窗口
async function grabProbeImages() {
  const bounds = win.getBounds();
  const disp = screen.getDisplayMatching(bounds);
  const sf = disp.scaleFactor || 1;
  const physW = Math.round(disp.size.width * sf);
  const physH = Math.round(disp.size.height * sf);
  const thumbW = Math.max(320, Math.round(physW / 4));
  const thumbH = Math.max(180, Math.round(physH / 4));

  const sources = await withTimeout(desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
    fetchWindowIcons: false
  }), 3500, 'getSources');
  if (!sources || !sources.length) return null;

  let src = null;
  for (let i = 0; i < sources.length; i++) {
    if (String(sources[i].display_id) === String(disp.id)) { src = sources[i]; break; }
  }
  // 多屏时如果认不出是哪块屏，宁可这次不采，也别拿另一块屏的亮度冒充
  if (!src) return null;
  if (!src.thumbnail || src.thumbnail.isEmpty()) return null;

  const img = src.thumbnail;
  const sz = img.getSize();
  const kx = sz.width / physW;
  const ky = sz.height / physH;

  const x = Math.round((bounds.x - disp.bounds.x) * sf * kx);
  const y = Math.round((bounds.y - disp.bounds.y) * sf * ky);
  const w = Math.round(bounds.width * sf * kx);
  const h = Math.round(bounds.height * sf * ky);

  const out = [];
  function push(rx, ry, rw, rh) {
    const cx = Math.max(0, Math.min(sz.width - 1, Math.round(rx)));
    const cy = Math.max(0, Math.min(sz.height - 1, Math.round(ry)));
    const cw = Math.min(sz.width - cx, Math.round(rw));
    const ch = Math.min(sz.height - cy, Math.round(rh));
    if (cw < 4 || ch < 4) return;
    try { out.push(img.crop({ x: cx, y: cy, width: cw, height: ch })); } catch (e) {}
  }

  if (!config.backdrop) {
    // 没衬底：直接采窗口那块，看到的就是文字压着的背景，最准
    push(x, y, w, h);
    return out;
  }

  // 有衬底：只采窗口「外面」那一圈，绝不采窗口自身。
  // 窗口里面被自己的衬底盖着，背景只透出 (1-α)，而文字/折线的像素噪声
  // 一点都不会随 α 变小 —— 浓度 90% 时信号只剩一成、噪声照旧，
  // 判定必然在高浓度下来回横跳（旧实现除以 1-α 还会把噪声放大 10 倍）。
  // 采窗口外面一圈，背景亮度是直接量出来的，既不用反推、也没有自反馈。
  const rw = Math.max(4, Math.round(PROBE_RING_DIP * sf * kx));
  const lw = Math.min(rw, x);                       // 左边还剩多少余地
  const rrw = Math.min(rw, sz.width - (x + w));
  const th = Math.min(rw, y);
  const bh = Math.min(rw, sz.height - (y + h));
  if (lw >= 4) push(x - lw, y - rw, lw, h + rw * 2);
  if (rrw >= 4) push(x + w, y - rw, rrw, h + rw * 2);
  if (th >= 4) push(x, y - th, w, th);
  if (bh >= 4) push(x, y + h, w, bh);
  return out;
}

// 截屏不可用时（受限环境）退回读系统壁纸缓存。
// 壁纸图里本来就没有窗口自己，所以取窗口那块就是"真正的背景"。
function grabWallpaperRegion() {
  try {
    const p = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
    const img = nativeImage.createFromPath(p);
    if (!img || img.isEmpty()) return [];

    const bounds = win.getBounds();
    const disp = screen.getDisplayMatching(bounds);
    const sf = disp.scaleFactor || 1;
    const sw = disp.size.width * sf;
    const sh = disp.size.height * sf;
    const sz = img.getSize();

    // 近似 Windows「填充」：放大到覆盖屏幕后居中裁切，再取窗口对应区域
    const s = Math.max(sw / sz.width, sh / sz.height);
    const offX = (sw - sz.width * s) / 2;
    const offY = (sh - sz.height * s) / 2;

    const x = Math.round(((bounds.x - disp.bounds.x) * sf - offX) / s);
    const y = Math.round(((bounds.y - disp.bounds.y) * sf - offY) / s);
    const w = Math.max(1, Math.round(bounds.width * sf / s));
    const h = Math.max(1, Math.round(bounds.height * sf / s));

    const cx = Math.max(0, Math.min(sz.width - 1, x));
    const cy = Math.max(0, Math.min(sz.height - 1, y));
    const cw = Math.max(1, Math.min(sz.width - cx, w));
    const ch = Math.max(1, Math.min(sz.height - cy, h));

    const cropped = img.crop({ x: cx, y: cy, width: cw, height: ch })
      .resize({ width: 96, height: 54, quality: 'good' });
    return cropped.isEmpty() ? [] : [cropped];
  } catch (e) {
    return [];
  }
}

const LUMA_TO_DARK = 0.55;   // 背景亮到这个程度 → 换暗色文字（暖黄这类偏亮背景能正确触发）
const LUMA_TO_LIGHT = 0.42;  // 背景暗到这个程度 → 换亮色文字
let lastSwitchAt = 0;        // 切换冷却：刚切完短时间内不再切，防临界区来回
let modeSaveTimer = null;

// 冷却期内不用反复整份写盘，攒一下再落
function saveEffectiveMode() {
  if (modeSaveTimer) return;
  modeSaveTimer = setTimeout(function () {
    modeSaveTimer = null;
    saveConfig();
  }, 3000);
}

// luma 是「纯背景」的亮度：采样区选在窗口外面（有衬底时）或壁纸图里，
// 从来不含窗口自己画的那层衬底，所以这里不需要任何反推/补偿，
// 只有一条对称的迟滞：背景变亮到 0.55 转暗色字，暗到 0.42 转亮色字，
// 中间 0.42~0.55 保持不动，避免在临界值附近来回跳。
function applyLuma(luma, source) {
  if (config.textMode !== 'auto') return;
  const cur = effectiveTextMode();          // 屏幕上真正生效的配色

  let next = cur;
  if (!autoSettled) {
    next = luma >= 0.5 ? 'dark' : 'light';
    autoSettled = true;
  } else if (cur === 'light') {
    if (luma >= LUMA_TO_DARK) next = 'dark';
  } else if (luma <= LUMA_TO_LIGHT) {
    next = 'light';
  }

  if (next === autoTextMode) return;
  // 切换冷却：刚切完 3 秒内不再切，即使采样有小误差也不会快速来回闪
  const now = Date.now();
  if (now - lastSwitchAt < 3000) return;
  lastSwitchAt = now;
  autoTextMode = next;
  config.lastEffectiveTextMode = next;      // 冷启动先按它画，别"先亮后暗"闪一下
  saveEffectiveMode();
  logLine('[bg]', '文字切换为' + (next === 'dark' ? '暗色' : '亮色') +
    '（背景亮度 ' + luma.toFixed(3) + '，采样来源=' + (source || '?') + '）');
  broadcastTheme();
}

// 采样串行化：desktopCapturer 会抢渲染线程，同一时刻只允许一次在跑。
// 另外它偶尔会卡住不返回，所以光靠 probeBusy 会导致配色永久冻结，加个超时硬复位。
const PROBE_TIMEOUT_MS = 12000;
let probeStartedAt = 0;

async function probeBackground() {
  if (!win || win.isDestroyed()) return;
  // 手动指定了配色就不用白费力气截屏
  if (config.textMode !== 'auto') return;
  // 拖动期间跳过采样：desktopCapturer 会抢渲染线程导致 setPosition 卡顿
  if (dragBase) return;
  if (probeBusy) {
    if (Date.now() - probeStartedAt < PROBE_TIMEOUT_MS) return;
    logLine('[bg]', '上次采样超过 ' + Math.round(PROBE_TIMEOUT_MS / 1000) + ' 秒未返回，强制复位');
  }

  probeBusy = true;
  probeStartedAt = Date.now();
  probeTick++;
  let source = '窗口外';
  try {
    let list = null;
    const tryScreen = probeFails < 3 || probeTick % SCREEN_RETRY_EVERY === 0;
    if (tryScreen) {
      try { list = await grabProbeImages(); } catch (e) { list = null; }
      if (list) {
        if (probeFails >= 3) {
          logLine('[bg]', '实时截屏已恢复（之前是壁纸兜底，共失败 ' + probeFails + ' 次）');
        }
        probeFails = 0;
      } else {
        probeFails++;
      }
    }
    // 截不到（或窗口大到外面没剩地方采）就退回壁纸：壁纸图里本来就没有窗口自己
    if (!list || !list.length) {
      list = grabWallpaperRegion();
      source = '壁纸兜底';
    } else if (!config.backdrop) {
      source = '窗口内';
    }
    const luma = lumaFromImages(list || []);
    if (luma != null) applyLuma(luma, source);
    if (process.env.TICKER_DEBUG_BG) {
      console.log('[bg] luma=' + (luma == null ? 'null' : luma.toFixed(3)) +
        ' src=' + source + ' px=' + list.length +
        ' mode=' + effectiveTextMode() + ' auto=' + autoTextMode + ' fails=' + probeFails);
    }
  } catch (e) {
    // 探测失败保持当前配色，不影响主流程
  } finally {
    probeBusy = false;
  }
}

// 采样请求统一走这里去抖：拖动/改设置/切回自动几乎同时都会申请一次，
// 以前是各发各的，一次操作能连截两三张图。
let probeQueued = null;
function scheduleProbe(delay) {
  if (probeQueued) clearTimeout(probeQueued);
  probeQueued = setTimeout(function () {
    probeQueued = null;
    probeBackground();
  }, Math.max(0, delay || 0));
}

function startBackgroundProbe() {
  // 周期轮询背景亮度，间隔默认 4 秒、可在设置里调；手动指定配色时 probeBackground 内部会直接跳过采样
  if (probeTimer) clearInterval(probeTimer);
  if (probeQueued) { clearTimeout(probeQueued); probeQueued = null; }
  let ms = parseInt(config.probeIntervalMs, 10);
  if (!isFinite(ms)) ms = PROBE_INTERVAL_DEFAULT;
  ms = Math.max(1000, Math.min(15000, ms));
  probeTimer = setInterval(function () { scheduleProbe(0); }, ms);
  // 窗口画出来之后再测第一次：太早截到的是还没上屏的空窗口
  scheduleProbe(500);
}

function stopDrag() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  if (dragProbeTimer) { clearInterval(dragProbeTimer); dragProbeTimer = null; }
  dragBase = null;
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state-changed', statePayload());
}

// 配色单独一条通道：换色不该连带触发渲染层"重拉行情"，否则背景一亮一暗
// 整个列表就淡到 30% 再弹回来，看着像重载。
function broadcastTheme() {
  if (win && !win.isDestroyed()) win.webContents.send('theme-changed', themePayload());
}

function setAndBroadcast(patch, clearCache) {
  const prevTextMode = config.textMode;
  Object.assign(config, patch);
  if (patch.alwaysOnTop !== undefined && win) win.setAlwaysOnTop(!!patch.alwaysOnTop);
  // 聚焦展开时别改窗口宽度：宽度由列表+图表栏决定，宽度值先落 config，收起后自然生效
  if (patch.width !== undefined && win && isFinite(patch.width) && !focusOn) {
    const w = Math.max(220, Math.min(640, Math.round(patch.width)));
    const h = win.getSize()[1];
    win.setSize(w, h);
  }
  if (clearCache) quoteService.resetSeriesCache();

  // 从手动切回自动：先沿用刚才那个配色，等采样回来再修正，
  // 免得「点了自动」先跳成历史配色再跳回来。
  if (patch.textMode === 'auto' && prevTextMode !== 'auto') {
    autoTextMode = prevTextMode === 'dark' ? 'dark' : 'light';
    config.lastEffectiveTextMode = autoTextMode;
  }
  // 配色相关参数变了就立刻重测一次，不用干等下一个轮询周期。
  // 采样区在窗口外面，不受衬底重绘影响，所以不用额外等
  const themeTouched = patch.textMode !== undefined ||
    patch.backdrop !== undefined || patch.backdropOpacity !== undefined;
  if (themeTouched && config.textMode === 'auto') {
    probeFails = 0;
    scheduleProbe(0);
  }

  saveConfig();
  broadcast();
}

function setPeriod(p) {
  if (PERIODS.indexOf(p) < 0 || config.period === p) return;
  setAndBroadcast({ period: p }, true);
}

function toggleSymbol(code, on) {
  const list = config.symbols.slice();
  const i = list.indexOf(code);
  const changed = (on && i < 0) || (!on && i >= 0);
  if (!changed) return;
  if (on) list.push(code); else list.splice(i, 1);
  if (list.length === 0) return; // 至少留一个标的
  setAndBroadcast({ symbols: list }, true);
}


ipcMain.handle('get-state', function () {
  return {
    textMode: config.textMode,
    effectiveTextMode: effectiveTextMode(),
    backdrop: !!config.backdrop,
    backdropOpacity: config.backdropOpacity,
    showName: config.showName !== false,
    baseline: config.baseline !== false,
    period: config.period,
    interval: config.interval,
    symbols: config.symbols,
    // 这三个以前漏了：冷启动时浮窗拿不到，只能退回默认值
    sparkWidth: config.sparkWidth,
    sortMode: config.sortMode,
    locked: !!config.locked,
    alwaysOnTop: !!config.alwaysOnTop,
    shortcuts: normalizeShortcuts(config.shortcuts)
  };
});

ipcMain.handle('get-quotes', async function () {
  try {
    const list = await fetchAll();
    const ok = list.some(function (x) { return x.ok; });
    return { ok: ok, list: list, period: config.period, at: Date.now() };
  } catch (e) {
    return { ok: false, error: e.message, list: [], period: config.period, at: Date.now() };
  }
});

ipcMain.on('set-height', function (e, h) {
  if (!win || !isFinite(h)) return;
  const height = Math.max(24, Math.round(h));
  autoFitHeight = height;
  // 用户手动拖过高度，或者正在拖，都别按内容改回去
  if (config.height > 0 || Date.now() - resizingAt < 600) return;
  // 聚焦展开时窗口高度 = 列表 + 图表，列表本身的高度只记在 autoFitHeight 里
  if (focusOn) return;
  if (win.getSize()[1] === height) return;
  const pos = win.getPosition();
  win.setBounds({ x: pos[0], y: pos[1], width: config.width || 320, height: height });
});

// 设置面板滑块实时预览宽度：只调窗口尺寸，不落盘；取消/关闭时由设置面板发回原始宽度还原
ipcMain.on('preview-width', function (e, w) {
  if (!win) return;
  if (focusOn) return;  // 聚焦展开时窗口宽度由列表+图表栏决定，别被预览宽度压扁
  const n = parseInt(w, 10);
  if (!isFinite(n)) return;
  const width = Math.max(220, Math.min(640, Math.round(n)));
  if (win.getSize()[0] === width) return;
  win.setSize(width, win.getSize()[1]);
});

ipcMain.on('drag-start', function () {
  if (!win || config.locked) return;
  const pos = win.getPosition();
  const cur = screen.getCursorScreenPoint();
  dragBase = { dx: cur.x - pos[0], dy: cur.y - pos[1] };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(function () {
    if (!win || !dragBase) return;
    const p = screen.getCursorScreenPoint();
    win.setPosition(p.x - dragBase.dx, p.y - dragBase.dy);
  }, 16);
  // 拖动期间不暂停轮询，但 probeBackground 会跳过采样，松手后下一周期自然恢复
});

ipcMain.on('drag-end', function () {
  stopDrag();
  saveConfig();
  // 拖动后落点换了，背后可能是完全不同的画面，稍等一下再测
  scheduleProbe(400);
});

// 图钉固定：开启后窗口不可拖动/拉伸，且鼠标穿透到下层应用
let pinned = false;
ipcMain.on('set-pinned', function (e, on) {
  if (!win || win.isDestroyed()) return;
  pinned = !!on;
  win.setMovable(!pinned);
  win.setResizable(!pinned);
  win.setIgnoreMouseEvents(pinned, { forward: true });
});

// 鼠标移到右上角图钉按钮区域时临时恢复点击，移出后恢复穿透
ipcMain.on('set-pin-zone', function (e, on) {
  if (!win || win.isDestroyed()) return;
  if (!pinned) return;
  win.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on('save-config', function (e, patch) {
  if (!patch || typeof patch !== 'object') return;
  setAndBroadcast(patch, false);
});

/* ---------------- 尾盘提醒 ---------------- */

let alertTimer = null;
let firedKey = '';


// 判断今天是不是交易日：看上证指数快照里的时间戳是不是今天
async function isTradingToday() {
  try {
    const snap = await fetchSnapshots(['sh000001']);
    const s = snap['sh000001'];
    if (!s || !s.time) return false;
    const d = new Date();
    const today = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    return String(s.time).slice(0, 8) === today;
  } catch (e) {
    return false;
  }
}

async function checkAlert() {
  const a = config.alert || {};
  if (!a.enabled) return;

  const d = new Date();
  if (pad2(d.getHours()) + ':' + pad2(d.getMinutes()) !== a.time) return;

  const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + a.time;
  if (firedKey === key) return;
  firedKey = key;

  if (!(await isTradingToday())) return;
  await fireAlert(true);
}

async function fireAlert(countdown) {
  let list = [];
  try { list = await fetchAll(); } catch (e) {}
  const rows = list.filter(function (x) { return x.ok; });

  let title;
  if (countdown) {
    const d = new Date();
    const mins = Math.max(0, Math.round(15 * 60 - (d.getHours() * 60 + d.getMinutes())));
    title = '尾盘提醒 · 距 15:00 申赎截止还有 ' + mins + ' 分钟';
  } else {
    title = '盯盘提醒（测试）';
  }

  const body = rows.slice(0, 6).map(function (x) {
    const pct = isFinite(x.pct) ? (x.pct > 0 ? '+' : '') + x.pct.toFixed(2) + '%' : '--';
    return x.name + '  ' + pct;
  }).join('\n') || '（暂无数据）';

  try {
    const n = new Notification({ title: title, body: body });
    n.on('click', function () {
      if (win) { win.show(); win.focus(); }
    });
    n.show();
  } catch (e) {
    console.error('[alert] 通知失败:', e.message);
  }

  try { shell.beep(); } catch (e) {}

  if (win) {
    try {
      win.flashFrame(true);
      setTimeout(function () {
        try { if (win) win.flashFrame(false); } catch (e) {}
      }, 60000);
    } catch (e) {}
  }
}

function startAlertTimer() {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = setInterval(function () { checkAlert(); }, 20000);
}

/* ---------------- 交易时段：收盘自动退出 / 开盘自启 ---------------- */

const TASK_NAME = 'MiniTicker_AutoOpen';
// 计划任务启动时会带上 --scheduled，用来区分「定时拉起」和「用户手动打开」
const SCHEDULED_LAUNCH = process.argv.indexOf('--scheduled') >= 0 || process.env.TICKER_SCHEDULED === '1';

let autoExitTimer = null;
let closingForDay = false;
// 启动时已经过了收盘时间（比如晚上手动打开看收盘数据）→ 本次会话不自动退出
let sessionAfterClose = false;
let sessionDay = '';

function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function startAutoExitTimer() {
  if (autoExitTimer) clearInterval(autoExitTimer);
  sessionDay = todayKey();
  const exitAt = minutesOf(config.autoExit.time);
  sessionAfterClose = !!(exitAt != null && nowMinutes() >= exitAt);

  autoExitTimer = setInterval(function () {
    if (closingForDay) return;
    if (!config.autoExit || !config.autoExit.enabled) return;

    // 周末不收市，手动开着的窗口不主动踢掉
    const wd = new Date().getDay();
    if (wd === 0 || wd === 6) return;

    // 跨天重置：晚上打开的会话不该拖到第二天还不退
    const day = todayKey();
    if (day !== sessionDay) {
      sessionDay = day;
      sessionAfterClose = false;
    }
    if (sessionAfterClose) return;

    const at = minutesOf(config.autoExit.time);
    if (at == null || nowMinutes() < at) return;

    closingForDay = true;
    console.log('[auto-exit] 已到 ' + config.autoExit.time + '，收盘退出');
    saveConfig();
    app.quit();
  }, 30000);
}

/* ---- 自动启动：Windows 计划任务，工作日定点拉起 ---- */

// 打包后 ps1 在 resources/scripts 下（electron-builder extraResources 带的）
const AUTOSTART_PS = app.isPackaged
  ? path.join(process.resourcesPath, 'scripts', 'autostart.ps1')
  : path.join(RES_DIR, 'scripts', 'autostart.ps1');

// 拉起自己：打包后是 mini-ticker.exe 直跑；开发时是 electron.exe + 项目目录
function selfLaunch() {
  return {
    exe: process.execPath,
    args: app.isPackaged ? [] : [RES_DIR]
  };
}

// 用 PowerShell 的 ScheduledTasks 模块而不是 schtasks.exe：
// 前者不改注册表、不受部分安全软件对 schtasks 的拦截影响。
function runAutostartPs(args, cb) {
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUTOSTART_PS].concat(args),
    { windowsHide: true, timeout: 25000 },
    function (err, stdout, stderr) {
      const out = String(stdout || '').trim();
      const msg = String(stderr || '').trim();
      cb(err, out || msg);
    }
  );
}

function autoStartInstalled(cb) {
  runAutostartPs(['-Mode', 'query', '-TaskName', TASK_NAME], function (err, out) {
    cb(!err && /INSTALLED/.test(out));
  });
}

// 计划任务状态缓存：设置面板每次打开都去问一次太慢，启动/保存时刷新即可
let taskInstalledCache = false;

function refreshTaskInstalledCache() {
  autoStartInstalled(function (ok) {
    taskInstalledCache = ok;
    broadcast();
  });
}

// 安装/更新计划任务：工作日定点拉起本程序
function installAutoStart(time, cb) {
  const at = /^\d{2}:\d{2}$/.test(time) ? time : '09:25';
  const self = selfLaunch();
  runAutostartPs([
    '-Mode', 'install', '-TaskName', TASK_NAME,
    '-StartTime', at, '-ExePath', self.exe,
    '-ExeArgs', self.args.concat(['--scheduled']).join(' ')
  ], function (err, out) {
    const ok = !err && /\bOK\b/.test(out);
    if (!ok) logLine('[autostart]', '创建计划任务失败：' + out);
    else logLine('[autostart]', '计划任务已创建：工作日 ' + at + ' 启动');
    cb(ok, ok ? '' : out);
  });
}

function removeAutoStart(cb) {
  runAutostartPs(['-Mode', 'remove', '-TaskName', TASK_NAME], function () { cb(true); });
}

// 装了任务就装上、关了就把任务删掉
function applyAutoStart(enabled, time, cb) {
  if (enabled) installAutoStart(time, cb);
  else removeAutoStart(function () { cb(true, ''); });
}

// 之前版本提供过「开机自启」，会在注册表 Run 项留一条。
// 现在统一走计划任务，启动时顺手清掉，免得老用户每次开机被多拉一次。
function cleanLoginItem() {
  try {
    if (app.getLoginItemSettings({ path: process.execPath }).openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: [] });
      logLine('[autostart]', '已清理历史遗留的开机启动项');
    }
  } catch (e) {}
}

// 计划任务拉起时，非交易日（法定假日/调休放假）自动关掉，避免空转
function startScheduledTradingCheck() {
  if (!SCHEDULED_LAUNCH) return;

  const MAX_TRIES = 4;
  const RETRY_GAP = 2 * 60 * 1000;
  let tries = 0;

  function check() {
    tries++;
    isTradingToday().then(function (ok) {
      if (ok) {
        logLine('[autostart]', '今天是交易日，正常运行');
        return;
      }
      if (tries >= MAX_TRIES) {
        logLine('[autostart]', '连续 ' + tries + ' 次判定非交易日，退出');
        app.quit();
        return;
      }
      setTimeout(check, RETRY_GAP);
    }).catch(function () {
      if (tries < MAX_TRIES) setTimeout(check, RETRY_GAP);
    });
  }

  // 先让窗口显示出来，再开始检测
  setTimeout(check, 40000);
}


/* ---------------- 设置面板 ---------------- */

ipcMain.handle('settings-get', async function () {
  const codes = [];
  (config.watchlist || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
  (config.symbols || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });

  const names = {};
  codes.forEach(function (c) { if (NAMES[c]) names[c] = NAMES[c]; });
  try {
    const snap = await fetchSnapshots(codes);
    Object.keys(snap).forEach(function (k) {
      if (snap[k] && snap[k].name) names[k] = snap[k].name;
    });
  } catch (e) {}

  // 打开面板时现场问一次计划任务状态：缓存可能还没查完，用户也可能在别处删过任务
  let installed = taskInstalledCache;
  try {
    installed = await new Promise(function (res) { autoStartInstalled(res); });
    taskInstalledCache = installed;
  } catch (e) {}

  return {
    symbols: config.symbols.slice(),
    watchlist: config.watchlist.slice(),
    names: names,
    period: config.period,
    interval: config.interval,
    textMode: config.textMode,
    backdrop: !!config.backdrop,
    backdropOpacity: config.backdropOpacity != null ? config.backdropOpacity : 40,
    probeIntervalMs: config.probeIntervalMs != null ? config.probeIntervalMs : 4000,
    showName: config.showName !== false,
    baseline: config.baseline !== false,
    alwaysOnTop: !!config.alwaysOnTop,
    locked: !!config.locked,
    width: config.width,
    alert: Object.assign({}, config.alert),
    autoExit: Object.assign({}, config.autoExit),
    autoStart: Object.assign({}, config.autoStart),
    shortcuts: normalizeShortcuts(config.shortcuts),
    taskInstalled: installed,
    update: Object.assign({}, updateState),
    updaterOn: UPDATER_ON,
    isPortable: IS_PORTABLE,
    version: app.getVersion()
  };
});

ipcMain.handle('validate-symbol', async function (e, raw) {
  const code = String(raw || '').trim();
  if (!isValidCode(code)) {
    return { ok: false, msg: '代码格式不对：行情类形如 sh600519 / hkHSI / usDJI，场外基金是 6 位数字如 001186' };
  }

  // 场外基金
  if (isFundCode(code)) {
    try {
      const est = await fetchFundEstimates([code]);
      if (est[code]) return { ok: true, code: code, name: est[code].name, fund: true };
      const nav = await fetchFundNav(code);
      if (nav && nav.name && nav.rows.length) return { ok: true, code: code, name: nav.name, fund: true };
      return { ok: false, msg: '没查到这只基金，检查下 6 位代码' };
    } catch (err) {
      return { ok: false, msg: '查询失败：' + err.message };
    }
  }

  try {
    const snap = await fetchSnapshots([code]);
    const keys = Object.keys(snap);
    if (!keys.length) return { ok: false, msg: '没查到这只标的，检查下代码' };
    const k = keys[0];
    return { ok: true, code: k, name: (snap[k] && snap[k].name) || k };
  } catch (err) {
    return { ok: false, msg: '查询失败：' + err.message };
  }
});

ipcMain.handle('search-symbol', async function (e, q) {
  try {
    return { ok: true, list: await searchSymbols(q) };
  } catch (err) {
    return { ok: false, msg: '搜索失败：' + err.message, list: [] };
  }
});

ipcMain.handle('settings-save', async function (e, patch) {
  const result = applySettingsPatch(config, patch);
  if (!result.ok) return result;

  setAndBroadcast(result.patch, true);

  // 聚焦图表快捷键变了，重新注册全局快捷键（可能在保存时注册失败，日志可见）
  if (result.effects.reRegisterHotkey) registerFocusHotkey();

  // 轮询间隔改了，重启定时器让新值立即生效
  startBackgroundProbe();

  // 自启跟着保存动作同步：开了就装/更新计划任务，关了就把任务删掉
  let taskMsg = '';
  const taskOk = await new Promise(function (res) {
    applyAutoStart(result.patch.autoStart.enabled, result.patch.autoStart.time, res);
  });
  if (!taskOk) taskMsg = '，但写入计划任务失败（可尝试用管理员身份运行一次）';
  taskInstalledCache = result.patch.autoStart.enabled && taskOk;

  // 收盘退出时间/开关改了，定时器要按新配置重算
  sessionDay = todayKey();
  const exitAt = minutesOf(result.patch.autoExit.time);
  sessionAfterClose = !!(result.patch.autoExit.enabled && exitAt != null && nowMinutes() >= exitAt);

  return { ok: true, msg: taskMsg };
});

ipcMain.on('open-settings', function () { openSettings(); });

/* ---------------- 聚焦图表 IPC ---------------- */

ipcMain.handle('focus-state', function () { return focusMeta(); });

ipcMain.handle('focus-data', async function () {
  try {
    const data = await focusService.payload(focusCode, focusTab);
    return Object.assign({ ok: true }, data);
  } catch (e) {
    logLine('[focus]', '取数失败 ' + focusCode + ' (' + focusTab + ')：' + e.message);
    return { ok: false, error: e.message, code: focusCode, tab: focusTab, name: NAMES[focusCode] || focusCode };
  }
});

ipcMain.on('focus-open', function (e, code) {
  if (code && focusList().indexOf(code) >= 0) focusCode = code;
  setFocus(true);
});
ipcMain.on('focus-toggle', function () { toggleFocus(); });
ipcMain.on('focus-step', function (e, dir) { focusStep(dir); });
ipcMain.on('focus-select', function (e, code) { focusSelect(code); });
ipcMain.on('focus-tab', function (e, tab) { focusSetTab(tab); });
ipcMain.on('focus-split', function (e, leftW) {
  if (!isFinite(leftW)) return;
  focusSetSplit(leftW);
});
ipcMain.on('focus-close', function () { logLine('[focus]', 'IPC focus-close'); setFocus(false); });

ipcMain.on('set-period', function (e, p) {
  if (PERIODS.indexOf(p) >= 0) setPeriod(p);
});

ipcMain.on('settings-close', function () {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// 右键菜单只有两项：其余操作（周期、刷新、高度、聚焦）都有快捷键或在设置面板里
/* ---------------- 自动更新（仅安装版） ---------------- */

// 便携版的 exe 只是个自解压包：每次双击解压到随机的临时目录，运行的其实是那份副本。
// electron-updater 要原地替换安装目录里的文件，便携版没有稳定目录，官方不支持。
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
// TICKER_UPDATE_TEST 让开发模式也能跑更新流程（打包前验证用，正常不会设）
const UPDATER_ON = (app.isPackaged || !!process.env.TICKER_UPDATE_TEST) && !IS_PORTABLE;
const TEST_MODE = !app.isPackaged && !!process.env.TICKER_UPDATE_TEST;

let autoUpdater = null;
// status: idle / checking / current / available / downloading / ready / error
const updateState = { status: 'idle', available: '', progress: 0, message: '' };

// 更新源，按顺序轮着试。国内直连 GitHub 下载实测只有 18KB/s，76MB 的包要一个多小时，
// 等于永远更新不上。所以默认走 Gitee（实测 2MB/s，35 秒下完），
// 它挂了退到公益加速站，最后才轮到 GitHub —— 留一手总比全挂强。
// Gitee 没有 GitHub 那种 releases/latest/download 固定别名，路径必须带 tag，
// 所以它的 latest.yml 当普通文件放在仓库 update/ 下，yml 里的下载地址写绝对路径。
let UPDATE_FEEDS = [
  { key: 'gitee', url: 'https://gitee.com/qqten/mini-ticker/raw/main/update' },
  { key: 'ghfast', url: 'https://ghfast.top/https://github.com/qqten/mini-ticker/releases/latest/download' },
  { key: 'github', url: 'https://github.com/qqten/mini-ticker/releases/latest/download' }
];
let feedOrder = UPDATE_FEEDS.slice();
let feedIndex = 0;
let feedRetryTimer = null;
// 用于识别「同一次失败重复上报」的陈旧 error 事件
let lastErrMsg = '';
let lastErrAt = 0;

function pushUpdate(patch) {
  Object.assign(updateState, patch);
  logLine('[update]', [updateState.status, updateState.available,
    updateState.progress ? updateState.progress + '%' : '', updateState.message]
    .filter(Boolean).join(' · '));
  const payload = Object.assign({}, updateState);
  if (win && !win.isDestroyed()) win.webContents.send('update-state', payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update-state', payload);
}

// 网络错误的 message 里带着整段 HTTP 响应头，动辄好几 KB，
// 日志和状态里只留第一行、限 180 字符，够定位问题又不刷屏
function shortErr(e) {
  var m = String((e && e.message) || e).split('\n')[0].trim();
  return m.length > 180 ? m.slice(0, 180) + '…' : m;
}

// 上次成功的源排最前：网络环境不会每次都变，没必要每轮都从失败的那个开始试
function buildFeedOrder() {
  var last = config.updateFeed;
  var first = UPDATE_FEEDS.filter(function (f) { return f.key === last; })[0];
  feedOrder = first
    ? [first].concat(UPDATE_FEEDS.filter(function (f) { return f.key !== last; }))
    : UPDATE_FEEDS.slice();
  feedIndex = 0;
}

function applyFeed() {
  var f = feedOrder[feedIndex];
  if (!f) return null;
  autoUpdater.setFeedURL({ provider: 'generic', url: f.url });
  logLine('[update]', '源 ' + (feedIndex + 1) + '/' + feedOrder.length + '：' + f.key + ' → ' + f.url);
  return f;
}

// 换下一个源。全都试完返回 false，让调用方收手，别死循环
function rotateFeed() {
  if (feedIndex >= feedOrder.length - 1) return false;
  feedIndex += 1;
  applyFeed();
  return true;
}

function rememberFeed() {
  var f = feedOrder[feedIndex];
  if (f && config.updateFeed !== f.key) {
    config.updateFeed = f.key;
    saveConfig();
  }
}

// 同一次失败会从两个地方上报（'error' 事件 + checkForUpdates 的 promise 拒绝），
// 不去重就会拿旧错误覆盖刚换源后的新状态。返回 true 表示这是一条新错误。
function reportUpdateError(e) {
  var msg = shortErr(e);
  var now = Date.now();
  if (msg === lastErrMsg && now - lastErrAt < 2000) return false;
  lastErrMsg = msg;
  lastErrAt = now;
  pushUpdate({ status: 'error', message: msg });
  return true;
}

// 本次运行已经问过的版本号：同一个版本只弹一次，选「稍后」就别再烦他
let restartAsked = '';

// 静默装完 + 自动拉起浮窗。isSilent=true 不弹安装界面，
// isForceRunAfter=true 让新版装完自己起来，不用用户再去点图标
function quietInstall() {
  if (!autoUpdater) return;
  try {
    autoUpdater.quitAndInstall(true, true);
  } catch (e) {
    logLine('[update]', 'quitAndInstall 失败：' + shortErr(e));
  }
}

// 「是否现在就更新」弹窗：点「立即重启」= 静默装完自动拉起
function askRestart(version) {
  if (!version || restartAsked === version) return;
  restartAsked = version;
  const opts = {
    type: 'question',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Mini Ticker 有新版本',
    message: 'v' + version + ' 已下载完成',
    detail: '现在重启就能用上新版本，大约 2 秒，自选和设置都会保留。\n' +
      '选「稍后」则等你下次退出浮窗时自动装好，下次打开就是新版。'
  };
  let p;
  try {
    p = (win && !win.isDestroyed()) ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  } catch (e) {
    logLine('[update]', '弹窗失败 ' + shortErr(e));
    return;
  }
  p.then(function (r) {
    if (r.response !== 0) {
      logLine('[update]', '用户选择稍后更新');
      return;
    }
    logLine('[update]', '用户选择立即重启更新');
    // 让弹窗先关掉再退出，否则窗口会残留半帧
    setTimeout(quietInstall, 80);
  }).catch(function (e) {
    logLine('[update]', '弹窗失败 ' + shortErr(e));
  });
}

function initUpdater() {
  if (!UPDATER_ON) {
    logLine('[update]', IS_PORTABLE ? '便携版，跳过自动更新' : '开发模式，跳过自动更新');
    return;
  }
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    logLine('[update]', 'electron-updater 加载失败：' + e.message);
    return;
  }

  autoUpdater.autoDownload = true;
  // 下好就等下次正常退出时静默装上，不打断盯盘，也不会突然重启窗口。
  // 本地 feed 测试时不自动装，免得测一次就把本机重装一遍。
  autoUpdater.autoInstallOnAppQuit =
    !TEST_MODE && !process.env.TICKER_UPDATE_FEED && !process.env.TICKER_UPDATE_FEEDS;
  // 开发模式（未打包）默认跳过更新检查，测试时强制打开
  if (TEST_MODE) autoUpdater.forceDevUpdateConfig = true;
  // 调试时可以指到本地静态目录，省得为了试一次就发版
  const TEST_FEED = process.env.TICKER_UPDATE_FEED;
  if (TEST_FEED) {
    autoUpdater.setFeedURL({ provider: 'generic', url: TEST_FEED });
    logLine('[update]', '测试 feed: ' + TEST_FEED);
  }
  // 调试：TICKER_UPDATE_FEEDS="url1,url2" 覆盖源列表，用来验证轮换
  const TEST_FEEDS = process.env.TICKER_UPDATE_FEEDS;
  if (TEST_FEEDS) {
    UPDATE_FEEDS = TEST_FEEDS.split(',')
      .map(function (u, i) { return { key: 'test' + (i + 1), url: u.trim() }; })
      .filter(function (f) { return f.url; });
    logLine('[update]', '测试源列表：' + UPDATE_FEEDS.map(function (f) { return f.url; }).join(' | '));
  }

  autoUpdater.on('checking-for-update', function () {
    pushUpdate({ status: 'checking', message: '' });
  });
  autoUpdater.on('update-available', function (info) {
    rememberFeed();
    pushUpdate({
      status: 'available',
      available: info.version,
      message: '发现 v' + info.version + '，正在后台下载'
    });
  });
  autoUpdater.on('update-not-available', function () {
    rememberFeed();
    pushUpdate({ status: 'current', message: '' });
  });
  autoUpdater.on('download-progress', function (p) {
    pushUpdate({ status: 'downloading', progress: Math.round(p.percent || 0) });
  });
  autoUpdater.on('update-downloaded', function (info) {
    pushUpdate({
      status: 'ready',
      available: info.version,
      message: 'v' + info.version + ' 已下载，等待重启生效'
    });
    // 下载完就直接问一句要不要现在换：以前只在退出时装，
    // 等于每次更新都得用户自己关掉浮窗、再点一次图标
    askRestart(info.version);
  });
  autoUpdater.on('error', function (e) {
    var cur = feedOrder[feedIndex];
    var fresh = reportUpdateError(e);
    logLine('[update]', '源 ' + (cur ? cur.key : '?') + (fresh ? ' 失败：' : ' 重复报错，忽略：') + shortErr(e));
    if (!fresh) return;
    // 国内连 GitHub 连不上是常态，所以失败不等于结束：换下一个源接着试
    if (TEST_FEED) return;
    // 只排一个重试，免得同一时间打好几个请求
    if (feedRetryTimer) return;
    if (!rotateFeed()) {
      logLine('[update]', '所有更新源都试过了，本轮放弃');
      return;
    }
    feedRetryTimer = setTimeout(function () {
      feedRetryTimer = null;
      pushUpdate({ status: 'checking', message: '换个源再试…' });
      autoUpdater.checkForUpdates().catch(function () {});
    }, 1200);
  });

  // 晚一点再查：先把窗口和第一屏行情拉出来，别和启动抢带宽
  setTimeout(function () {
    checkForUpdates(false);
  }, 25000);
}

function checkForUpdates(manual) {
  if (!autoUpdater) {
    if (manual) {
      try {
        new Notification({
          title: '当前版本不支持自动更新',
          body: IS_PORTABLE
            ? '便携版没有固定安装目录，请到 GitHub Releases 下载新版'
            : '开发模式下不检查更新'
        }).show();
      } catch (e) {}
    }
    return;
  }
  // 已经下好了：再点「检查更新」就是想现在换上，直接弹窗问，别再查一遍
  if (manual && updateState.status === 'ready' && updateState.available) {
    restartAsked = '';
    askRestart(updateState.available);
    return;
  }
  // 新的一轮：从上次成功的源重新排起，别接着上一轮的失败位置往下走
  if (!process.env.TICKER_UPDATE_FEED) {
    buildFeedOrder();
    applyFeed();
  }
  pushUpdate({ status: 'checking', message: manual ? '正在检查…' : '' });
  autoUpdater.checkForUpdates().catch(function (e) {
    // 只上报状态，换源的事交给 'error' 事件处理，避免两边都动手
    reportUpdateError(e);
  });
}

function buildMainMenu() {
  return Menu.buildFromTemplate([
    { label: '设置…', accelerator: 'CmdOrCtrl+,', click: function () { openSettings(); } },
    { label: '检查更新…', click: function () { checkForUpdates(true); } },
    { type: 'separator' },
    { label: '退出', click: function () { app.quit(); } }
  ]);
}

ipcMain.on('open-menu', function () {
  if (!win) return;
  buildMainMenu().popup({ window: win });
});

// 设置面板触发：手动检查更新 / 下载完成后立即重启安装
ipcMain.on('check-update', function () { checkForUpdates(true); });
ipcMain.on('install-update', function () {
  if (!autoUpdater) return;
  logLine('[update]', '设置面板点击重启安装');
  quietInstall();
});

ipcMain.on('test-alert', function () { fireAlert(false); });

/* ---------------- 闪退排查埋点 ---------------- */

logLine('[boot]', 'pid=' + process.pid + ' scheduled=' + SCHEDULED_LAUNCH +
  ' argv=' + JSON.stringify(process.argv.slice(1)));

process.on('uncaughtException', function (e) {
  logLine('[uncaught]', (e && e.stack) || String(e));
});
process.on('unhandledRejection', function (e) {
  logLine('[unhandled]', (e && e.stack) || String(e));
});

// 包一层 app.quit：谁让它退的、从哪一行调的，全留档
const rawQuit = app.quit.bind(app);
app.quit = function () {
  const st = String(new Error().stack || '').split('\n').slice(2, 5).map(function (s) {
    return s.trim();
  }).join(' <- ');
  logLine('[quit]', st);
  return rawQuit();
};

app.on('child-process-gone', function (e, d) { logLine('[child-gone]', JSON.stringify(d)); });
app.on('render-process-gone', function (e, wc, d) { logLine('[render-gone]', JSON.stringify(d)); });

// 每 5 分钟记一次内存：机器本来就吃紧，判断是不是被挤掉的关键
setInterval(function () {
  try {
    const m = process.memoryUsage();
    const per = {};
    app.getAppMetrics().forEach(function (x) {
      per[x.type] = (per[x.type] || 0) + Math.round(x.memory.workingSetSize / 1024);
    });
    logLine('[mem]', 'main-rss=' + Math.round(m.rss / 1048576) + 'MB ' + JSON.stringify(per));
  } catch (e) {}
}, 300000).unref();

// 单实例：重复启动（比如连点两次 start.cmd）只保留一个窗口，
// 否则多个进程会同时写 config.json，位置和设置互相覆盖。
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logLine('[second]', '已有实例在运行，本次启动直接退出');
  app.quit();
} else {
  app.on('second-instance', function () {
    logLine('[second]', '检测到重复启动，激活已有窗口');
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // 闪一下任务栏：否则用户以为「点了没反应 / 闪退」
      try {
        win.flashFrame(true);
        setTimeout(function () {
          try { if (win && !win.isDestroyed()) win.flashFrame(false); } catch (e) {}
        }, 2000);
      } catch (e) {}
    }
  });

  app.whenReady().then(function () {
    logLine('[ready]', 'Electron ready');
    // 关机 / 休眠会让计划任务在错过 09:25 后被 Windows 补跑。
    // 如果补跑发生在收盘之后，开窗也没有行情可看，直接不打开。
    if (SCHEDULED_LAUNCH && nowMinutes() >= 15 * 60) {
      console.log('[autostart] 已过 15:00，跳过本次自动启动');
      app.quit();
      return;
    }

    app.setAppUserModelId('com.miniticker.watch');
    createWindow();
    registerFocusHotkey();
    startAlertTimer();
    startBackgroundProbe();
    startAutoExitTimer();
    startScheduledTradingCheck();
    cleanLoginItem();
    refreshTaskInstalledCache();
    initUpdater();
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', function () {
  logLine('[window-all-closed]', '所有窗口已关闭，准备退出');
  stopDrag();
  app.quit();
});

app.on('before-quit', function () {
  logLine('[before-quit]', '准备退出');
  saveConfig();
  fundStore.dispose();   // 兜住最后几秒还没落盘的估值点
});

app.on('will-quit', function () {
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

app.on('quit', function (e, code) {
  logLine('[quit-done]', 'exit code=' + code);
});
