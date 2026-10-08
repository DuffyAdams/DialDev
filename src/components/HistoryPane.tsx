import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, PhoneMissed, Phone, MoreHorizontal, Download, Trash2, History } from 'lucide-react';
import type { Contact, HistoryItem } from '../types';
import { clock, dayLabel, download, duration, samePeer } from '../lib/utils';
import { Empty, IconButton, SearchField, Segmented, type MenuState, menuAt } from './UI';
import RecordingsList from './RecordingsPane';

const unanswered = (h: HistoryItem) => h.direction === 'missed' || (h.direction === 'outgoing' && !h.duration);
const outcome = (h: HistoryItem) => h.direction === 'missed' ? `Missed${h.reason ? ` · ${h.reason}` : ''}` : !h.duration && h.direction === 'outgoing' ? h.reason || 'Not answered' : `${duration(h.duration)}${h.reason && /^[3-6]\d\d/.test(h.reason) ? ` · ${h.reason}` : ''}`;
const csvCell = (value: string | number) => /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);

type Props = { history: HistoryItem[]; contacts: Contact[]; fill: (number: string) => void; dial: (number: string, video?: boolean) => void; clear: () => void; openMenu: (menu: MenuState) => void; recordingRefresh: number; toast: (text: string) => void; confirmDelete: (name: string, remove: () => Promise<void>) => void };
export default function HistoryPane({ history, contacts, fill, dial, clear, openMenu, recordingRefresh, toast, confirmDelete }: Props) {
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState<'all' | 'missed' | 'failed' | 'recordings'>('all');
  const rows = history.filter(h => (filter === 'all' || (filter === 'missed' ? h.direction === 'missed' : h.direction === 'outgoing' && !h.duration)) && `${h.name} ${h.number} ${h.account} ${h.reason || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const exportCsv = () => download(new Blob([['Time,Direction,Name,Number,Account,Duration (s),Result', ...history.map(h => [new Date(h.time).toISOString(), h.direction, h.name, h.number, h.account, h.duration, h.reason || (unanswered(h) ? 'Not answered' : 'Completed')].map(csvCell).join(','))].join('\r\n')], { type: 'text/csv' }), `DialDev-history-${new Date().toISOString().slice(0, 10)}.csv`);
  const exportJson = () => download(new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' }), `DialDev-history-${new Date().toISOString().slice(0, 10)}.json`);
  return <div className="pane-content">
    <div className="pane-bar">
      <Segmented label="Show" className="small grow" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'missed', label: 'Missed' }, { value: 'failed', label: 'Failed' }, { value: 'recordings', label: 'Recordings' }]} />
      <IconButton icon={MoreHorizontal} label="History actions" onClick={e => openMenu(menuAt(e, [{ label: 'Export as CSV…', icon: Download, onClick: exportCsv, disabled: !history.length }, { label: 'Export as JSON…', icon: Download, onClick: exportJson, disabled: !history.length }, 'separator', { label: 'Clear History…', icon: Trash2, danger: true, onClick: clear, disabled: !history.length }], 190))} />
    </div>
    {filter !== 'recordings' && history.length > 0 && <div className="pane-search"><SearchField value={query} onChange={setQuery} placeholder="Search number, account or result" /></div>}
    {filter === 'recordings' ? <RecordingsList refresh={recordingRefresh} toast={toast} confirmDelete={confirmDelete} /> : <div className="list" role="list">
      {rows.length === 0 ? <Empty icon={History} title={query || filter !== 'all' ? 'No Matches' : 'No Calls'}>{query || filter !== 'all' ? 'Try a different search or filter.' : 'Calls you place and receive appear here, with the account, duration and SIP result.'}</Empty>
        : rows.map((h, i) => {
          const contact = contacts.find(c => samePeer(c.number, h.number)); const name = contact?.name || h.name; const day = dayLabel(h.time);
          const Icon = h.direction === 'missed' ? PhoneMissed : h.direction === 'incoming' ? ArrowDownLeft : ArrowUpRight;
          return <div key={h.id} role="listitem">
            {(i === 0 || dayLabel(rows[i - 1].time) !== day) && <div className="list-section">{day}</div>}
            <div className={`list-row history-row ${unanswered(h) ? 'unanswered' : ''} ${h.direction}`} tabIndex={0} title={`${h.number}\nDouble-click to call`} onClick={() => fill(h.number)} onDoubleClick={() => dial(h.number, h.video)} onKeyDown={e => { if (e.key === 'Enter') dial(h.number, h.video); }}>
              <span className="direction"><Icon size={14} strokeWidth={2} /></span>
              <span className="row-main"><span className="row-title">{name}{name !== h.number && <span className="row-number">{h.number}</span>}</span><span className="row-sub">{h.account}<i>·</i><span className="outcome">{outcome(h)}</span></span></span>
              <span className="row-time">{clock(h.time)}</span>
              <IconButton icon={Phone} label={`Call ${name}`} className="row-action" onClick={e => { e.stopPropagation(); dial(h.number, h.video); }} />
            </div>
          </div>;
        })}
    </div>}
  </div>;
}
