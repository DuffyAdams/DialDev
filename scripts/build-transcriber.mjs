import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
// Builds the on-device transcription helper. It runs on macOS 14+ and transcribes on macOS 26+, where SpeechAnalyzer is available.
if (process.platform !== 'darwin') { console.log('Live transcription uses Apple Speech and is built on macOS only.'); process.exit(0); }
const root = path.resolve(import.meta.dirname, '..');
const arch = process.env.TARGET_ARCH || process.arch, target = arch === 'arm64' ? 'arm64' : 'x86_64';
const destination = path.join(root, 'native', `darwin-${arch}`); await mkdir(destination, { recursive: true }); await mkdir(path.join(root, '.dist/swift-cache'), { recursive: true });
const output = path.join(destination, 'dialdev-transcribe');
const result = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-swift-version', '5', '-target', `${target}-apple-macos14.0`, '-module-cache-path', path.join(root, '.dist/swift-cache'), '-o', output, path.join(root, 'native/transcriber/main.swift')], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) throw result.error || new Error(`swiftc exited ${result.status}`);
console.log(`Transcription helper: ${output}`);
