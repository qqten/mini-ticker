'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_SNAP, clampRect, snapRect, rectInside, focusExpandX, pickRememberedPosition } = require('../electron/core/window-layout.cjs');

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
  // 固定方向和空间冲突时退到另一边
  assert.equal(focusExpandX(40, 320, AREA, 940, 'left'), 40);
  assert.equal(focusExpandX(1500, 320, AREA, 940, 'right'), 880);
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
