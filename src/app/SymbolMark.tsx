import type { ItemSymbol } from '../../shared/types.ts';

/** An item's symbol, drawn from its points (as read from the legend), with the letters that tell it apart. */
export function SymbolMark({ s, size = 26 }: { s: ItemSymbol; size?: number }) {
  const pad = 0.8, w = s.w + 2 * pad, h = s.h + 2 * pad;
  const r = Math.max(0.28, Math.max(w, h) / 40);
  return (
    <span className="symbol-mark" title={s.letters?.length ? `Symbol, with ${s.letters.join(' ')} beside it` : 'Symbol'}>
      <svg viewBox={`${-pad} ${-pad} ${w} ${h}`} width={size} height={Math.max(12, (size * h) / Math.max(w, h))} aria-hidden="true">
        {s.pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={r} />)}
      </svg>
      {s.letters?.length ? <span className="symbol-letters">{s.letters.join(' ')}</span> : null}
    </span>
  );
}
