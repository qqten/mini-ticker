'use strict';

// 窗口位置计算：纯函数，方便单测。坐标都是 Electron 的 DIP 屏幕坐标。
const DEFAULT_SNAP = 14;

function clampRect(x, y, width, height, area) {
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return {
    x: Math.max(area.x, Math.min(Math.round(x), area.x + area.width - w)),
    y: Math.max(area.y, Math.min(Math.round(y), area.y + area.height - h))
  };
}

// 靠近工作区四边时吸附；先夹回可视区，避免窗口在屏幕外时吸到看不见的边。
function snapRect(x, y, width, height, area, snapPx) {
  const base = clampRect(x, y, width, height, area);
  const snap = snapPx == null ? DEFAULT_SNAP : snapPx;
  let nx = base.x;
  let ny = base.y;

  if (Math.abs(nx - area.x) <= snap) {
    nx = area.x;
  } else if (Math.abs((nx + width) - (area.x + area.width)) <= snap) {
    nx = area.x + area.width - width;
  }

  if (Math.abs(ny - area.y) <= snap) {
    ny = area.y;
  } else if (Math.abs((ny + height) - (area.y + area.height)) <= snap) {
    ny = area.y + area.height - height;
  }

  return { x: nx, y: ny };
}

// 聚焦展开的横向位置：side=auto 时窗口更靠近屏幕哪边，就从另一侧长出来。
// side=left/right 时只认这一侧 —— 那一侧地方不够就让窗口整体平移（列表跟着挪），
// 绝不偷偷换到另一边；最后的夹取也只挪位置，不换边。
function focusExpandX(x, width, area, totalWidth, side) {
  const grow = Math.max(0, totalWidth - width);
  const leftRoom = x - area.x;
  const rightRoom = area.x + area.width - (x + width);

  let nx = x;
  if (side === 'left') {
    // 图表长在左边：保持列表右边缘不动（窗口左移）；左边不够就让夹取把窗口右推
    nx = x - grow;
  } else if (side === 'right') {
    // 图表长在右边：保持列表左边缘不动（窗口不动）；右边不够就让夹取把窗口左推
    nx = x;
  } else {
    // auto：靠右就向左长，靠左就向右长
    const preferLeft = rightRoom < leftRoom;
    if (preferLeft ? leftRoom >= grow : (rightRoom < grow && leftRoom >= grow)) {
      nx = x - grow;
    }
  }

  const maxX = area.x + area.width - totalWidth;
  return Math.max(area.x, Math.min(Math.round(nx), maxX));
}

const FOCUS_MIN_CHART = 160;
const FOCUS_EDGE_GAP = 8;

// 聚焦展开的完整横向几何。返回窗口左边缘、总宽、图表宽、图表在不在左边。
// 固定方向（left/right）优先保证图表宽度：那一侧空间不够时窗口整体平移、
// 列表跟着让位，只要整块屏还塞得下就绝不压窄图表；auto 仍按当下空位来放。
function focusExpandBox(cur, area, side, wantChartW) {
  const listW = Math.round(cur.width);
  const want = Math.max(FOCUS_MIN_CHART, Math.round(wantChartW));
  // 整块屏能留给图表的宽度：这是固定方向时的上限
  const screenAvail = Math.max(FOCUS_MIN_CHART, area.width - FOCUS_EDGE_GAP - listW);
  const roomL = cur.x - area.x;
  const roomR = area.x + area.width - (cur.x + cur.width);
  const avail = (side === 'left' || side === 'right')
    ? screenAvail
    : Math.min(Math.max(roomL, roomR), screenAvail);

  const chartW = Math.max(FOCUS_MIN_CHART, Math.min(want, avail));
  const width = listW + chartW;
  const x = focusExpandX(cur.x, cur.width, area, width, side);
  // 图表在哪侧只由设置决定：固定方向时 x 变小只是窗口挪了位置，不代表图表换边
  const chartLeft = side === 'left' ? true : (side === 'right' ? false : x < cur.x);

  return { x: x, width: width, listW: listW, chartW: chartW, chartLeft: chartLeft };
}

// 收起聚焦：只把图表那一栏收掉，列表留在原地。
// 不回「展开前的位置」—— 用户在聚焦期间挪过窗口的话，那样会"啪"地跳回去。
// chartLeft=true 表示图表在左、列表贴在窗口右边缘。
function collapseRect(bounds, chartLeft, listW, area) {
  const width = Math.min(Math.max(220, Math.min(640, Math.round(listW))), area.width);
  const height = Math.min(bounds.height, area.height);
  const listX = chartLeft
    ? (bounds.x + bounds.width - Math.min(width, bounds.width))
    : bounds.x;
  return {
    x: Math.max(area.x, Math.min(listX, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width: width,
    height: height
  };
}

// 整窗是否完全落在工作区内。跨屏拖动时窗口会同时压到两块屏，
// 这时不能吸边也不能夹回，否则切屏瞬间会跳位置。
function rectInside(x, y, width, height, area) {
  return x >= area.x && y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height;
}

// 启动时挑选记忆位置：只有 lastDisplayId 对应的屏幕还连着才采用它的坐标，
// 否则返回 null，让调用方回退到 config.pos 或最近的屏幕。
function pickRememberedPosition(positions, lastDisplayId, displays) {
  if (!lastDisplayId || !positions) return null;
  const p = positions[lastDisplayId];
  if (!p || !isFinite(p.x) || !isFinite(p.y)) return null;
  const list = displays || [];
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d && String(d.id) === String(lastDisplayId)) {
      return { x: p.x, y: p.y, display: d };
    }
  }
  return null;
}

module.exports = { DEFAULT_SNAP, clampRect, snapRect, rectInside, focusExpandX, focusExpandBox, collapseRect, pickRememberedPosition };
