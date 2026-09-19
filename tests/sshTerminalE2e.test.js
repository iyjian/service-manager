const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

test('Electron Hosts SSH tabs use real preload/IPC, retain sessions across pages, resize and clean up on reload', {
  skip: process.env.SERVICE_MANAGER_SSH_E2E !== '1', timeout: 60000,
}, async () => {
  const output = process.env.SERVICE_MANAGER_SSH_QA_OUTPUT || await mkdtemp(path.join(os.tmpdir(), 'service-manager-ssh-e2e-'));
  const binary = require('electron');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let log = '';
  try {
    const child = spawn(binary, [path.join(__dirname, 'helpers/sshTerminalElectron.cjs'), output], { env });
    child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    assert.equal(code, 0, log);
    const result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
    assert.equal(result.layout.length, 3);
    assert.deepEqual(result.errors, []);
  } finally { if (!process.env.SERVICE_MANAGER_SSH_QA_OUTPUT) await rm(output, { recursive: true, force: true }); }
});
