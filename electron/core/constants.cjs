'use strict';

// 常用指数 / 品种名称表（watchlist 里出现的代码会优先用这里的名字）
const NAMES = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000688: '科创50',
  sh000300: '沪深300',
  sh000016: '上证50',
  sh000905: '中证500',
  sh000852: '中证1000',
  bj899050: '北证50',
  hkHSI: '恒生指数',
  hkHSTECH: '恒生科技',
  hkHSCEI: '国企指数',
  usDJI: '道琼斯',
  usIXIC: '纳斯达克',
  usINX: '标普500',
  usNDX: '纳指100',
  hf_GC: '纽约金',
  hf_XAU: '伦敦金',
  hf_SI: '纽约白银',
  hf_XAG: '伦敦银',
  hf_XPT: '纽约铂金',
  hf_CL: 'WTI原油',
  hf_OIL: '布伦特原油',
  hf_HG: 'COMEX铜',
  hf_NG: '美国天然气',
  usDXY: '美元指数'
};

// 东财特殊品种（非 hf_ 前缀）：美元指数等
const EM_SECID = {
  usDXY: '100.UDI'
};

// 外盘期货（hf_）→ 东方财富 secid 映射（腾讯不提供外盘分时/K线）
const HF_EM_SECID = {
  hf_XAU: '122.XAU',
  hf_XAG: '122.XAG',
  hf_GC: '101.GC00Y',
  hf_SI: '101.SI00Y',
  hf_CL: '102.CL00Y',
  hf_OIL: '112.B00Y',
  hf_HG: '101.HG00Y',
  hf_NG: '102.NG00Y',
  hf_XPT: '102.PL00Y'
};

const DEFAULT_WATCHLIST = [
  'sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300', 'sh000016',
  'sh000905', 'sh000852', 'bj899050', 'hkHSI', 'hkHSTECH', 'usDJI', 'usIXIC', 'usINX'
];

const PERIODS = ['minute', 'day', 'month', 'year'];
const PERIOD_LABEL = { minute: '分时', day: '日线', month: '月线', year: '年线' };

// 文字配色：light = 亮色文字（配深背景），dark = 暗色文字（配浅背景），auto = 跟随窗口背后的实际画面
const TEXT_MODES = ['light', 'dark', 'auto'];

const DEFAULT_CONFIG = {
  symbols: ['sh000001', 'sz399001', 'sz399006', 'sh000688'],
  watchlist: DEFAULT_WATCHLIST,
  period: 'minute',
  interval: 3000,
  probeIntervalMs: 4000,
  alert: { enabled: true, time: '14:30' },
  // 收盘后自动退出：默认 15:05（留几分钟让收盘数据落定）
  autoExit: { enabled: true, time: '15:05' },
  // 开盘自动启动：靠 Windows 计划任务，工作日定点拉起
  autoStart: { enabled: false, time: '09:25' },
  textMode: 'auto',
  // 上一次自动判定出来的配色：冷启动时先按它画，避免「先亮色字、1 秒后才纠正」
  lastEffectiveTextMode: 'light',
  backdrop: false,
  backdropOpacity: 40,
  sparkWidth: 120,
  showName: true,
  baseline: true,
  // 列表排序：off 按自选顺序 / pct-desc 涨幅从高到低 / pct-asc 从低到高
  sortMode: 'off',
  // 上次更新成功的源（gitee / ghfast / github），下次优先用它
  updateFeed: '',
  alwaysOnTop: true,
  locked: false,
  width: 320,
  // 高度：0 表示跟随内容自动撑开，>0 表示用户手动拖过、以这个值为准
  height: 0,
  pos: null,
  // 快捷键：周期/刷新是窗口内快捷键，focus 是全局唤起聚焦图表
  shortcuts: {
    periodMinute: 'Ctrl+1',
    periodDay: 'Ctrl+2',
    periodMonth: 'Ctrl+3',
    periodYear: 'Ctrl+4',
    refresh: 'Ctrl+R',
    focus: 'Ctrl+Alt+F'
  }
};

const TYPE_LABEL = {
  'GP-A': 'A股',
  'GP-A-KCB': '科创板',
  'GP-A-CYB': '创业板',
  'GP-B': 'B股',
  ZS: '指数',
  ETF: 'ETF',
  LOF: 'LOF',
  FJ: '分级',
  QZ: '权证',
  KJ: '场外基金',
  'GP-HK': '港股',
  'GP-US': '美股'
};

module.exports = {
  NAMES,
  EM_SECID,
  HF_EM_SECID,
  DEFAULT_WATCHLIST,
  PERIODS,
  PERIOD_LABEL,
  TEXT_MODES,
  DEFAULT_CONFIG,
  TYPE_LABEL
};
