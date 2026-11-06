import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Macro } from '../types';
import { macroLabel, type MacroRun } from '../lib/macros';

type Props = { macros: Macro[]; run: MacroRun | null; disabled?: boolean; inCall: boolean; play: (macro: Macro, event: React.MouseEvent) => void; menu: (event: React.MouseEvent) => void };

/**
 * Macro buttons between the number field and the keypad. They sit centered, and scroll sideways when they don't all fit,
 * fading at whichever edge has more to show. The playing macro fills with the accent color as its keys go out.
 */
export default function MacroBar({ macros, run, disabled = false, inCall, play, menu }: Props) {
  const track = useRef<HTMLDivElement>(null); const [fade, setFade] = useState({ start: false, end: false });
  useLayoutEffect(() => {
    const el = track.current; if (!el) return;
    const measure = () => { const start = el.scrollLeft > 1; const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1; setFade(f => f.start === start && f.end === end ? f : { start, end }); };
    measure(); el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure); observer.observe(el); for (const child of el.children) observer.observe(child);
    return () => { el.removeEventListener('scroll', measure); observer.disconnect(); };
  }, [macros]);
  // Keep the playing macro in view, and let a mouse wheel scroll the row.
  const playing = run?.id;
  useEffect(() => { if (playing) track.current?.querySelector('.macro.running')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }, [playing]);
  const wheel = (event: React.WheelEvent) => { const el = track.current; if (el && Math.abs(event.deltaY) > Math.abs(event.deltaX)) el.scrollLeft += event.deltaY; };
  return <div className="macro-bar">
    <div ref={track} className={`macro-track ${fade.start ? 'fade-start' : ''} ${fade.end ? 'fade-end' : ''}`} role="group" aria-label="Macros" onWheel={wheel}>
      {macros.map((m, i) => {
        const active = run?.id === m.id; const label = macroLabel(m); const shortcut = i < 9 ? ` (⌥${i + 1})` : '';
        const title = active && inCall ? 'Click to stop' : `${m.name.trim() ? `${m.name.trim()} · ` : ''}${m.digits.trim()}${shortcut}\n${inCall ? 'Sends these digits as DTMF' : 'Types these digits'} · right-click to edit`;
        return <button type="button" key={m.id} className={`macro ${active ? 'running' : ''}`} disabled={disabled} title={title}
          aria-label={`${label}${m.name.trim() ? `, ${m.digits.trim()}` : ''}`}
          style={active ? { '--progress': run.done / run.total } as React.CSSProperties : undefined}
          onClick={event => play(m, event)} onContextMenu={event => { event.preventDefault(); menu(event); }}>
          <span className="macro-label">{label}</span>
        </button>;
      })}
    </div>
  </div>;
}
