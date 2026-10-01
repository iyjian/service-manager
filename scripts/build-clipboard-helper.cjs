const { mkdirSync, chmodSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform === 'darwin') {
  const root = join(__dirname, '..');
  const output = join(root, 'dist/main/native/clipboard-macos');
  mkdirSync(join(root, 'dist/main/native'), { recursive: true });
  execFileSync('/usr/bin/clang', ['-fobjc-arc', '-O2', '-arch', 'arm64', '-arch', 'x86_64',
    '-mmacosx-version-min=11.0', '-framework', 'Cocoa', '-framework', 'ApplicationServices',
    join(root, 'src/main/core/native/clipboard-macos.m'), '-o', output], { stdio: 'inherit' });
  chmodSync(output, 0o755);
}
