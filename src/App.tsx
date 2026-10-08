import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Minus, Square, X, TriangleAlert, Settings, ChevronDown, Moon, PhoneIncoming, Clock3, Users, Grid3x3, MessageSquare, Activity, ChevronRight, type LucideIcon } from 'lucide-react';
import type { Account, Call, ChatMessage, Contact, Credentials, HistoryItem, Pane, Preferences, UpdateState } from './types';
import { deleteSecret, getSecret, loadData, saveData, saveSecret } from './lib/storage';
import { accountLabel, copyText, errorText, parseVCard, samePeer, uid } from './lib/utils';
import { phone } from './lib/phone';
import { ring } from './lib/tones';
import { IconButton, Menu, StatusDot, type MenuState } from './components/UI';
import AccountsPopover, { accountStatus, type AccountActions } from './components/Accounts';
import PhonePanel, { callState } from './components/PhonePanel';
import AccountSheet, { blankAccount } from './components/AccountSheet';
import SettingsSheet from './components/SettingsSheet';
import { ConfirmSheet, ContactSheet, TransferSheet } from './components/Sheets';
import HistoryPane from './components/HistoryPane';
import ActivityPane from './components/ActivityPane';
import ContactsPane from './components/ContactsPane';
import MessagesPane from './components/MessagesPane';

const MAX_ACCOUNTS = 20;
const tabs: { value: Pane; label: string; icon: LucideIcon }[] = [{ value: 'history', label: 'Recents', icon: Clock3 }, { value: 'contacts', label: 'Contacts', icon: Users }, { value: 'keypad', label: 'Keypad', icon: Grid3x3 }, { value: 'messages', label: 'Messages', icon: MessageSquare }, { value: 'activity', label: 'Activity', icon: Activity }];
type SheetState =
  | { kind: 'account'; account: Account; mode: 'new' | 'edit' | 'duplicate'; secretFrom?: string }
  | { kind: 'settings' } | { kind: 'transfer'; call: Call } | { kind: 'contact'; contact?: Contact }
  | { kind: 'confirm'; title: string; message: string; confirm: string; destructive?: boolean; action: () => Promise<void> | void };
const focusDial = () => setTimeout(() => document.getElementById('dial-number')?.focus());
const sipAddress = (a: Account) => `sip:${a.username}@${a.domain}${a.transport === 'wss' ? '' : `:${a.port};transport=${a.transport}`}`;

