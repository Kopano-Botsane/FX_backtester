import type { Drawing } from '../types';
import { fmtPrice } from '../util';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Projection {
  plot: Rect;
  timeToX(t: number): number;
  priceToY(p: number): number;
  xToTime(x: number): number;
  yToPrice(y: number): number;
  digits: number;
}

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const int = parseInt(full || '4c8dff', 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function corners(d: Drawing, proj: Projection) {
  return {
    x1: proj.timeToX(d.a.t),
    y1: proj.priceToY(d.a.p),
    x2: proj.timeToX(d.b.t),
    y2: proj.priceToY(d.b.p),
  };
}

export function drawDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  proj: Projection,
  selected: boolean,
  hovered: boolean,
): void {
  const { x1, y1, x2, y2 } = corners(d, proj);
  const active = selected || hovered;
  const alpha = selected ? 1 : hovered ? 0.9 : 0.76;
  const lineWidth = selected ? 2 : 1.4;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = hexToRgba(d.color, alpha);
  ctx.fillStyle = hexToRgba(d.color, 0.1);
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);

  switch (d.kind) {
    case 'trend': {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      break;
    }
    case 'hline': {
      const y = proj.priceToY(d.a.p);
      ctx.beginPath();
      ctx.moveTo(proj.plot.x, y);
      ctx.lineTo(proj.plot.x + proj.plot.w, y);
      ctx.stroke();

      const label = fmtPrice(d.a.p, proj.digits);
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = d.color;
      const tagY = y - 8;
      ctx.fillRect(proj.plot.x + 2, tagY - 1, w, 14);
      ctx.fillStyle = '#0a0d12';
      ctx.fillText(label, proj.plot.x + 6, tagY + 9);
      break;
    }
    case 'rect': {
      const rx = Math.min(x1, x2);
      const ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1);
      const rh = Math.abs(y2 - y1);
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case 'fib': {
      const span = y2 - y1;
      const width = Math.abs(x2 - x1);
      const left = Math.min(x1, x2);
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      for (const level of FIB_LEVELS) {
        const y = y1 + span * level;
        const major = level === 0.618 || level === 0.5;
        ctx.strokeStyle = hexToRgba(d.color, level === 0 ? 0.9 : major ? 0.7 : 0.38);
        ctx.lineWidth = major ? 1.4 : 1;
        ctx.setLineDash(level === 0 || level === 1 ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();

        const price = d.a.p + (d.b.p - d.a.p) * level;
        const text = `${level.toFixed(3)}  ${fmtPrice(price, proj.digits)}`;
        ctx.fillStyle = hexToRgba(d.color, 0.85);
        ctx.fillText(text, left + 4, y - 3);
      }
      ctx.setLineDash([]);
      break;
    }
  }

  // Endpoint handles on the focused drawing.
  if (active) {
    ctx.fillStyle = '#0f141b';
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 1.5;
    const handles = d.kind === 'hline' ? [[x1, y1]] : [[x1, y1], [x2, y2]];
    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.arc(hx, hy, selected ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  if (len === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitTestDrawing(d: Drawing, proj: Projection, x: number, y: number, tol = 6): boolean {
  const { x1, y1, x2, y2 } = corners(d, proj);
  switch (d.kind) {
    case 'trend':
      return segDist(x, y, x1, y1, x2, y2) <= tol;
    case 'hline':
      return Math.abs(y - y1) <= tol;
    case 'rect':
    case 'fib': {
      if (d.kind === 'rect') {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);
        if (x >= left - tol && x <= right + tol && y >= top - tol && y <= bottom + tol) {
          return true; // rects are selectable anywhere inside
        }
        return false;
      }
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      if (x < left - tol || x > right + tol) return false;
      return FIB_LEVELS.some((level) => Math.abs(y - (y1 + (y2 - y1) * level)) <= tol);
    }
  }
  return false;
}

export function hitTestHandle(
  d: Drawing,
  proj: Projection,
  x: number,
  y: number,
  tol = 9,
): 'a' | 'b' | null {
  if (d.kind === 'hline') return null;
  const { x1, y1, x2, y2 } = corners(d, proj);
  if (Math.hypot(x - x1, y - y1) <= tol) return 'a';
  if (Math.hypot(x - x2, y - y2) <= tol) return 'b';
  return null;
}
