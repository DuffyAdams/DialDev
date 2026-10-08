const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

/** "v1.2.3" → [1, 2, 3]. Pre-release and other tags are not offered as updates. */
function parseVersion(value) { const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(value ?? '').trim()); return m ? m.slice(1).map(Number) : null; }
function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/** Reads `shasum -a 256` output into a map of file name → lowercase hex digest. */
function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) { const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line); if (m) sums.set(m[2], m[1].toLowerCase()); }
  return sums;
}
/** The release ZIP for this Mac, named like the electron-builder artifact: DialDev-0.3.0-macOS-arm64.zip. */
function releaseAsset(assets, arch) { return (Array.isArray(assets) ? assets : []).find(a => typeof a?.name === 'string' && a.name.endsWith(`-macOS-${arch}.zip`) && typeof a.browser_download_url === 'string'); }
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 4 << 20 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })));
const plist = async (bundle, key) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])).stdout.trim();
const teamOf = async bundle => /^TeamIdentifier=([A-Z0-9]{10})$/m.exec((await run('/usr/bin/codesign', ['-dv', '--verbose=2', bundle])).stderr)?.[1];

// Runs detached after DialDev quits: waits for it to exit, swaps in the new bundle (restoring the old one if that fails), reopens it and removes the download.
const INSTALL_SCRIPT = `pid="$1"; target="$2"; staged="$3"; work="$4"; backup="$work/previous.app"; tries=0
while kill -0 "$pid" 2>/dev/null; do tries=$((tries + 1)); [ "$tries" -gt 600 ] && exit 1; sleep 0.1; done
if mv "$target" "$backup"; then if ! mv "$staged" "$target"; then mv "$backup" "$target"; fi; fi
open "$target"; rm -rf "$work"`;

/**
 * Checks GitHub Releases for a newer DialDev and, on macOS, installs it in place: downloads the release ZIP, checks its SHA-256,
 * requires the new app to have the same bundle ID and Apple team signature as this one, then replaces the bundle and relaunches.
 */
