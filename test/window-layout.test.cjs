'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_SNAP, clampRect, snapRect, rectInside, focusExpandX, focusExpandBox, collapseRect, pickRememberedPosition } = require('../electron/core/window-layout.cjs');

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
// 第二块屏在右侧，工作区从 1920 开始
const AREA2 = { x: 1920, y: 0, width: 1280, height: 1024 };

test('clampRect 把窗口夹进工作区', function () {
  assert.deepEqual(clampRect(-50, -20, 320, 200, AREA), { x: 0, y: 0 });
  assert.deepEqual(clampRect(1800, 900, 320, 200, AREA), { x: 1600, y: 840 });
  assert.deepEqual(clampRect(100, 120, 320, 200, AREA), { x: 100, y: 120 });
  assert.deepEqual(clampRect(1900, 40, 320, 200, AREA2), { x: 1920, y: 40 });
});

test('snapRect 吸附到最近的左/右/上/下边', function () {
  assert.deepEqual(snapRect(8, 300, 320, 200, AREA), { x: 0, y: 300 });
  assert.deepEqual(snapRect(1590, 300, 320, 200, AREA), { x: 1600, y: 300 });
  assert.deepEqual(snapRect(500, 6, 320, 200, AREA), { x: 500, y: 0 });
  assert.deepEqual(snapRect(500, 835, 320, 200, AREA), { x: 500, y: 840 });
});

test('snapRect 超出阈值时保持原位', function () {
  assert.deepEqual(snapRect(40, 80, 320, 200, AREA), { x: 40, y: 80 });
  assert.deepEqual(snapRect(1500, 700, 320, 200, AREA), { x: 1500, y: 700 });
});

test('snapRect 支持负坐标和多屏工作区', function () {
  const left = { x: -1280, y: -200, width: 1280, height: 1024 };
  assert.deepEqual(snapRect(-1272, 100, 320, 200, left), { x: -1280, y: 100 });
  assert.deepEqual(snapRect(3192, 700, 320, 200, AREA2), { x: 2880, y: 700 });
});

test('snapRect 先夹回工作区，避免屏幕外吸附', function () {
  assert.deepEqual(snapRect(-500, -500, 320, 200, AREA), { x: 0, y: 0 });
});

test('DEFAULT_SNAP 保持一个合理阈值', function () {
  assert.equal(DEFAULT_SNAP, 14);
});

test('focusExpandX 靠近右侧向左展开、靠近左侧向右展开', function () {
  // 左边：保持左边缘，向右加宽
  assert.equal(focusExpandX(40, 320, AREA, 940), 40);
  // 右边：保持右边缘（1500+320=1820），整体左移
  assert.equal(focusExpandX(1500, 320, AREA, 940), 880);
  // 紧贴右边缘：右边缘不动
  assert.equal(focusExpandX(1600, 320, AREA, 940), 980);
  // 左边但两侧空间都不够：保持原位，右侧留一点余量
  assert.equal(focusExpandX(600, 320, AREA, 1240), 600);
  // 两边都不够：夹回工作区，优先保证窗口完整
  assert.equal(focusExpandX(900, 320, AREA, 1900), 20);
});

test('focusExpandX 支持固定图表方向', function () {
  // 固定图表在左：靠右时向左展开
  assert.equal(focusExpandX(1500, 320, AREA, 940, 'left'), 880);
  // 固定图表在右：靠左时向右展开
  assert.equal(focusExpandX(40, 320, AREA, 940, 'right'), 40);
  // 固定方向和空间冲突时不换边：左边不够就往右推（图表仍在左），右边不够就往左推
  assert.equal(focusExpandX(40, 320, AREA, 940, 'left'), 0);
  assert.equal(focusExpandX(1500, 320, AREA, 940, 'right'), 980);
});

test('focusExpandX 支持负坐标和多屏工作区', function () {
  const left = { x: -1280, y: -200, width: 1280, height: 1024 };
  assert.equal(focusExpandX(-1260, 320, left, 940), -1260);
  // 靠近左屏右侧：保持右边缘（-640+320=-320），向左展开
  assert.equal(focusExpandX(-640, 320, left, 940), -1260);
});

test('rectInside 判断窗口是否完整落在工作区内', function () {
  assert.equal(rectInside(0, 0, 320, 200, AREA), true);
  assert.equal(rectInside(1600, 840, 320, 200, AREA), true);
  assert.equal(rectInside(-1, 0, 320, 200, AREA), false);
  assert.equal(rectInside(1601, 840, 320, 200, AREA), false);
  // 跨屏时窗口压到两块屏，任何一块都不算完整
  assert.equal(rectInside(1800, 100, 320, 200, AREA), false);
  assert.equal(rectInside(1800, 100, 320, 200, AREA2), false);
});

test('pickRememberedPosition 只在记忆屏幕仍连接时采用', function () {
  const displays = [
    { id: 100, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 200, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }
  ];
  const positions = { '200': { x: 2400, y: 120 } };

  const hit = pickRememberedPosition(positions, '200', displays);
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 2400, y: 120 });
  assert.equal(hit.display.id, 200);

  // 屏幕拔掉、id 对不上、坐标非法都返回 null，交给调用方回退
  assert.equal(pickRememberedPosition(positions, '999', displays), null);
  assert.equal(pickRememberedPosition({ '200': { x: 'bad', y: 1 } }, '200', displays), null);
  assert.equal(pickRememberedPosition(positions, '', displays), null);
  assert.equal(pickRememberedPosition(null, '200', displays), null);
});

