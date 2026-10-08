import { describe, expect, it, vi } from 'vitest';
const stored = new Map<string, string>();
vi.stubGlobal('window', {});
vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
const { loadData } = await import('../src/lib/storage');
describe('saved data', () => {
  it('starts on the keypad with system appearance', () => { stored.clear(); expect(loadData()).toMatchObject({ pane: 'keypad', recentsSeen: 0, accounts: [], preferences: { theme: 'system', callDetails: false } }); });
  it('migrates data saved by earlier layouts and drops retired fields', () => {
    stored.set('dialdev.v1', JSON.stringify({ version: 1, demo: true, pane: 'recordings', accounts: [{ id: 'a' }], history: 'bad', preferences: { theme: 'dark', dnd: true } }));
    const data = loadData();
    expect(data).toMatchObject({ pane: 'keypad', recentsSeen: 0, accounts: [{ id: 'a' }], history: [], preferences: { theme: 'dark', dnd: true, sounds: true } });
    expect(data).not.toHaveProperty('demo');
  });
  it('keeps a valid tab and badge position', () => { stored.set('dialdev.v1', JSON.stringify({ version: 1, pane: 'activity', recentsSeen: 1234 })); expect(loadData()).toMatchObject({ pane: 'activity', recentsSeen: 1234 }); });
  it('reads and saves the desktop profile through its DialDev namespace', async () => {
    stored.clear();
    vi.resetModules();
    vi.stubGlobal('window', { desktop: { storageNamespace: 'dialdev' } });
    try {
      stored.set('dialdev.v1', JSON.stringify({ version: 1, accounts: [{ id: 'saved-account' }], pane: 'history' }));
      const storage = await import('../src/lib/storage');
      const data = storage.loadData();
      expect(data.accounts).toEqual([{ id: 'saved-account' }]);
      storage.saveData({ ...data, recentsSeen: 42 });
      expect(JSON.parse(stored.get('dialdev.v1')!).recentsSeen).toBe(42);
    } finally { vi.stubGlobal('window', {}); }
  });
});
