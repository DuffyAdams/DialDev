#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
project_root="$PWD"
mkdir -p .dist/native-src
archive=.dist/native-src/openssl.tar.gz
if [ ! -f "$archive" ]; then
  curl -fL https://github.com/openssl/openssl/releases/download/openssl-3.6.4/openssl-3.6.4.tar.gz -o "$archive"
fi
actual=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
[ "$actual" = '9bffaa1ad1e07b354c21bd3324ec02fa15579f45a7d0494b3e74bc449b7333ef' ] || { echo 'OpenSSL checksum mismatch' >&2; exit 1; }
tar -xzf "$archive" -C .dist/native-src
case "$(uname -m)" in arm64) target=darwin64-arm64-cc ;; x86_64) target=darwin64-x86_64-cc ;; *) echo 'Use a macOS build host' >&2; exit 1 ;; esac
cd .dist/native-src/openssl-3.6.4
./Configure "$target" no-shared no-tests --prefix="$project_root/.dist/openssl-prefix" -mmacosx-version-min=14.0
make -j8
make install_sw