class Updater {
  constructor({ repository, current, packaged, bundle, temp, emit, quit, fetch = globalThis.fetch, platform = process.platform, arch = process.arch }) {
    Object.assign(this, { repository, packaged, bundle, temp, emit, quit, fetch, platform, arch });
    this.state = { status: 'idle', current, canInstall: false }; this.release = null;
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit?.(this.state); return this.state; }
  async check() {
    if (['checking', 'downloading', 'installing'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: undefined });
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.repository}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `DialDev/${this.state.current}` } });
      if (response.status === 404) throw new Error(`No published releases were found at github.com/${this.repository}. The repository may be private.`);
      if (response.status === 403 || response.status === 429) throw new Error('GitHub’s request limit was reached. Try again later.');
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      const release = await response.json(); const version = String(release.tag_name || '').replace(/^v/, '');
      const url = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/') ? release.html_url : `https://github.com/${this.repository}/releases/latest`;
      if (!isNewer(version, this.state.current)) { this.release = null; return this.set({ status: 'current', version: undefined, notes: undefined, url, checked: Date.now(), canInstall: false, reason: undefined }); }
      const asset = releaseAsset(release.assets, this.arch); const sums = (release.assets || []).find(a => a?.name === 'SHA256SUMS.txt');
      this.release = { version, asset, sums };
      const reason = await this.blocker(asset);
      return this.set({ status: 'available', version, notes: typeof release.body === 'string' ? release.body.slice(0, 6000) : '', url, checked: Date.now(), canInstall: !reason, reason: reason || undefined });
    } catch (e) { return this.set({ status: 'error', error: e?.message || String(e), checked: Date.now() }); }
  }
  /** Why this copy of DialDev cannot update itself, or '' when it can. */
  async blocker(asset) {
    if (this.platform !== 'darwin') return 'Download the new version to install it.';
    if (!this.packaged) return 'Updates install in the packaged app.';
    if (!asset) return 'This release has no download for this Mac.';
    if (!this.bundle?.endsWith('.app') || this.bundle.startsWith('/Volumes/') || this.bundle.includes('/AppTranslocation/')) return 'Move DialDev to Applications to install updates here.';
    try { await fsp.access(path.dirname(this.bundle), fs.constants.W_OK); await fsp.access(this.bundle, fs.constants.W_OK); } catch { return `DialDev can’t replace itself in ${path.dirname(this.bundle)}.`; }
    return '';
  }
  /** Downloads, verifies and stages the update, then quits so the install script can swap it in. Resolves once DialDev is quitting. */
  async install() {
    if (this.state.status !== 'available' || !this.state.canInstall || !this.release?.asset) return;
    const { version, asset, sums } = this.release; let work;
    try {
      this.set({ status: 'downloading', progress: 0, error: undefined });
      work = await fsp.mkdtemp(path.join(this.temp, 'dialdev-update-'));
      const expected = await this.digest(asset, sums);
      const zip = path.join(work, 'update.zip'); await this.download(asset, zip, expected);
      this.set({ status: 'installing', progress: 1 });
      const unpacked = path.join(work, 'unpacked'); await run('/usr/bin/ditto', ['-x', '-k', zip, unpacked]);
      const name = (await fsp.readdir(unpacked)).find(n => n.endsWith('.app')); if (!name) throw new Error('The download does not contain an app.');
      const staged = path.join(unpacked, name);
      await this.verify(staged, version);
      spawn('/bin/sh', ['-c', INSTALL_SCRIPT, 'dialdev-update', String(process.pid), this.bundle, staged, work], { detached: true, stdio: 'ignore' }).unref();
      work = null; this.quit();
    } catch (e) {
      if (work) await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      this.set({ status: 'available', progress: undefined, error: e?.message || String(e) });
    }
  }
  async digest(asset, sums) {
    if (typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) return asset.digest.slice(7).toLowerCase();
    if (!sums?.browser_download_url) throw new Error('This release has no checksum, so it can’t be installed safely.');
    const response = await this.fetch(sums.browser_download_url); if (!response.ok) throw new Error(`Downloading checksums failed (${response.status}).`);
    const value = parseChecksums(await response.text()).get(asset.name); if (!value) throw new Error('This release has no checksum, so it can’t be installed safely.');
    return value;
  }
  async download(asset, file, expected) {
    const response = await this.fetch(asset.browser_download_url); if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const total = Number(asset.size) || Number(response.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256'); let received = 0, shown = 0; const report = progress => this.set({ progress });
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk); received += chunk.length; yield chunk;
        const progress = total ? Math.min(.99, received / total) : 0; if (progress - shown >= .01) { shown = progress; report(progress); }
      }
    }, fs.createWriteStream(file));
    if (hash.digest('hex') !== expected) throw new Error('The download was damaged. Try again.');
  }
  /** The new bundle must be the release version, with this app's bundle ID, and validly signed by the same Apple team. */
  async verify(staged, version) {
    const [id, currentId, shortVersion] = await Promise.all([plist(staged, 'CFBundleIdentifier'), plist(this.bundle, 'CFBundleIdentifier'), plist(staged, 'CFBundleShortVersionString')]);
    if (id !== currentId) throw new Error('The download is not DialDev.');
    if (shortVersion !== version) throw new Error(`The download is version ${shortVersion}, not ${version}.`);
    try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]); } catch { throw new Error('The download’s code signature is not valid.'); }
    const [team, currentTeam] = await Promise.all([teamOf(staged), teamOf(this.bundle)]);
    if (!currentTeam || team !== currentTeam) throw new Error('The download is not signed by the same developer as this copy of DialDev.');
  }
}

module.exports = { Updater, parseVersion, isNewer, parseChecksums, releaseAsset, INSTALL_SCRIPT };
