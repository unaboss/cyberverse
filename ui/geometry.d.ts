// Types for geometry.js, so the Node tests can import it.

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export declare function clamp(v: number, lo: number, hi: number): number;
export declare function overlap(a: Rect, b: Rect): number;
export declare function besideRect(
  anchor: Rect,
  w: number,
  h: number,
  W: number,
  H: number,
  others?: Rect[],
  gap?: number,
): { x: number; y: number; side: 'left' | 'right' | 'below' | 'above' };
export declare function freeArea(
  W: number,
  H: number,
  rects: Rect[],
  options?: { gap?: number; minW?: number; minH?: number },
): Rect & { width: number; height: number };
export declare function cornerSpot(free: Rect, w: number, h: number, others?: Rect[], inset?: number): { x: number; y: number };
