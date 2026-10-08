import { useState } from 'react';
import type { Call, Contact } from '../types';
import { phone } from '../lib/phone';
import { errorText, uid } from '../lib/utils';
import { Segmented, Sheet } from './UI';

export function ConfirmSheet({ title, message, confirm, destructive = false, onConfirm, onClose }: { title: string; message: string; confirm: string; destructive?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <Sheet title={title} width={380} className="alert" onClose={onClose}>
    <p className="alert-message">{message}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="sheet-actions"><button type="button" className="button" autoFocus onClick={onClose}>Cancel</button><button type="button" className={`button ${destructive ? 'destructive' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onConfirm(); onClose(); } catch (e) { setError(errorText(e)); setBusy(false); } }}>{confirm}</button></div>
  </Sheet>;
}

export function TransferSheet({ call, calls, onClose }: { call: Call; calls: Call[]; onClose: () => void }) {
  const others = calls.filter(c => c.id !== call.id && c.answered && c.accountId === call.accountId);
  const [mode, setMode] = useState<'blind' | 'consult' | 'attended'>(others.length ? 'attended' : 'blind');
  const [target, setTarget] = useState(''); const [other, setOther] = useState(others[0]?.id || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (mode === 'attended') await phone.transfer(call.id, '', other);
      else if (!target.trim()) throw new Error('Enter a number or SIP address to transfer to.');
      else if (mode === 'consult') await phone.dial(target.trim(), target.trim(), call.accountId, call.demo);
      else await phone.transfer(call.id, target.trim());
      onClose();
    } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const help = { blind: 'Sends a SIP REFER. The call leaves this phone once the server accepts it.', consult: 'Holds this call and dials the target. When they answer, choose Transfer again and pick Attended.', attended: 'Connects the two parties with REFER/Replaces, then both calls end here.' }[mode];
  return <Sheet title={`Transfer ${call.name}`} width={420} onClose={onClose}>
    <form onSubmit={submit}>
      <Segmented label="Transfer type" className="wide" value={mode} onChange={setMode} options={[{ value: 'blind', label: 'Blind' }, { value: 'consult', label: 'Consult First' }, { value: 'attended', label: 'Attended', disabled: !others.length }]} />
      <div className="form-group">
        {mode === 'attended'
          ? <label className="form-row"><span className="row-label">Connect with</span><select value={other} onChange={e => setOther(e.target.value)}>{others.map(c => <option key={c.id} value={c.id}>{c.name}{c.name !== c.number ? ` (${c.number})` : ''}</option>)}</select></label>
          : <label className="form-row"><span className="row-label">Transfer to</span><input autoFocus value={target} placeholder="Number or SIP URI" spellCheck={false} autoComplete="off" onChange={e => setTarget(e.target.value)} /></label>}
      </div>
      <p className="form-note">{help}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Transferring…' : mode === 'consult' ? 'Call Target' : 'Transfer'}</button></div>
    </form>
  </Sheet>;
}

export function ContactSheet({ contact, number = '', onSave, onDelete, onClose }: { contact?: Contact; number?: string; onSave: (contact: Contact) => void; onDelete?: () => void; onClose: () => void }) {
  const [value, setValue] = useState<Contact>(contact || { id: uid(), name: '', number, email: '', company: '', group: '', favorite: false, color: '' });
  const [error, setError] = useState('');
  return <Sheet title={contact ? 'Edit Contact' : 'New Contact'} width={420} onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); if (!value.name.trim() || !value.number.trim()) { setError('Enter a name and a number or SIP address.'); return; } onSave({ ...value, name: value.name.trim(), number: value.number.trim() }); onClose(); }}>
      <div className="form-group">
        <label className="form-row"><span className="row-label">Name</span><input autoFocus value={value.name} placeholder="IVR main menu" onChange={e => setValue({ ...value, name: e.target.value })} /></label>
        <label className="form-row"><span className="row-label">Number</span><input value={value.number} placeholder="8000 or sip:ivr@pbx.example.com" spellCheck={false} onChange={e => setValue({ ...value, number: e.target.value })} /></label>
        <label className="form-row"><span className="row-label">Company</span><input value={value.company} placeholder="Optional" onChange={e => setValue({ ...value, company: e.target.value })} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sheet-actions">{onDelete && <button type="button" className="button destructive-text" onClick={() => { onDelete(); onClose(); }}>Delete</button>}<span className="spacer" /><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button primary">Save</button></div>
    </form>
  </Sheet>;
}
