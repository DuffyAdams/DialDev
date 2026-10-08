import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import electron from 'electron';

const root = path.resolve(import.meta.dirname, '..');

// macOS gets its menu-bar name from the app bundle, not app.setName().
// Keep a branded development runtime outside node_modules so npm ci stays clean.
export async function electronRuntime() {
  if (process.platform !== 'darwin') return electron;
  const source = path.resolve(electron, '../../..');
  const directory = path.join(root, '.dist/desktop');
  const bundle = path.join(directory, 'DialDev.app');
  const executable = path.join(bundle, 'Contents/MacOS/Electron');
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const icon = await readFile(path.join(root, 'build/icon.icns'));
  const info = await readFile(path.join(source, 'Contents/Info.plist'));
  const fingerprint = createHash('sha256').update('dialdev-runtime-v1').update(info).update(icon).update(JSON.stringify(metadata)).digest('hex');
  const stamp = path.join(directory, 'fingerprint');
  if (await readFile(stamp, 'utf8').catch(() => '') === fingerprint && await access(executable).then(() => true, () => false)) return executable;

  console.log('Preparing the DialDev macOS runtime…');
  await mkdir(directory, { recursive: true });
  await rm(stamp, { force: true });
  await rm(bundle, { recursive: true, force: true });
  await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const run = (command, args) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
  };
  const plist = path.join(bundle, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({
    CFBundleName: metadata.productName,
    CFBundleDisplayName: metadata.productName,
    CFBundleIdentifier: `${metadata.build.appId}.development`,
    CFBundleShortVersionString: metadata.version,
    CFBundleVersion: metadata.version,
    ...metadata.build.mac.extendInfo,
  })) run('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  await copyFile(path.join(root, 'build/icon.icns'), path.join(bundle, 'Contents/Resources/electron.icns'));
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
  await writeFile(stamp, fingerprint);
  return executable;
}
