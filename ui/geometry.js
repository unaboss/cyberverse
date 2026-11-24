// Rectangle sums for the round screen's windows. No DOM here, so the tests can
// run them in Node. A rectangle is { left, top, right, bottom }.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/** How much of rectangle a lies over rectangle b. */
export function overlap(a, b) {
  return area({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
}

const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h });
const covers = (others, r) => others.reduce((sum, o) => sum + overlap(r, o), 0);

/**
 * Where to put a popup of size w x h next to an anchor rectangle, inside a W x H stage,
 * covering as little of the other windows as it can. Tries left, right, below, then above,
 * and takes the first side with room unless another side covers less.
 * @returns {{ x: number, y: number, side: 'left' | 'right' | 'below' | 'above' }}
 */
export function besideRect(anchor, w, h, W, H, others = [], gap = 10) {
  const fit = (x, y) => ({ x: clamp(x, 8, Math.max(8, W - w - 8)), y: clamp(y, 8, Math.max(8, H - h - 8)) });
  const options = [
    { side: 'left', x: anchor.left - w - gap, y: anchor.top, room: anchor.left - w - gap >= 8 },
    { side: 'right', x: anchor.right + gap, y: anchor.top, room: anchor.right + gap + w <= W - 8 },
    { side: 'below', x: anchor.left, y: anchor.bottom + gap, room: anchor.bottom + gap + h <= H - 8 },
    { side: 'above', x: anchor.left, y: anchor.top - h - gap, room: anchor.top - h - gap >= 8 },
  ];
  const placed = options.map((o, order) => {
    const at = fit(o.x, o.y);
    return { ...at, side: o.side, room: o.room, order, covered: covers(others, box(at.x, at.y, w, h)) };
  });
  placed.sort((a, b) => Number(b.room) - Number(a.room) || a.covered - b.covered || a.order - b.order);
  const { x, y, side } = placed[0];
  return { x, y, side };
}

/**
 * The biggest part of a W x H stage that the windows leave uncovered, for the office
 * floor to fit into. Each window that covers the free part cuts it on whichever side keeps
 * the most room. A window the floor cannot get away from without shrinking below
 * minW x minH stays floating over the floor.
 */
export function freeArea(W, H, rects, { gap = 12, minW = 320, minH = 220 } = {}) {
  let free = { left: 0, top: 0, right: W, bottom: H };
  const pending = [...rects];
  while (pending.length > 0) {
    pending.sort((a, b) => overlap(b, free) - overlap(a, free));
    const r = pending.shift();
    if (overlap(r, free) <= 0) break;
    const cuts = [
      { ...free, right: Math.min(free.right, r.left - gap) },
      { ...free, left: Math.max(free.left, r.right + gap) },
      { ...free, bottom: Math.min(free.bottom, r.top - gap) },
      { ...free, top: Math.max(free.top, r.bottom + gap) },
    ].filter((c) => c.right - c.left >= minW && c.bottom - c.top >= minH);
    if (cuts.length === 0) continue;
    cuts.sort((a, b) => area(b) - area(a));
    free = cuts[0];
  }
  return { ...free, width: free.right - free.left, height: free.bottom - free.top };
}

/**
 * A corner of the free area for a w x h box, inset a little, covering as little of the
 * other windows as it can. Top-left first: the office floor never reaches its corners.
 */
export function cornerSpot(free, w, h, others = [], inset = 12) {
  const left = free.left + inset;
  const right = Math.max(left, free.right - w - inset);
  const top = free.top + inset;
  const bottom = Math.max(top, free.bottom - h - inset);
  const spots = [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
  ].map((s, order) => ({ ...s, order, covered: covers(others, box(s.x, s.y, w, h)) }));
  spots.sort((a, b) => a.covered - b.covered || a.order - b.order);
  return { x: spots[0].x, y: spots[0].y };
}
