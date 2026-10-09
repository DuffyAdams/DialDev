import { useEffect, useRef } from 'react';
import { Plus, MoreHorizontal, Pencil, Copy, Power, RefreshCw, Trash2, Link, Moon, PhoneIncoming, Check } from 'lucide-react';
import type { Account, Connection, Preferences } from '../types';
import { accountLabel } from '../lib/utils';
import { IconButton, StatusDot, Switch, type MenuItem, type MenuState, menuAt } from './UI';

export type AccountActions = { edit: (a: Account) => void; duplicate: (a: Account) => void; register: (a: Account) => void; unregister: (a: Account) => void; remove: (a: Account) => void; copyUri: (a: Account) => void };
export function accountStatus(a: Account, c?: Connection): { state: Connection['state'] | 'disabled'; text: string } {
  if (c?.state === 'registered') return { state: 'registered', text: `${a.username}@${a.domain}${c.detail ? ` · ${c.detail}` : ''}` };
  if (c?.state === 'connecting') return { state: 'connecting', text: c.detail || 'Registering…' };
  if (c?.state === 'error') return { state: 'error', text: c.detail || 'Registration failed' };
  if (!a.enabled) return { state: 'disabled', text: 'Off' };
  return { state: 'offline', text: c?.detail || 'Not registered' };
}
export function accountMenu(a: Account, c: Connection | undefined, actions: AccountActions): MenuItem[] {
  const live = c?.state === 'registered' || c?.state === 'connecting';
  return [
    live ? { label: 'Re-register', icon: RefreshCw, onClick: () => actions.register(a) } : { label: 'Register', icon: Power, onClick: () => actions.register(a) },
    ...(live || a.enabled ? [{ label: 'Unregister', icon: Power, onClick: () => actions.unregister(a) }] : []),
    'separator', { label: 'Edit…', icon: Pencil, onClick: () => actions.edit(a) }, { label: 'Duplicate', icon: Copy, onClick: () => actions.duplicate(a) }, { label: 'Copy SIP Address', icon: Link, onClick: () => actions.copyUri(a) },
    'separator', { label: 'Delete…', icon: Trash2, danger: true, onClick: () => actions.remove(a) }
  ];
}

type Props = {
  accounts: Account[]; connections: Record<string, Connection>; selected?: string; select: (id: string) => void; add: () => void; actions: AccountActions; openMenu: (menu: MenuState) => void; limit: number; voicemail: Record<string, number>;
  preferences: Preferences; setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void; onClose: () => void;
};
/** The account switcher that drops down from the title bar: every line with its registration state, plus phone-wide toggles. */
export default function AccountsPopover({ accounts, connections, selected, select, add, actions, openMenu, limit, voicemail, preferences, setPreference, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.account-row.selected .account-main, .account-main, button')?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  const registered = accounts.filter(a => connections[a.id]?.state === 'registered').length;
  return <div className="popover-layer" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="popover accounts-popover" ref={ref} role="dialog" aria-label="Accounts">
      <div className="popover-heading"><span>Accounts</span>{accounts.length > 0 && <span>{registered} of {accounts.length} registered</span>}</div>
      {accounts.length > 0 && <div className="account-list" role="listbox" aria-label="SIP accounts">
        {accounts.map(a => {
          const connection = connections[a.id]; const status = accountStatus(a, connection); const items = accountMenu(a, connection, actions); const current = selected === a.id;
          return <div key={a.id} className={`account-row ${current ? 'selected' : ''} ${status.state}`} onContextMenu={e => { e.preventDefault(); openMenu(menuAt(e, items)); }}>
            <button type="button" className="account-main" role="option" aria-selected={current} onClick={() => { select(a.id); onClose(); }} onDoubleClick={() => actions.edit(a)}
              title={`${a.username}@${a.domain}${a.transport === 'wss' ? '' : `:${a.port}`} · ${a.transport.toUpperCase()}${connection?.detail ? `\n${connection.detail}` : ''}\nDouble-click to edit`}>
              <StatusDot state={status.state} />
              <span className="account-text"><span className="account-name">{accountLabel(a)}</span><span className="account-sub">{status.text}</span></span>
              {(voicemail[a.id] || 0) > 0 && <span className="badge" title={`${voicemail[a.id]} voicemail`}>{voicemail[a.id]}</span>}
              <span className="transport">{a.transport}</span>
              <span className="account-check">{current && <Check size={14} strokeWidth={2.4} />}</span>
            </button>
            <IconButton icon={MoreHorizontal} label={`Actions for ${accountLabel(a)}`} className="account-more" onClick={e => openMenu(menuAt(e, items))} />
          </div>;
        })}
      </div>}
      {accounts.length === 0 && <p className="popover-empty">No accounts yet. Add one to register with your SIP server.</p>}
      <div className="popover-section">
        <div className="popover-toggle"><Moon size={14} strokeWidth={2} /><span>Do Not Disturb<small>Decline incoming calls with 486</small></span><Switch label="Do Not Disturb" checked={preferences.dnd} onChange={v => setPreference('dnd', v)} /></div>
        <div className="popover-toggle"><PhoneIncoming size={14} strokeWidth={2} /><span>Auto Answer<small>Answer audio calls when idle</small></span><Switch label="Auto Answer" checked={preferences.autoAnswer} onChange={v => setPreference('autoAnswer', v)} /></div>
      </div>
      <button type="button" className="popover-add" onClick={add} disabled={accounts.length >= limit} title={accounts.length >= limit ? `Up to ${limit} accounts` : 'Add a SIP account (⇧⌘N)'}><Plus size={15} strokeWidth={2} />Add Account…</button>
    </div>
  </div>;
}
