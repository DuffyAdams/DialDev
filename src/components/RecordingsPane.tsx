import { useEffect, useState } from 'react';
import { AudioLines, Download, Trash2, Play } from 'lucide-react';
import type { Recording } from '../types';
import { recordings } from '../lib/storage';
import { download, duration, errorText } from '../lib/utils';
import { Empty, IconButton } from './UI';

function RecordingRow({ record, remove }: { record: Recording; remove: () => void }) {
  const [url, setUrl] = useState(''); const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; const object = URL.createObjectURL(record.blob); setUrl(object); return () => URL.revokeObjectURL(object); }, [record.blob, open]);
  return <div role="listitem" className={`recording ${open ? 'open' : ''}`}>
    <div className="list-row" tabIndex={0} onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === 'Enter') setOpen(!open); }}>
      <span className="direction"><Play size={13} strokeWidth={2} /></span>
      <span className="row-main"><span className="row-title">{record.name}{record.name !== record.number && <span className="row-number">{record.number}</span>}</span><span className="row-sub">{new Date(record.time).toLocaleString()}<i>·</i>{duration(record.duration)}</span></span>
      <IconButton icon={Download} label="Download" className="row-action" onClick={e => { e.stopPropagation(); download(record.blob, `DialDev-${new Date(record.time).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${record.blob.type.includes('wav') ? 'wav' : 'webm'}`); }} />
      <IconButton icon={Trash2} label="Delete" className="row-action" onClick={e => { e.stopPropagation(); remove(); }} />
    </div>
    {open && url && <audio controls autoPlay src={url} />}
  </div>;
}
/** Saved call recordings, shown as a view inside Recents. */
export default function RecordingsList({ refresh, toast, confirmDelete }: { refresh: number; toast: (text: string) => void; confirmDelete: (name: string, remove: () => Promise<void>) => void }) {
  const [items, setItems] = useState<Recording[]>([]);
  useEffect(() => { void recordings.list().then(r => setItems(r.sort((a, b) => b.time - a.time))).catch(e => toast(errorText(e))); }, [refresh, toast]);
  return <div className="list" role="list">
    {items.length === 0 ? <Empty icon={AudioLines} title="No Recordings">Use Record during a connected call. Recordings stay on this computer. Tell participants before you record.</Empty>
      : items.map(record => <RecordingRow key={record.id} record={record} remove={() => confirmDelete(record.name, async () => { await recordings.delete(record.id); setItems(list => list.filter(r => r.id !== record.id)); })} />)}
  </div>;
}
