import { useState } from 'react';
import { Plus, Phone, Pencil, MoreHorizontal, Upload, Download, Users } from 'lucide-react';
import type { Contact } from '../types';
import { download, vCard } from '../lib/utils';
import { Avatar, Empty, IconButton, SearchField, type MenuState, menuAt } from './UI';

type Props = { contacts: Contact[]; fill: (number: string) => void; dial: (number: string) => void; edit: (contact?: Contact) => void; importFile: () => void; openMenu: (menu: MenuState) => void };
export default function ContactsPane({ contacts, fill, dial, edit, importFile, openMenu }: Props) {
  const [query, setQuery] = useState('');
  const rows = contacts.filter(c => `${c.name} ${c.number} ${c.company}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  return <div className="pane-content">
    <div className="pane-bar">
      <SearchField value={query} onChange={setQuery} placeholder="Search contacts" />
      <IconButton icon={Plus} label="New contact" onClick={() => edit()} />
      <IconButton icon={MoreHorizontal} label="Contact actions" onClick={e => openMenu(menuAt(e, [{ label: 'Import vCard…', icon: Upload, onClick: importFile }, { label: 'Export vCard…', icon: Download, disabled: !contacts.length, onClick: () => download(new Blob([vCard(contacts)], { type: 'text/vcard' }), 'DialDev-contacts.vcf') }], 180))} />
    </div>
    <div className="list" role="list">
      {rows.length === 0 ? <Empty icon={Users} title={query ? 'No Matches' : 'No Contacts'} action={!query && <button type="button" className="button" onClick={() => edit()}>New Contact…</button>}>{query ? 'Try a different name or number.' : 'Save numbers you test often, such as IVRs, queues and echo tests.'}</Empty>
        : rows.map(c => <div key={c.id} role="listitem" className="list-row contact-row" tabIndex={0} title="Double-click to call" onClick={() => fill(c.number)} onDoubleClick={() => dial(c.number)} onKeyDown={e => { if (e.key === 'Enter') dial(c.number); }}>
          <Avatar name={c.name} size={28} />
          <span className="row-main"><span className="row-title">{c.name}</span><span className="row-sub">{c.number}{c.company && <><i>·</i>{c.company}</>}</span></span>
          <IconButton icon={Pencil} label={`Edit ${c.name}`} className="row-action" onClick={e => { e.stopPropagation(); edit(c); }} />
          <IconButton icon={Phone} label={`Call ${c.name}`} className="row-action" onClick={e => { e.stopPropagation(); dial(c.number); }} />
        </div>)}
    </div>
  </div>;
}
