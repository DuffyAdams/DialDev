import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, access, chmod } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const work = path.join(root, '.dist/native-src'), prefix = path.join(root, '.dist/native-prefix');
await mkdir(work, { recursive: true });
const localCmake = path.join(root, '.dist/toolchain/cmake/data/bin/cmake');
const cmake = process.env.CMAKE_BIN || await access(localCmake).then(() => localCmake).catch(() => 'cmake');
const run = (cmd, args) => { const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env }); if (result.error || result.status !== 0) throw result.error || new Error(`${cmd} exited ${result.status}`); };
const sources = [
  ['re', '4.12.0', 'baresip/re', '707b6194dd3b8d3fb1641ca08a0999aaac1d38d36b5c45514777a13ded311923'],
  ['baresip', '4.12.0', 'baresip/baresip', '710d79d60c15c09f0aeb93e5d2f219e7f12ab93f62cab826e4280592a1ea155f'],
  ['opus', '1.5.2', 'xiph/opus', '9480e329e989f70d69886ded470c7f8cfe6c0667cc4196d4837ac9e668fb7404'],
];
for (const [name, version, repository, sha] of sources) {
  const archive = path.join(work, `${name}.tar.gz`);
  let bytes = await readFile(archive).catch(() => null);
  if (!bytes) { const response = await fetch(`https://github.com/${repository}/archive/refs/tags/v${version}.tar.gz`); if (!response.ok) throw new Error(`Could not download ${name}`); bytes = Buffer.from(await response.arrayBuffer()); await writeFile(archive, bytes); }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`Source checksum mismatch: ${name}`);
  // Re-extract before applying the local authentication patch, making builds reproducible.
  run('tar', ['-xzf', archive, '-C', work]);
}
const mac = process.platform === 'darwin';
const openssl = process.env.OPENSSL_ROOT_DIR || (mac ? process.arch === 'arm64' ? '/opt/homebrew/opt/openssl@3' : '/usr/local/opt/openssl@3' : '');
const common = ['-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_INSTALL_PREFIX=${prefix}`, ...(mac ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0'] : []), ...(openssl ? [`-DOPENSSL_ROOT_DIR=${openssl}`, ...(mac ? [`-DOPENSSL_INCLUDE_DIR=${openssl}/include`, `-DOPENSSL_SSL_LIBRARY=${openssl}/lib/libssl.a`, `-DOPENSSL_CRYPTO_LIBRARY=${openssl}/lib/libcrypto.a`] : [])] : []), '-DOPENSSL_USE_STATIC_LIBS=TRUE', ...(process.env.CMAKE_TOOLCHAIN_FILE ? [`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`] : [])];
function build(name, version, options, install = true) { const dir = path.join(work, `${name}-build`); run(cmake, ['-S', path.join(work, `${name}-${version}`), '-B', dir, ...common, ...options]); run(cmake, ['--build', dir, '--config', 'Release', '-j', '8']); if (install) run(cmake, ['--install', dir, '--config', 'Release']); }
build('re', '4.12.0', ['-DLIBRE_BUILD_SHARED=OFF']);
build('opus', '1.5.2', ['-DBUILD_SHARED_LIBS=OFF', '-DOPUS_BUILD_TESTING=OFF']);
run(process.platform === 'win32' ? 'python' : 'python3', ['scripts/patch-native.py', path.join(work, 'baresip-4.12.0')]);
const driver = mac ? 'audiounit' : process.platform === 'win32' ? 'winwave' : 'pulse';
const staticLib = process.platform === 'win32' ? 're.lib' : 'libre.a'; const opusLib = process.platform === 'win32' ? 'opus.lib' : 'libopus.a';
build('baresip', '4.12.0', [`-DCMAKE_PREFIX_PATH=${prefix}`, `-DRE_INCLUDE_DIR=${prefix}/include/re`, `-DRE_LIBRARY=${prefix}/lib/${staticLib}`, `-DOPUS_INCLUDE_DIR=${prefix}/include`, `-DOPUS_LIBRARY=${prefix}/lib/${opusLib}`, '-DSTATIC=ON', `-DMODULES=aufile;ausine;aubridge;${driver};g711;opus;ctrl_tcp;menu;uuid;stun;turn;ice;srtp;dtls_srtp;mixminus;mwi;netroam`, '-DAPP_MODULES=dialdev', `-DAPP_MODULES_DIR=${root}/native/module`], false);
const destination = path.join(root, 'native', `${process.platform}-${process.arch}`); await mkdir(destination, { recursive: true });
const executable = process.platform === 'win32' ? 'baresip.exe' : 'baresip';
let output = path.join(work, 'baresip-build', executable); if (process.platform === 'win32') output = path.join(work, 'baresip-build/Release', executable);
await copyFile(output, path.join(destination, executable)); if (process.platform !== 'win32') await chmod(path.join(destination, executable), 0o755);
console.log(`Native SIP engine: ${destination}/${executable}`);
