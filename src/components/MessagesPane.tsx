import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Phone, Send, SquarePen, MessageSquare } from 'lucide-react';
import type { Account, ChatMessage, Contact } from '../types';
import { accountLabel, clock, samePeer } from '../lib/utils';
import { Avatar, Empty, IconButton, SearchField } from './UI';

type Props = { messages: ChatMessage[]; contacts: Contact[]; account?: Account; send: (peer: string, body: string) => void; dial: (number: string) => void };
export default function MessagesPane({ messages, contacts, account, send, dial }: Props) {
  const [peer, setPeer] = useState(''); const [composing, setComposing] = useState(false); const [to, setTo] = useState(''); const [body, setBody] = useState(''); const [query, setQuery] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const mine = messages.filter(m => m.accountId === account?.id);
  const name = (p: string) => contacts.find(c => samePeer(c.number, p))?.name || p;
  const peers = [...new Set(mine.map(m => m.peer).reverse())].filter(p => `${name(p)} ${p}`.toLowerCase().includes(query.trim().toLowerCase()));
  const thread = mine.filter(m => samePeer(m.peer, peer));
  useEffect(() => { setPeer(''); setComposing(false); }, [account?.id]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [thread.length, peer]);
  if (!account) return <div className="pane-content"><Empty icon={MessageSquare} title="No Account">Add a SIP account to send SIP MESSAGE requests.</Empty></div>;
  if (peer || composing) return <div className="pane-content">
    <div className="pane-bar thread-bar">
      <IconButton icon={ChevronLeft} label="All conversations" onClick={() => { setPeer(''); setComposing(false); }} />
      {composing ? <form className="to-field" onSubmit={e => { e.preventDefault(); if (to.trim()) { setPeer(to.trim()); setComposing(false); setTo(''); } }}><span>To:</span><input autoFocus value={to} placeholder="Number or SIP URI, then Return" spellCheck={false} list="message-peers" onChange={e => setTo(e.target.value)} /><datalist id="message-peers">{contacts.map(c => <option key={c.id} value={c.number}>{c.name}</option>)}</datalist></form>
        : <><span className="thread-title"><strong>{name(peer)}</strong>{name(peer) !== peer && <small>{peer}</small>}</span><IconButton icon={Phone} label={`Call ${name(peer)}`} onClick={() => dial(peer)} /></>}
    </div>
    <div className="list thread">
      {thread.length === 0 && !composing && <p className="thread-empty">Messages are sent as SIP MESSAGE from {accountLabel(account)}.</p>}
      {thread.map(m => <div key={m.id} className={`bubble ${m.incoming ? 'in' : 'out'} ${m.status}`}><p>{m.body}</p><span>{clock(m.time)}{!m.incoming && ` · ${m.status === 'sent' ? 'Accepted' : m.status === 'failed' ? 'Failed' : 'Sending…'}`}</span></div>)}
      <div ref={bottom} />
    </div>
    {!composing && <form className="composer" onSubmit={e => { e.preventDefault(); if (body.trim()) { send(peer, body.trim()); setBody(''); } }}><input aria-label="Message" value={body} maxLength={4000} placeholder="SIP MESSAGE" onChange={e => setBody(e.target.value)} /><IconButton icon={Send} label="Send" disabled={!body.trim()} onClick={() => { if (body.trim()) { send(peer, body.trim()); setBody(''); } }} /></form>}
  </div>;
  return <div className="pane-content">
    <div className="pane-bar"><SearchField value={query} onChange={setQuery} placeholder="Search conversations" /><IconButton icon={SquarePen} label="New message" onClick={() => setComposing(true)} /></div>
    <div className="list" role="list">
      {peers.length === 0 ? <Empty icon={MessageSquare} title={query ? 'No Matches' : 'No Messages'} action={!query && <button type="button" className="button" onClick={() => setComposing(true)}>New Message…</button>}>{query ? 'Try a different search.' : `SIP MESSAGE conversations on ${accountLabel(account)} appear here.`}</Empty>
        : peers.map(p => { const last = mine.filter(m => samePeer(m.peer, p)).at(-1); return <div key={p} role="listitem" className="list-row conversation-row" tabIndex={0} onClick={() => setPeer(p)} onKeyDown={e => { if (e.key === 'Enter') setPeer(p); }}>
          <Avatar name={name(p)} size={28} /><span className="row-main"><span className="row-title">{name(p)}</span><span className="row-sub">{last?.body}</span></span><span className="row-time">{last && clock(last.time)}</span>
        </div>; })}
    </div>
  </div>;
}
