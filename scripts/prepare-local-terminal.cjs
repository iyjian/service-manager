const fs = require('node:fs');
const path = require('node:path');

// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without executable bits.
// Set them before development startup AND before packaging (including x64
// builds produced on arm64). Never modify signed application files at runtime.
function prepareLocalTerminal() {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const directories = ['build/Release', 'build/Debug'];
  const prebuilds = path.join(root, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const name of fs.readdirSync(prebuilds)) directories.push(`prebuilds/${name}`);
  }
  if (process.platform !== 'win32') {
    for (const directory of directories) {
      const helper = path.join(root, directory, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
    }
  }
}
module.exports = prepareLocalTerminal;
if (require.main === module) prepareLocalTerminal();
