import { spawn } from 'node:child_process';
import { electronRuntime } from './electron-runtime.mjs';

const child = spawn(await electronRuntime(), ['.'], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
