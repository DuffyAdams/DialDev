import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { Updater, isNewer, parseChecksums, releaseAsset } = require('../electron/updater.cjs');
const sum = 'a'.repeat(64);
const release = { tag_name: 'v0.3.0', html_url: 'https://github.com/DuffyAdams/DevDial/releases/tag/v0.3.0', body: 'Notes', assets: [
  { name: 'DialDev-0.3.0-macOS-arm64.dmg', browser_download_url: 'https://github.com/x/dmg' },
  { name: 'DialDev-0.3.0-macOS-arm64.zip', browser_download_url: 'https://github.com/x/zip', size: 10 },
  { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/x/sums' }
] };
const updater = (response: () => Response, options = {}) => new Updater({ repository: 'DuffyAdams/DevDial', current: '0.2.0', packaged: false, bundle: '/Applications/DialDev.app', temp: '/tmp', fetch: async () => response(), platform: 'darwin', arch: 'arm64', ...options });

describe('software updates', () => {
  it('offers only newer plain release versions', () => {
    expect(isNewer('0.2.1', '0.2.0')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('', '0.2.0')).toBe(false);
  });
  it('reads shasum output and picks the ZIP for this architecture', () => {
    const sums = parseChecksums(`${sum}  DialDev-0.3.0-macOS-arm64.zip\n${'B'.repeat(64)} *DialDev-0.3.0-macOS-arm64.dmg\nnot a line`);
    expect(sums.get('DialDev-0.3.0-macOS-arm64.zip')).toBe(sum);
    expect(sums.get('DialDev-0.3.0-macOS-arm64.dmg')).toBe('b'.repeat(64));
    expect(sums.size).toBe(2);
    expect(releaseAsset(release.assets, 'arm64')?.name).toBe('DialDev-0.3.0-macOS-arm64.zip');
    expect(releaseAsset(release.assets, 'x64')).toBeUndefined();
  });
  it('reports a newer release, and why a development build cannot install it', async () => {
    const states: { status: string }[] = [];
    const u = updater(() => Response.json(release), { emit: (s: { status: string }) => states.push(s) });
    expect(await u.check()).toMatchObject({ status: 'available', version: '0.3.0', current: '0.2.0', notes: 'Notes', url: release.html_url, canInstall: false, reason: 'Updates install in the packaged app.' });
    expect(states.map(s => s.status)).toEqual(['checking', 'available']);
  });
  it('says when this version is current', async () => {
    expect(await updater(() => Response.json({ ...release, tag_name: 'v0.2.0' })).check()).toMatchObject({ status: 'current', canInstall: false });
  });
  it('explains a missing or private repository and rate limits', async () => {
    expect((await updater(() => new Response('', { status: 404 })).check()).error).toMatch(/may be private/);
    expect((await updater(() => new Response('', { status: 403 })).check()).error).toMatch(/limit/);
  });
  it('sends other platforms to the download page', async () => {
    expect(await updater(() => Response.json(release), { platform: 'win32', packaged: true }).check()).toMatchObject({ status: 'available', canInstall: false, reason: 'Download the new version to install it.' });
  });
  it('will not update a copy running from a disk image', async () => {
    expect((await updater(() => Response.json(release), { packaged: true, bundle: '/Volumes/DialDev/DialDev.app' }).check()).reason).toMatch(/Move DialDev to Applications/);
  });
  it('refuses to install a release without a checksum', async () => {
    const u = updater(() => Response.json({ ...release, assets: release.assets.slice(0, 2) }), { packaged: true, bundle: process.cwd() + '/Fake.app' });
    u.blocker = async () => '';
    await u.check(); await u.install();
    expect(u.state).toMatchObject({ status: 'available', error: 'This release has no checksum, so it can’t be installed safely.' });
  });
});
