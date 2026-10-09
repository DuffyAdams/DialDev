import type { AppData, Credentials, Pane, Recording } from '../types';
const panes: Pane[] = ['history', 'contacts', 'keypad', 'messages', 'activity'];
const namespace = window.desktop?.storageNamespace || 'dialdev';
export const defaults: AppData = { version: 1, accounts: [], contacts: [], history: [], messages: [], selectedAccount: '', pane: 'keypad', recentsSeen: 0, preferences: { theme: 'system', dnd: false, sounds: true, autoAnswer: false, forward: '', input: '', output: '', camera: '', echoCancellation: true, noiseSuppression: true, callDetails: false, transcribe: true, transcribeLocale: '', captions: false, checkUpdates: true, volume: 1, recordCalls: false } };
export function loadData(): AppData {
  try {
    const raw = JSON.parse(localStorage.getItem(`${namespace}.v1`) || 'null');
    if (!raw || raw.version !== 1) return structuredClone(defaults);
    const list = <T,>(value: unknown) => Array.isArray(value) ? value as T[] : [];
    return { version: 1, accounts: list(raw.accounts), contacts: list(raw.contacts), history: list(raw.history), messages: list(raw.messages), selectedAccount: typeof raw.selectedAccount === 'string' ? raw.selectedAccount : '', pane: panes.includes(raw.pane) ? raw.pane : 'keypad', recentsSeen: Number(raw.recentsSeen) || 0, preferences: { ...defaults.preferences, ...raw.preferences } };
  } catch { return structuredClone(defaults); }
}
export function saveData(data: AppData) { localStorage.setItem(`${namespace}.v1`, JSON.stringify(data)); }
const secrets = new Map<string, Credentials>();
export async function getSecret(id: string) { return secrets.get(id) ?? await window.desktop?.getSecret(id) ?? null; }
export async function saveSecret(id: string, secret: Credentials, remember: boolean) { if (remember && window.desktop) await window.desktop.saveSecret(id, secret); else await window.desktop?.deleteSecret(id); secrets.set(id, secret); }
export async function deleteSecret(id: string) { secrets.delete(id); await window.desktop?.deleteSecret(id); }
const database = () => new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`${namespace}-recordings`, 1); request.onupgradeneeded = () => request.result.createObjectStore('recordings', { keyPath: 'id' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
async function records<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => { const tx = db.transaction('recordings', mode); const request = action(tx.objectStore('recordings')); tx.oncomplete = () => { resolve(request.result); db.close(); }; tx.onerror = () => { reject(tx.error); db.close(); }; });
}
export const recordings = { list: () => records('readonly', s => s.getAll()) as Promise<Recording[]>, save: (record: Recording) => records('readwrite', s => s.put(record)), delete: (id: string) => records('readwrite', s => s.delete(id)) };
