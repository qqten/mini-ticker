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

// 指数 → 东财 secid：只用来取「分时级别 K 线」。
// 腾讯的分钟 K 只给当天一天的数据（m5 常常只有 1~2 根），要往回翻几天必须走东财。
// 这里按 code 前缀兜底：sh/sz/bj 股票用 市场号.代码，港股/美股指数单独列。
const INDEX_EM_SECID = {
  sh000001: '1.000001',
  sz399001: '0.399001',
  sz399006: '0.399006',
  sh000688: '1.000688',
  sh000300: '1.000300',
  sh000016: '1.000016',
  sh000905: '1.000905',
  sh000852: '1.000852',
  bj899050: '0.899050',
  hkHSI: '100.HSI',
  // 恒生科技在东财是 124 市场，不是港股的 100
  hkHSTECH: '124.HSTECH',
  hkHSCEI: '100.HSCEI',
  usDJI: '100.DJIA',
  // 纳斯达克综合指数在东财是 100.NDX（IXIC 那个代码查不到任何 K 线）
  usIXIC: '100.NDX',
  usINX: '100.SPX',
  usNDX: '100.NDX100'
};

const DEFAULT_WATCHLIST = [
  'sh000001', 'sz399001', 'sz399006', 'sh000688', 'sh000300', 'sh000016',
  'sh000905', 'sh000852', 'bj899050', 'hkHSI', 'hkHSTECH', 'usDJI', 'usIXIC', 'usINX'
];

const PERIODS = ['minute', 'day', 'month', 'year'];
const PERIOD_LABEL = { minute: '分时', day: '日线', month: '月线', year: '年线' };

// 聚焦图表「分时」旁边那个下拉能选的分钟级别，全部可选值在这里。
// 设置里勾选哪几个，图表头部就显示哪几个；没勾选的在界面上不出现。
const FOCUS_INTERVALS = [1, 5, 15, 30, 60];
const FOCUS_INTERVAL_LABEL = { 1: '1分', 5: '5分', 15: '15分', 30: '30分', 60: '60分' };
// 默认显示哪些级别：5/15/30/60 分钟最常用，1 分钟数据量太大（东财一次只给 320 根，约一天半），默认不显示
const DEFAULT_FOCUS_INTERVALS = [5, 15, 30, 60];

// 浮窗左上角的指数条：默认显示上证指数，点开可切换这四只，
// 选中后同时展开对应指数走势图。顺序就是下拉里的顺序。
const TOP_INDEX_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000688'];
// 顶部和下拉统一用正式名称，不再缩写
const TOP_INDEX_TITLE = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000688: '科创50'
};

// 文字配色：light = 亮色文字（配深背景），dark = 暗色文字（配浅背景），auto = 跟随窗口背后的实际画面
const TEXT_MODES = ['light', 'dark', 'auto'];

// 聚焦图表相对列表的位置：auto = 靠近哪边就从另一侧展开，left / right = 固定图表在左 / 右
const FOCUS_CHART_SIDES = ['auto', 'left', 'right'];

const DEFAULT_CONFIG = {
  symbols: ['sh000001', 'sz399001', 'sz399006', 'sh000688'],
  // 自选分组：默认只有一个「默认」组，旧配置升级时 symbols 会原样迁进来。
  // symbols 始终是当前分组（activeGroupId）的镜像，方便沿用旧代码。
  groups: [{
    id: 'default',
    name: '默认',
    symbols: ['sh000001', 'sz399001', 'sz399006', 'sh000688']
  }],
  activeGroupId: 'default',
  watchlist: DEFAULT_WATCHLIST,
  period: 'minute',
  // 聚焦图表「分时」旁边下拉里能选的分钟级别（顺序即下拉顺序）。
  // 设置里勾选哪几个，图表头部就显示哪几个；空列表时退回默认的 5/15/30/60。
  focusIntervals: DEFAULT_FOCUS_INTERVALS,
  // 上一次在下拉里选中的级别（打开新图表时沿用它）
  focusInterval: 5,
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
  // 左上角分组名右侧的指数条：显示点位 / 涨跌幅，点开可切换指数并展开走势图
  showTopIndex: true,
  topIndex: 'sh000001',
  // 上次更新成功的源（gitee / ghfast / github），下次优先用它
  updateFeed: '',
  alwaysOnTop: true,
  locked: false,
  width: 320,
  // 高度：0 表示跟随内容自动撑开，>0 表示用户手动拖过、以这个值为准
  height: 0,
  pos: null,
  // 聚焦图表位置：auto 靠屏幕哪边就从另一侧展开；left/right 固定图表在列表左/右
  focusChartSide: 'auto',
  // 多屏记忆：displayId -> { x, y }，以及最后一次所在屏幕
  displayPositions: {},
  lastDisplayId: '',
  // 快捷键：周期/刷新是窗口内快捷键，focus 是全局唤起聚焦图表
  shortcuts: {
    periodMinute: 'Ctrl+1',
    periodDay: 'Ctrl+2',
    periodMonth: 'Ctrl+3',
    periodYear: 'Ctrl+4',
    refresh: 'Ctrl+R',
    focus: 'Ctrl+Alt+F',
    showHide: 'Ctrl+Alt+H',
    clickThrough: 'Ctrl+Alt+T'
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
  INDEX_EM_SECID,
  DEFAULT_WATCHLIST,
  PERIODS,
  PERIOD_LABEL,
  FOCUS_INTERVALS,
  FOCUS_INTERVAL_LABEL,
  DEFAULT_FOCUS_INTERVALS,
  TOP_INDEX_CODES,
  TOP_INDEX_TITLE,
  TEXT_MODES,
  FOCUS_CHART_SIDES,
  DEFAULT_CONFIG,
  TYPE_LABEL
};
