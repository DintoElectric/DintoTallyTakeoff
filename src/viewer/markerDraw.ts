import type { MarkerShape } from '../../shared/types.ts';

export interface Palette {
  base: string;       // default border
  baseFill: string;
  active: string;     // active-type border
  activeFill: string;
  glyph: string;
  glyphActive: string;
  flag: string;       // dashed low-confidence outline
  select: string;
  glow: string;
}

export function appPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    base: v('--color-neutral-400', '#b2b6ca'),
    baseFill: v('--color-neutral-900', '#292b31'),
    active: v('--color-accent', '#9184d9'),
    activeFill: v('--color-accent-900', '#2b2741'),
    glyph: v('--color-neutral-300', '#cfd3e5'),
    glyphActive: v('--color-accent-200', '#e7e5fe'),
    flag: v('--color-accent-300', '#d2cefd'),
    select: v('--color-text', '#e9e9ed'),
    glow: 'rgba(145,132,217,0.45)',
  };
}

/** For marked-up sheet snapshots printed on paper: dark ink and accent on white. */
export const paperPalette: Palette = {
  base: '#3f424d', baseFill: 'rgba(255,255,255,0.85)', active: '#5d5294', activeFill: 'rgba(210,206,253,0.75)',
  glyph: '#292b31', glyphActive: '#2b2741', flag: '#5d5294', select: '#292b31', glow: 'rgba(0,0,0,0)',
};

function shapePath(ctx: CanvasRenderingContext2D, shape: MarkerShape, x: number, y: number, s: number) {
  ctx.beginPath();
  switch (shape) {
    case 'circle': ctx.arc(x, y, s / 2, 0, Math.PI * 2); break;
    case 'square': ctx.rect(x - s / 2, y - s / 2, s, s); break;
    case 'rect': ctx.rect(x - s * 0.65, y - s * 0.4, s * 1.3, s * 0.8); break;
    case 'diamond':
      ctx.moveTo(x, y - s * 0.62); ctx.lineTo(x + s * 0.62, y); ctx.lineTo(x, y + s * 0.62); ctx.lineTo(x - s * 0.62, y); ctx.closePath();
      break;
  }
}

/** Draws one marker at screen position (x, y). Size is constant on screen at any zoom (spec 2.10). */
export function drawMarker(
  ctx: CanvasRenderingContext2D, p: Palette, shape: MarkerShape, glyph: string | null,
  x: number, y: number, opts: { size?: number; active?: boolean; selected?: boolean; flagged?: boolean },
) {
  const s = opts.size ?? 16;
  ctx.save();
  if (opts.active) { ctx.shadowColor = p.glow; ctx.shadowBlur = 10; }
  shapePath(ctx, shape, x, y, s);
  ctx.fillStyle = opts.active ? p.activeFill : p.baseFill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = opts.active ? p.active : p.base;
  ctx.stroke();
  if (glyph) {
    ctx.fillStyle = opts.active ? p.glyphActive : p.glyph;
    ctx.font = `600 ${Math.round(s * 0.5)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, x, y + 0.5);
  }
  if (opts.flagged) {
    ctx.setLineDash([3, 2]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = p.flag;
    shapePath(ctx, shape, x, y, s + 6);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (opts.selected) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = p.select;
    shapePath(ctx, shape, x, y, s + 8);
    ctx.stroke();
  }
  ctx.restore();
}
