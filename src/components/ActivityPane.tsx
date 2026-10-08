import { useLayoutEffect, useRef, useState } from 'react';
import { Copy, Trash2, Download, Activity, ChevronDown, MoreHorizontal, MessageSquareText } from 'lucide-react';
import type { Account, LogEntry } from '../types';
import { phone } from '../lib/phone';
import { accountLabel, clock, copyText, download, errorText, logLine } from '../lib/utils';
import { Empty, IconButton, SearchField, Segmented, type MenuState, menuAt } from './UI';

type View = 'all' | 'conversation' | 'sip';

type Props = { log: LogEntry[]; accounts: Account[]; openMenu: (menu: MenuState) => void; toast: (text: string) => void; transcribe: boolean; setTranscribe: (on: boolean) => void };
export default function ActivityPane({ log, accounts, openMenu, toast, transcribe, setTranscribe }: Props) {
  const [account, setAccount] = useState(''); const [query, setQuery] = useState(''); const [view, setView] = useState<View>('all');
  const list = useRef<HTMLDivElement>(null); const pinned = useRef(true);
  const label = (id?: string) => !id ? 'App' : id === 'demo' ? 'Simulator' : accounts.find(a => a.id === id) ? accountLabel(accounts.find(a => a.id === id)!) : 'Removed account';
  const rows = log.filter(e => (!account || e.accountId === account) && (view === 'all' || (view === 'conversation') === !!e.kind) && `${label(e.accountId)} ${e.speaker || ''} ${e.text}`.toLowerCase().includes(query.trim().toLowerCase()));
  // Live speech grows in place, so follow the newest text as well as new rows.
  useLayoutEffect(() => { if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [rows.length, log]);
  const text = () => rows.map(e => logLine(e, label(e.accountId))).join('\n');
  const filterItems = () => [{ label: 'All Accounts', checked: !account, onClick: () => setAccount('') }, ...(accounts.length ? ['separator' as const] : []), ...accounts.map(a => ({ label: accountLabel(a), checked: account === a.id, onClick: () => setAccount(a.id) }))];
  const empty = view !== 'conversation' || query || account ? <Empty icon={Activity} title={log.length ? 'No Matching Events' : 'No Activity'}>{log.length ? 'Try a different filter.' : 'Registration, call events, speech and DTMF from every account appear here as they happen.'}</Empty>
    : transcribe ? <Empty icon={MessageSquareText} title="No Conversation">What each side says, and every DTMF digit, appears here during calls. Speech is transcribed on this computer.</Empty>
    : <Empty icon={MessageSquareText} title="Transcription Is Off" action={<button type="button" className="button small" onClick={() => setTranscribe(true)}>Turn On</button>}>DTMF digits appear here. Turn on Transcribe Calls to add what each side says.</Empty>;
  return <div className="pane-content">
    <div className="pane-bar">
      <Segmented label="Show" className="small grow" value={view} onChange={setView} options={[{ value: 'all', label: 'All' }, { value: 'conversation', label: 'Conversation' }, { value: 'sip', label: 'SIP' }]} />
      <button type="button" className="popup-button" onClick={e => openMenu(menuAt(e, filterItems(), 200))}><span>{account ? label(account) : 'All Accounts'}</span><ChevronDown size={12} strokeWidth={2} /></button>
      <IconButton icon={MoreHorizontal} label="Activity actions" onClick={e => openMenu(menuAt(e, [
        { label: 'Transcribe Calls', checked: transcribe, onClick: () => setTranscribe(!transcribe) }, 'separator',
        { label: rows.length === log.length ? 'Copy All Events' : `Copy ${rows.length} Shown Events`, icon: Copy, disabled: !rows.length, onClick: () => { void copyText(text()).then(() => toast(`Copied ${rows.length} event${rows.length === 1 ? '' : 's'}`)).catch(e => toast(errorText(e))); } },
        { label: 'Save as Text File…', icon: Download, disabled: !rows.length, onClick: () => download(new Blob([text() + '\n'], { type: 'text/plain' }), `DialDev-activity-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`) },
        'separator', { label: 'Clear Activity', icon: Trash2, danger: true, disabled: !log.length, onClick: phone.clearLog }
      ], 210))} />
    </div>
    {log.length > 0 && <div className="pane-search"><SearchField value={query} onChange={setQuery} placeholder="Filter events and speech" /></div>}
    <div className="list log-list" ref={list} onScroll={e => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }}>
      {rows.length === 0 ? empty : rows.map(e => <div key={e.id} className={`log-row ${e.kind || e.level} ${e.side || ''} ${e.partial ? 'partial' : ''}`}>
        <span className="log-meta"><time dateTime={new Date(e.time).toISOString()}>{clock(e.time, true)}</time><span className="log-account" title={label(e.accountId)}>{label(e.accountId)}</span></span>
        {e.kind === 'speech' ? <span className="log-text"><span className="log-speaker">{e.speaker || 'Remote'}</span>{e.text}</span>
          : e.kind === 'dtmf' ? <span className="log-text"><span className="log-speaker">{e.speaker || 'Remote'}</span><kbd className="log-key" aria-label={`DTMF ${e.digit}`}>{e.digit}</kbd><span className="log-detail">{e.side === 'local' ? 'Sent' : e.detail === 'in-band tone' ? 'Heard' : 'Received'}{e.detail ? ` · ${e.detail}` : ''}</span></span>
          : <span className="log-text">{e.text}</span>}
      </div>)}
    </div>
    <div className="pane-status">{log.length} event{log.length === 1 ? '' : 's'}{rows.length !== log.length && ` · ${rows.length} shown`}<span>This session only</span></div>
  </div>;
}
