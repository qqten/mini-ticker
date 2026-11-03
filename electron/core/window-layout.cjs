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

// 聚焦展开的横向位置：side=auto 时窗口更靠近屏幕哪边，就从另一侧长出来；
// side=left/right 时老老实实按指定的图表方向展开 —— 只要那一侧还塞得下 MIN_ROOM，
// 宁可把图表压窄也不偷偷换边（用户选了「图表在左」就该在左）。
function focusExpandX(x, width, area, totalWidth, side) {
  const grow = Math.max(0, totalWidth - width);
  const leftRoom = x - area.x;
  const rightRoom = area.x + area.width - (x + width);
  const MIN_ROOM = 160;

  let nx = x;
  if (side === 'left') {
    if (leftRoom >= MIN_ROOM) nx = x - grow;
  } else if (side === 'right') {
    if (rightRoom >= MIN_ROOM) nx = x;
    else if (leftRoom >= MIN_ROOM) nx = x - grow;
  } else {
    // auto：靠右就向左长，靠左就向右长
    const preferLeft = rightRoom < leftRoom;
    if (preferLeft ? leftRoom >= grow : (rightRoom < grow && leftRoom >= grow)) {
      nx = x - grow;
    }
  }

  const maxX = area.x + area.width - totalWidth;
  return Math.max(area.x, Math.min(nx, maxX));
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

module.exports = { DEFAULT_SNAP, clampRect, snapRect, rectInside, focusExpandX, collapseRect, pickRememberedPosition };
