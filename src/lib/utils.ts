import type { Account, LogEntry, Transport } from '../types';
export const uid = () => crypto.randomUUID();
export const accountLabel = (a: Pick<Account, 'name' | 'username' | 'domain'>) => a.name.trim() || `${a.username}@${a.domain}`;
export const defaultPort = (transport: Transport) => transport === 'tls' ? '5061' : '5060';
/** Reads a host, host:port, user@host or full SIP URI (sip:user@host:port;transport=tcp) into account fields. */
export function parseSipInput(input: string): Partial<Pick<Account, 'username' | 'domain' | 'port' | 'transport'>> | null {
  let rest = input.trim(); const out: Partial<Pick<Account, 'username' | 'domain' | 'port' | 'transport'>> = {};
  const scheme = rest.match(/^(sips?):/i); if (scheme) { rest = rest.slice(scheme[0].length); if (scheme[1].toLowerCase() === 'sips') out.transport = 'tls'; }
  const [address, ...params] = rest.split(';');
  for (const param of params) { const [key, value = ''] = param.split('='); const transport = value.toLowerCase(); if (key.toLowerCase() === 'transport' && ['udp', 'tcp', 'tls', 'ws', 'wss'].includes(transport)) out.transport = transport === 'ws' ? 'wss' : transport as Transport; }
  let host = address; const at = address.lastIndexOf('@');
  if (at >= 0) { try { out.username = decodeURIComponent(address.slice(0, at).split(':')[0]); } catch { return null; } host = address.slice(at + 1); }
  const match = host.match(/^(\[[a-fA-F\d:]+\]|[a-zA-Z0-9.-]+)(?::(\d{1,5}))?$/); if (!match) return null;
  out.domain = match[1]; if (match[2]) out.port = match[2];
  return out;
}
export function dialTarget(value: string, domain: string): string {
  const raw = value.trim().replace(/^tel:/i, '');
  if (!raw || /[\r\n<>"\\]/.test(raw)) throw new Error('Enter a valid phone number or SIP address.');
  if (/^sips?:/i.test(raw)) return raw;
  if (raw.includes('@')) return `sip:${raw}`;
  const number = raw.replace(/[\s().-]/g, '');
  if (!/^[+*#\da-zA-Z_]+$/.test(number)) throw new Error('Enter a valid phone number or extension.');
  if (!domain) throw new Error('Your account needs a SIP domain.');
  return `sip:${number}@${domain}`;
}
export const normalize = (n: string) => n.replace(/^sips?:/i, '').replace(/[\s().-]/g, '').toLowerCase();
export const samePeer = (a: string, b: string) => normalize(a) === normalize(b);
export const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export function duration(seconds: number) { const n = Math.max(0, Math.floor(seconds)); return `${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; }
export const timeLabel = (time: number) => new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const clock = (time: number, ms = false) => new Date(time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', ...(ms ? { fractionalSecondDigits: 3 as const } : {}) });
export function dayLabel(time: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (time >= today.getTime()) return 'Today';
  if (time >= yesterday.getTime()) return 'Yesterday';
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
/** One line of the Activity text export, such as `2026-10-08T17:02:11.204Z  SPEECH   [Line 1]  Acme IVR: For billing, press one.` */
export const logLine = (e: LogEntry, account: string) => `${new Date(e.time).toISOString()}  ${(e.kind || e.level).toUpperCase().padEnd(7)}  [${account}]  ${e.kind ? `${e.speaker || 'Remote'}: ` : ''}${e.text}${e.partial ? ' …' : ''}${e.detail ? ` (${e.detail})` : ''}`;
export const errorText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.';
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* Fall back to a selection copy below. */ }
  const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
  const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('Could not copy to the clipboard.');
}
export function download(blob: Blob, name: string) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
export function parseVCard(text: string) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/BEGIN:VCARD/i).slice(1).map(card => {
    const field = (key: string) => card.match(new RegExp(`^${key}(?:;[^:\\r\\n]*)?:(.*)$`, 'mi'))?.[1]?.trim().replace(/\\n/g, '\n').replace(/\\([,;\\])/g, '$1') ?? '';
    return { name: field('FN'), number: field('TEL'), email: field('EMAIL'), company: field('ORG') };
  }).filter(c => c.name && c.number);
}
export function vCard(contacts: {name: string; number: string; email: string; company: string}[]) {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');
  return contacts.map(c => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escape(c.name)}`, `TEL:${escape(c.number)}`, `EMAIL:${escape(c.email)}`, `ORG:${escape(c.company)}`, 'END:VCARD'].join('\r\n')).join('\r\n');
}
