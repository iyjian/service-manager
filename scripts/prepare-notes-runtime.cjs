const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const version = 'v24.21.0';
const hashes = {
  'linux-arm64': '724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5',
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
};
(async () => {
  const cache = path.join(__dirname, '..', 'node_modules', '.cache', 'notes-runtime');
  const out = path.join(__dirname, '..', 'dist', 'notes-runtime');
  await fs.mkdir(cache, { recursive: true }); await fs.mkdir(out, { recursive: true });
  for (const [target, hash] of Object.entries(hashes)) {
    const name = `node-${version}-${target}.tar.gz`; const cached = path.join(cache, name);
    let bytes = await fs.readFile(cached).catch(() => undefined);
    const valid = value => value && crypto.createHash('sha256').update(value).digest('hex') === hash;
    if (!valid(bytes)) {
      const response = await fetch(`https://nodejs.org/dist/${version}/${name}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`Cannot prepare Notes runtime for ${target}.`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!valid(bytes)) throw new Error('Notes runtime checksum mismatch.');
      await fs.writeFile(cached, bytes);
    }
    await fs.writeFile(path.join(out, `${target}.tar.gz`), bytes);
  }
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ version, hashes }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
