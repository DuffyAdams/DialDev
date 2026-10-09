import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Phone, Search, CircleX, type LucideIcon } from 'lucide-react';
import type { Connection } from '../types';
import { initials } from '../lib/utils';

export function IconButton({ icon: Icon, label, onClick, className = '', disabled = false, size = 16, pressed }: { icon: LucideIcon; label: string; onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void; className?: string; disabled?: boolean; size?: number; pressed?: boolean }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} aria-pressed={pressed} onClick={onClick} disabled={disabled}><Icon size={size} strokeWidth={1.75} /></button>;
}
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const text = /^[+\d*#]/.test(name) ? '' : initials(name);
  return <span className="avatar" style={{ width: size, height: size, fontSize: size * .38 }} aria-hidden="true">{text || <Phone size={size * .42} strokeWidth={1.75} />}</span>;
}
/** A level bar that runs from green into orange and red near the top. `level` is 0–1, or -1 when there is nothing to measure. */
export function Meter({ level, label }: { level: number; label: string }) {
  const value = Math.max(0, Math.min(1, level));
  return <span className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
    <span className="meter-fill" style={{ clipPath: `inset(0 ${(1 - value) * 100}% 0 0 round 3px)` }} />
  </span>;
}
export function StatusDot({ state }: { state?: Connection['state'] | 'disabled' }) { return <span className={`status-dot ${state || 'offline'}`} aria-hidden="true" />; }

/** A macOS-style sheet: attached to the top of the window, dismissed with Escape or its own buttons. */
export function Sheet({ title, children, onClose, width = 440, className = '' }: { title?: string; children: ReactNode; onClose: () => void; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const root = ref.current;
    (root?.querySelector<HTMLElement>('[autofocus], input:not([type=checkbox]):not(:disabled), select, textarea') || root?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab' && root) {
        const items = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(e => e.offsetParent !== null);
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, []);
  return <div className="sheet-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`sheet ${className}`} style={{ width }} ref={ref} role="dialog" aria-modal="true" aria-label={title}>{title && <h2 className="sheet-title">{title}</h2>}{children}</div></div>;
}

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <label className="switch" title={label}><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span aria-hidden="true" /></label>;
}
/** A settings row: label (and optional description) on the left, a switch on the right. */
export function ToggleRow({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return <div className="form-row toggle-row"><span className="row-label">{label}{description && <small>{description}</small>}</span><Switch checked={checked} onChange={onChange} label={label} disabled={disabled} /></div>;
}
export function Segmented<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (value: T) => void; label: string; className?: string }) {
  return <div className={`segmented ${className}`} role="radiogroup" aria-label={label}>{options.map(o => <button type="button" key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'selected' : ''} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}
export function SearchField({ value, onChange, placeholder = 'Search', label }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string }) {
  return <label className="search-field"><Search size={13} strokeWidth={2} /><input type="search" value={value} placeholder={placeholder} aria-label={label || placeholder} spellCheck={false} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && value) { e.preventDefault(); e.stopPropagation(); onChange(''); } }} />{value && <button type="button" aria-label="Clear search" onClick={() => onChange('')}><CircleX size={13} fill="currentColor" stroke="var(--bg)" /></button>}</label>;
}
export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><Icon size={28} strokeWidth={1.4} /><strong>{title}</strong>{children && <p>{children}</p>}{action}</div>;
}

export type MenuItem = { label: string; icon?: LucideIcon; onClick: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; detail?: ReactNode } | 'separator';
export type MenuState = { x: number; y: number; items: MenuItem[]; minWidth?: number };
/** Opens a menu below the clicked element, or at the pointer for a right-click. */
export const menuAt = (event: React.MouseEvent, items: MenuItem[], minWidth?: number): MenuState => {
  if (event.type === 'contextmenu') return { x: event.clientX, y: event.clientY, items, minWidth };
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect(); return { x: box.left, y: box.bottom + 4, items, minWidth: minWidth ?? box.width };
};
export function Menu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => { const box = ref.current?.getBoundingClientRect(); if (!box) return; setPosition({ left: Math.max(6, Math.min(menu.x, innerWidth - box.width - 6)), top: menu.y + box.height > innerHeight - 6 ? Math.max(6, menu.y - box.height) : menu.y }); ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); }, [menu]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return; event.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || [])]; const index = items.indexOf(document.activeElement as HTMLElement);
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };
    const away = () => onClose();
    document.addEventListener('keydown', key, true); window.addEventListener('blur', away); window.addEventListener('resize', away);
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('blur', away); window.removeEventListener('resize', away); };
  }, [onClose]);
  return <div className="menu-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} onContextMenu={e => { e.preventDefault(); onClose(); }}>
    <div className="menu" role="menu" ref={ref} style={{ ...position, minWidth: Math.max(180, menu.minWidth || 0) }}>
      {menu.items.map((item, i) => item === 'separator' ? <div key={i} className="menu-separator" role="separator" /> : <button key={i} type="button" role="menuitem" className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={() => { onClose(); item.onClick(); }}>
        <span className="menu-check">{item.checked ? '✓' : ''}</span>{item.icon && <item.icon size={14} strokeWidth={1.75} />}<span className="menu-label">{item.label}</span>{item.detail && <span className="menu-detail">{item.detail}</span>}
      </button>)}
    </div>
  </div>;
}