/** Shown under the title bar on other tabs while a call is up, like the iPhone's return-to-call bar. */
function CallBanner({ calls, open }: { calls: Call[]; open: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const call = calls.find(c => c.state === 'ringing') || calls.find(c => c.state === 'active') || calls[0];
  return <button type="button" className={`call-banner ${call.state}`} onClick={open}>
    <span className="banner-dot" /><span className="banner-name">{call.name}</span><span className="banner-state">{call.state === 'ringing' ? 'Incoming call' : callState(call, now)}{calls.length > 1 && ` · ${calls.length} calls`}</span><ChevronRight size={14} strokeWidth={2.2} />
  </button>;
}

export default function App() {
  const [data, setData] = useState(loadData); const dataRef = useRef(data); dataRef.current = data;
  const snapshot = useSyncExternalStore(phone.subscribe, phone.getSnapshot);
  const [number, setNumber] = useState(''); const [focused, setFocused] = useState('');
  const [sheet, setSheet] = useState<SheetState | null>(null); const sheetRef = useRef(sheet); sheetRef.current = sheet;
  const [accountsOpen, setAccountsOpen] = useState(false); const [update, setUpdate] = useState<UpdateState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null); const [notice, setNotice] = useState(''); const [ended, setEnded] = useState<HistoryItem | null>(null); const [recordingRefresh, setRecordingRefresh] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null); const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined); const endedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((text: string) => { setNotice(text); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 3200); }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const setPreference = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => setData(d => ({ ...d, preferences: { ...d.preferences, [key]: value } })), []);
  const setPane = useCallback((pane: Pane) => setData(d => ({ ...d, pane })), []);
  const openSheet = useCallback((value: SheetState) => { setAccountsOpen(false); setMenu(null); setSheet(value); }, []);
  const account = data.accounts.find(a => a.id === data.selectedAccount) ?? data.accounts[0];
  const setEnabled = (id: string, enabled: boolean) => setData(d => ({ ...d, accounts: d.accounts.map(a => a.id === id ? { ...a, enabled } : a) }));
  const missed = data.history.filter(h => h.direction === 'missed' && h.time > data.recentsSeen).length;

  const newAccount = useCallback(() => { if (dataRef.current.accounts.length >= MAX_ACCOUNTS) { toast(`DialDev supports up to ${MAX_ACCOUNTS} accounts.`); return; } openSheet({ kind: 'account', account: blankAccount(), mode: 'new' }); }, [toast, openSheet]);
  const actions: AccountActions = {
    edit: a => openSheet({ kind: 'account', account: a, mode: 'edit', secretFrom: a.id }),
    duplicate: a => { if (data.accounts.length >= MAX_ACCOUNTS) { toast(`DialDev supports up to ${MAX_ACCOUNTS} accounts.`); return; } openSheet({ kind: 'account', account: { ...a, id: uid(), name: a.name ? `${a.name} copy` : '' }, mode: 'duplicate', secretFrom: a.id }); },
    register: a => { void (async () => { const secret = await getSecret(a.id); if (!secret) { actions.edit(a); toast('Enter the password to register this account.'); return; } setEnabled(a.id, true); await phone.connect({ ...a, enabled: true }, secret); })().catch(e => phone.fail(e)); },
    unregister: a => { void phone.disconnect(a.id).then(() => setEnabled(a.id, false)).catch(e => phone.fail(e)); },
    remove: a => openSheet({ kind: 'confirm', title: `Delete “${accountLabel(a)}”?`, message: 'The account is unregistered and its saved password is removed from this computer.', confirm: 'Delete', destructive: true, action: async () => {
      await phone.disconnect(a.id); await deleteSecret(a.id);
      setData(d => ({ ...d, accounts: d.accounts.filter(x => x.id !== a.id), selectedAccount: d.selectedAccount === a.id ? d.accounts.find(x => x.id !== a.id)?.id || '' : d.selectedAccount }));
    } }),
    copyUri: a => { void copyText(sipAddress(a)).then(() => toast('SIP address copied')).catch(e => toast(errorText(e))); }
  };
  const saveAccount = async (a: Account, secret: Credentials, remember: boolean) => {
    if (phone.getSnapshot().calls.some(c => c.accountId === a.id)) throw new Error('End this account’s calls before changing it.');
    await saveSecret(a.id, secret, remember);
    setData(d => ({ ...d, accounts: d.accounts.some(x => x.id === a.id) ? d.accounts.map(x => x.id === a.id ? a : x) : [...d.accounts, a], selectedAccount: a.id }));
    if (a.enabled) await phone.connect(a, secret); else await phone.disconnect(a.id);
  };

  useEffect(() => { try { saveData(data); } catch { toast('Storage is full. Recent changes could not be saved.'); } phone.preferences = data.preferences; }, [data, toast]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = data.preferences.theme === 'system' ? media.matches ? 'dark' : 'light' : data.preferences.theme; };
    apply(); window.desktop?.setTheme(data.preferences.theme); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [data.preferences.theme]);
  // Viewing Recents clears the missed-call badge.
  useEffect(() => { if (data.pane === 'history' && missed) setData(d => ({ ...d, recentsSeen: Date.now() })); }, [data.pane, missed]);
  useEffect(() => {
    phone.onHistory = (item, demo) => { if (!demo) setData(d => ({ ...d, history: [item, ...d.history].slice(0, 2000) })); setEnded(item); clearTimeout(endedTimer.current); endedTimer.current = setTimeout(() => setEnded(null), 8000); };
    phone.onMessage = message => { setData(d => ({ ...d, messages: [...d.messages, message].slice(-5000) })); window.desktop?.notify(`Message from ${message.peer}`, message.body); };
    phone.onRecording = () => { setRecordingRefresh(v => v + 1); toast('Recording saved'); };
    phone.onIncoming = call => { setFocused(call.id); setPane('keypad'); window.desktop?.notify('Incoming call', call.name === call.number ? call.number : `${call.name} · ${call.number}`); };
    for (const a of dataRef.current.accounts.filter(a => a.enabled)) void getSecret(a.id).then(secret => secret ? phone.connect(a, secret) : phone.setOffline(a.id, 'Password needed')).catch(e => phone.fail(e));
    if (!dataRef.current.accounts.length) openSheet({ kind: 'account', account: blankAccount(), mode: 'new' });
    const unDial = window.desktop?.onDial(uri => { setNumber(decodeURIComponent(uri.replace(/^tel:/i, ''))); setPane('keypad'); focusDial(); });
    const unNavigate = window.desktop?.onNavigate(page => {
      if (sheetRef.current) return;
      if (page === 'settings') openSheet({ kind: 'settings' }); else if (page === 'new-account') newAccount(); else if (page === 'accounts') setAccountsOpen(true);
      else if (page === 'dial') { setPane('keypad'); focusDial(); } else if (tabs.some(t => t.value === page)) setPane(page as Pane);
    });
    return () => { unDial?.(); unNavigate?.(); };
  }, [newAccount, openSheet, setPane, toast]);
  // The desktop menu owns the ⌘ shortcuts; the browser preview handles them here. Typing digits on another tab jumps to the keypad.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = e => {
    if (sheetRef.current || accountsOpen || menu || e.defaultPrevented) return;
    const target = e.target as HTMLElement; const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (!(e.metaKey || e.ctrlKey || e.altKey) && !typing && data.pane !== 'keypad' && /^[0-9*#+]$/.test(e.key) && account) {
      e.preventDefault(); setPane('keypad');
      const live = snapshot.calls.find(c => c.id === focused && c.answered) || snapshot.calls.find(c => c.state === 'active');
      if (live && e.key !== '+') void phone.dtmf(live.id, e.key).catch(error => phone.fail(error)); else if (!snapshot.calls.length) { setNumber(n => n + e.key); focusDial(); }
      return;
    }
    if (window.desktop || !(e.metaKey || e.ctrlKey)) return;
    if (e.key === ',') { e.preventDefault(); openSheet({ kind: 'settings' }); }
    else if (e.key.toLowerCase() === 'l') { e.preventDefault(); setAccountsOpen(true); }
    else if (e.key.toLowerCase() === 'n') { e.preventDefault(); if (e.shiftKey) newAccount(); else { setPane('keypad'); focusDial(); } }
    else if (/^[1-5]$/.test(e.key)) { e.preventDefault(); setPane(tabs[+e.key - 1].value); }
  };
  useEffect(() => { const listener = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, []);
  useEffect(() => { const desktop = window.desktop; if (!desktop?.onUpdate) return; void desktop.updateState().then(setUpdate).catch(() => {}); return desktop.onUpdate(setUpdate); }, []);
  // Looks for a new release shortly after launch, then every six hours.
  useEffect(() => {
    const desktop = window.desktop; if (!data.preferences.checkUpdates || !desktop?.updateCheck) return;
    const check = () => { void desktop.updateCheck().catch(() => {}); }; const first = setTimeout(check, 5000); const timer = setInterval(check, 6 * 3600_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [data.preferences.checkUpdates]);
  const ringing = snapshot.calls.some(c => c.state === 'ringing');
  useEffect(() => { if (ringing && data.preferences.sounds) return ring(); }, [ringing, data.preferences.sounds]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (phone.getSnapshot().calls.length) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, []);
  useEffect(() => { if (!snapshot.error) return; const timer = setTimeout(phone.clearError, 9000); return () => clearTimeout(timer); }, [snapshot.error]);

  const dial = async (target = number, video = false) => {
    const value = target.trim();
    if (!value) { const last = data.history.find(h => h.direction === 'outgoing'); if (last) setNumber(last.number); setPane('keypad'); focusDial(); return; }
    if (!account) { newAccount(); return; }
    const match = data.contacts.find(c => samePeer(c.number, value) || c.name.toLowerCase() === value.toLowerCase());
    try { const id = await phone.dial(match?.number || value, match?.name || value, account.id, false, video); setFocused(id); setNumber(''); setEnded(null); setPane('keypad'); }
    catch (e) { phone.fail(e); }
  };
  const fill = (value: string) => { setNumber(value); setPane('keypad'); focusDial(); };
  const sendMessage = async (peer: string, body: string) => {
    if (!account) return;
    const message: ChatMessage = { id: uid(), peer, body, incoming: false, time: Date.now(), status: 'sending', accountId: account.id };
    const status = (value: ChatMessage['status']) => setData(d => ({ ...d, messages: d.messages.map(m => m.id === message.id ? { ...m, status: value } : m) }));
    setData(d => ({ ...d, messages: [...d.messages, message] }));
    try { await phone.sendMessage(account.id, peer, body); status('sent'); } catch (e) { status('failed'); phone.fail(e); }
  };
  const saveContact = (contact: Contact) => setData(d => ({ ...d, contacts: d.contacts.some(c => c.id === contact.id) ? d.contacts.map(c => c.id === contact.id ? contact : c) : [...d.contacts, contact] }));
  const importContacts = async (file: File) => {
    try {
      if (file.size > 5_000_000) throw new Error('Choose a vCard file smaller than 5 MB.');
      const imported = parseVCard(await file.text()); if (!imported.length) throw new Error('No contacts with a name and number were found.');
      const additions = imported.filter(c => !data.contacts.some(old => samePeer(old.number, c.number))).map(c => ({ ...c, id: uid(), group: '', favorite: false, color: '' }));
      setData(d => ({ ...d, contacts: [...d.contacts, ...additions] })); toast(`Imported ${additions.length} contact${additions.length === 1 ? '' : 's'}`);
    } catch (e) { toast(errorText(e)); }
  };

  const status = account ? accountStatus(account, snapshot.connections[account.id]) : undefined;
  return <div className="app">
    <header className="titlebar">
      {!window.desktop && <div className="fake-lights" aria-hidden="true"><i /><i /><i /></div>}
      <button type="button" className="line-button" aria-haspopup="dialog" aria-expanded={accountsOpen} onClick={() => setAccountsOpen(true)} title={account ? `${accountLabel(account)} · ${status?.text}\nSwitch or manage accounts (⌘L)` : 'Add a SIP account'}>
        <StatusDot state={status?.state || 'offline'} /><span>{account ? accountLabel(account) : 'No Account'}</span>
        {data.preferences.dnd && <Moon className="title-flag dnd" size={12} strokeWidth={2.2} aria-label="Do Not Disturb is on" />}{data.preferences.autoAnswer && <PhoneIncoming className="title-flag" size={12} strokeWidth={2.2} aria-label="Auto Answer is on" />}
        <ChevronDown size={12} strokeWidth={2.2} />
      </button>
      <div className="titlebar-actions">
        <span className="settings-button"><IconButton icon={Settings} label={update?.status === 'available' ? `Settings (⌘,) · DialDev ${update.version} is available` : 'Settings (⌘,)'} onClick={() => openSheet({ kind: 'settings' })} />{update?.status === 'available' && <span className="update-dot" aria-hidden="true" />}</span>
        {window.desktop && window.desktop.platform !== 'darwin' && <><IconButton icon={Minus} label="Minimize" onClick={() => window.desktop?.minimize()} /><IconButton icon={Square} size={12} label="Maximize" onClick={() => window.desktop?.maximize()} /><IconButton icon={X} label="Close" onClick={() => window.desktop?.close()} /></>}
      </div>
    </header>
    {snapshot.calls.length > 0 && data.pane !== 'keypad' && <CallBanner calls={snapshot.calls} open={() => setPane('keypad')} />}
    <main className="content">
      {data.pane === 'keypad' && <PhonePanel accounts={data.accounts} account={account} connections={snapshot.connections} register={actions.register} addAccount={newAccount}
        calls={snapshot.calls} focused={focused} setFocused={setFocused} number={number} setNumber={setNumber} dial={(target, video) => void dial(target, video)}
        contacts={data.contacts} history={data.history} preferences={data.preferences}
        voicemailCount={account ? snapshot.voicemail[account.id] || 0 : 0} voicemail={() => { if (account?.voicemail) void dial(account.voicemail); }}
        transfer={call => openSheet({ kind: 'transfer', call })} ended={ended} blocked={!!sheet || !!menu || accountsOpen} log={snapshot.log} />}
      {data.pane === 'history' && <HistoryPane history={data.history} contacts={data.contacts} fill={fill} dial={(n, video) => void dial(n, video)} openMenu={setMenu} recordingRefresh={recordingRefresh} toast={toast}
        clear={() => openSheet({ kind: 'confirm', title: 'Clear call history?', message: 'All calls are removed from Recents on this computer. Recordings are kept.', confirm: 'Clear History', destructive: true, action: () => setData(d => ({ ...d, history: [] })) })}
        confirmDelete={(name, remove) => openSheet({ kind: 'confirm', title: 'Delete recording?', message: `The recording with ${name} is permanently deleted from this computer.`, confirm: 'Delete', destructive: true, action: remove })} />}
      {data.pane === 'contacts' && <ContactsPane contacts={data.contacts} fill={fill} dial={n => void dial(n)} edit={contact => openSheet({ kind: 'contact', contact })} importFile={() => fileInput.current?.click()} openMenu={setMenu} />}
      {data.pane === 'messages' && <MessagesPane messages={data.messages} contacts={data.contacts} account={account} send={(peer, body) => void sendMessage(peer, body)} dial={n => void dial(n)} />}
      {data.pane === 'activity' && <ActivityPane log={snapshot.log} accounts={data.accounts} openMenu={setMenu} toast={toast} transcribe={data.preferences.transcribe} setTranscribe={on => setPreference('transcribe', on)} />}
    </main>
    <nav className="tabbar" aria-label="Sections">{tabs.map(({ value, label, icon: Icon }, i) => <button type="button" key={value} className={data.pane === value ? 'selected' : ''} aria-current={data.pane === value ? 'page' : undefined} title={`${label} (⌘${i + 1})`} onClick={() => setPane(value)}>
      <span className="tab-icon"><Icon size={21} strokeWidth={data.pane === value ? 2.1 : 1.7} />{value === 'history' && missed > 0 && <span className="badge">{missed}</span>}</span><span>{label}</span>
    </button>)}</nav>
    {accountsOpen && <AccountsPopover accounts={data.accounts} connections={snapshot.connections} selected={account?.id} select={id => setData(d => ({ ...d, selectedAccount: id }))} add={newAccount} actions={actions} openMenu={setMenu} limit={MAX_ACCOUNTS} voicemail={snapshot.voicemail} preferences={data.preferences} setPreference={setPreference} onClose={() => setAccountsOpen(false)} />}
    {sheet?.kind === 'account' && <AccountSheet key={sheet.account.id} initial={sheet.account} mode={sheet.mode} secretFrom={sheet.secretFrom} onSave={saveAccount} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'settings' && <SettingsSheet preferences={data.preferences} setPreference={setPreference} update={update} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'transfer' && <TransferSheet call={sheet.call} calls={snapshot.calls} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'contact' && <ContactSheet contact={sheet.contact} number={sheet.contact ? '' : number} onSave={saveContact} onDelete={sheet.contact && (() => setData(d => ({ ...d, contacts: d.contacts.filter(c => c.id !== sheet.contact!.id) })))} onClose={() => setSheet(null)} />}
    {sheet?.kind === 'confirm' && <ConfirmSheet title={sheet.title} message={sheet.message} confirm={sheet.confirm} destructive={sheet.destructive} onConfirm={sheet.action} onClose={() => setSheet(null)} />}
    {menu && <Menu menu={menu} onClose={closeMenu} />}
    <input type="file" ref={fileInput} accept=".vcf,text/vcard" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importContacts(file); e.target.value = ''; }} />
    {notice && <div className="toast" role="status">{notice}</div>}
    {snapshot.error && <div className="error-banner" role="alert"><TriangleAlert size={16} strokeWidth={2} /><p>{snapshot.error}</p><IconButton icon={X} size={14} label="Dismiss" onClick={phone.clearError} /></div>}
  </div>;
}
