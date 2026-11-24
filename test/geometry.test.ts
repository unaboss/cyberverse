// The sums behind the round screen's windows: where the floor fits around them,
// where the "Done" note goes, and which corner the room box takes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { besideRect, cornerSpot, freeArea, overlap } from '../ui/geometry.js';

const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

test('the floor fits beside a column of windows on the right', () => {
  const guide = rect(944, 12, 410, 430);
  const soc = rect(944, 454, 410, 251);
  const free = freeArea(1366, 717, [guide, soc]);
  assert.deepEqual([free.left, free.top, free.right, free.bottom], [0, 0, 932, 717]);
});

test('an open machine along the bottom pushes the floor up', () => {
  const column = rect(944, 12, 410, 693);
  const machine = rect(12, 441, 920, 264);
  const free = freeArea(1366, 717, [column, machine]);
  assert.equal(free.right, 932);
  assert.equal(free.bottom, 429);
  assert.equal(overlap(free, machine), 0);
});

test('a window parked in the middle stays over the floor rather than squash it', () => {
  const free = freeArea(800, 600, [rect(250, 150, 300, 300)], { minW: 320, minH: 220 });
  // Cutting either side would leave a strip narrower than 320: the floor keeps the stage.
  assert.deepEqual([free.left, free.top, free.width, free.height], [0, 0, 800, 600]);
});

test('the note goes on the left of the window you used, when there is room', () => {
  const soc = rect(944, 454, 410, 251);
  const spot = besideRect(soc, 320, 90, 1366, 717);
  assert.equal(spot.side, 'left');
  assert.equal(spot.x, 944 - 320 - 10);
  assert.equal(spot.y, 454);
});

test('a window against the left edge gets its note above it', () => {
  const machine = rect(12, 441, 920, 264);
  const column = rect(944, 12, 410, 693);
  const spot = besideRect(machine, 320, 90, 1366, 717, [column]);
  assert.equal(spot.side, 'above');
  assert.equal(spot.x, 12);
  assert.ok(spot.y + 90 <= 441, 'the note ends above the machine');
});

test('the note keeps off other windows when it can', () => {
  const guide = rect(500, 100, 300, 300);
  const inTheWay = rect(150, 80, 340, 400);
  const spot = besideRect(guide, 300, 120, 1200, 700, [inTheWay]);
  assert.equal(spot.side, 'right');
});

test('the room box takes the free corner with no window over it', () => {
  const free = { left: 0, top: 0, right: 932, bottom: 717 };
  assert.deepEqual(cornerSpot(free, 280, 140, []), { x: 12, y: 12 });
  const bar = rect(12, 12, 300, 36);
  assert.deepEqual(cornerSpot(free, 280, 140, [bar]), { x: 932 - 280 - 12, y: 12 });
});
