import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('Icon generation requires macOS. Generated icons are included in the repository.');
const root = path.resolve(import.meta.dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
};
await mkdir(path.join(root, '.dist/swift-cache'), { recursive: true });
await mkdir(path.join(root, 'build/icon.iconset'), { recursive: true });
run('swift', ['-module-cache-path', '.dist/swift-cache', 'scripts/make-icon.swift']);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    run('sips', ['-z', String(size * scale), String(size * scale), 'build/icon.png', '--out', `build/icon.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`]);
  }
}
run('iconutil', ['-c', 'icns', 'build/icon.iconset', '-o', 'build/icon.icns']);