test('固定图表在左：左边地方够就坚决左扩，不偷偷换边', function () {
  // 左边只剩 200px（够 160 的保底），图表会被压窄，但仍然在左边
  assert.equal(focusExpandX(200, 320, AREA, 520, 'left'), 0);
  // 左边完全没地方（贴左边缘）也留在左边
  assert.equal(focusExpandX(0, 320, AREA, 940, 'left'), 0);
  // 右边只剩 200px：固定右时保持原位（图表压窄），不换到左边
  assert.equal(focusExpandX(1400, 320, AREA, 520, 'right'), 1400);
});

test('focusExpandBox 固定方位时靠挪窗口保证图表宽度', function () {
  const want = 620;
  // 列表贴右边缘（x=1500），选「图表在右」：右侧只有 100px，
  // 但整屏放得下 → 窗口整体左移，列表让位，图表仍是完整 620
  const right = focusExpandBox({ x: 1500, y: 100, width: 320, height: 400 }, AREA, 'right', want);
  assert.equal(right.chartW, want);
  assert.equal(right.width, 320 + want);
  assert.equal(right.x, 1920 - right.width);
  assert.equal(right.chartLeft, false);
  assert.equal(right.x + right.width, 1920, '图表那一栏贴住屏幕右边缘');
  assert.ok(right.x < 1500, '列表被整体左移腾出位置');

  // 列表贴左边缘（x=0），选「图表在左」：左边 0px → 窗口整体右移，列表跟着挪
  const left = focusExpandBox({ x: 0, y: 100, width: 320, height: 400 }, AREA, 'left', want);
  assert.equal(left.chartW, want);
  assert.equal(left.x, 0);
  assert.equal(left.chartLeft, true);
  // 图表占 [0,620]，列表在 [620,940] —— 列表确实被挪到了新位置
  assert.equal(left.x + left.width - left.listW, 620);

  // auto 仍按当下空位放，不主动挪窗口：靠右时向左长，原来的右边缘（1820）不动
  const autoRight = focusExpandBox({ x: 1500, y: 100, width: 320, height: 400 }, AREA, 'auto', want);
  assert.equal(autoRight.x, 1500 - want);
  assert.equal(autoRight.x + autoRight.width, 1820);
  assert.equal(autoRight.chartLeft, true);
  const autoLeft = focusExpandBox({ x: 40, y: 100, width: 320, height: 400 }, AREA, 'auto', want);
  assert.equal(autoLeft.x, 40);
  assert.equal(autoLeft.chartLeft, false);
});

test('focusExpandBox 整屏塞不下才压窄图表', function () {
  // 列表 640 + 想要 1100 = 1740，1920-8 够；换成窄屏 1024 就压窄
  const narrow = { x: 0, y: 0, width: 1024, height: 768 };
  const box = focusExpandBox({ x: 700, y: 100, width: 640, height: 400 }, narrow, 'right', 1100);
  assert.equal(box.width, narrow.width - 8);
  assert.equal(box.chartW, narrow.width - 8 - 640);
  assert.equal(box.x + box.width, narrow.width, '夹回工作区右边缘');
  assert.equal(box.chartLeft, false);

  // 极端窄屏：保底 160 的图表宽度
  const tiny = { x: 0, y: 0, width: 700, height: 600 };
  const t = focusExpandBox({ x: 0, y: 0, width: 600, height: 400 }, tiny, 'left', 620);
  assert.equal(t.chartW, 160);
});

test('collapseRect 只收图表那一栏，列表原地不动', function () {
  // 图表在右：窗口左边缘就是列表左边缘
  const rightExpanded = { x: 700, y: 300, width: 940, height: 400 };
  assert.deepEqual(
    collapseRect(rightExpanded, false, 320, AREA),
    { x: 700, y: 300, width: 320, height: 400 }
  );

  // 图表在左：列表贴窗口右边缘，收起后列表左边缘 = 窗口右边缘 - 列表宽
  const leftExpanded = { x: 80, y: 300, width: 940, height: 400 };
  assert.deepEqual(
    collapseRect(leftExpanded, true, 320, AREA),
    { x: 700, y: 300, width: 320, height: 400 }
  );
});

test('collapseRect 在聚焦期间挪过窗口也不跳回老位置', function () {
  // 展开后用户把窗口整体往右下拖了 (220, 90)
  const moved = { x: 300, y: 390, width: 940, height: 400 };
  const right = collapseRect(moved, false, 320, AREA);
  assert.equal(right.x, 300, '图表在右时左边缘跟着走');
  assert.equal(right.y, 390);

  const left = collapseRect(moved, true, 320, AREA);
  assert.equal(left.x, 300 + 940 - 320, '图表在左时右边缘跟着走');
  assert.equal(left.y, 390);
});

test('collapseRect 宽度夹取并夹回工作区', function () {
  const b = { x: 10, y: 10, width: 940, height: 400 };
  assert.equal(collapseRect(b, false, 100, AREA).width, 220);
  assert.equal(collapseRect(b, false, 2000, AREA).width, 640);

  // 贴右边缘收缩时不能跑到屏幕外
  const edge = { x: 1900, y: 0, width: 940, height: 300 };
  const c = collapseRect(edge, false, 320, AREA);
  assert.ok(c.x + c.width <= AREA.x + AREA.width);
});
