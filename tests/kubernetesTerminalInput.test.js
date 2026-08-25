const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const {
  validateKubernetesTerminalInput,
} = require('../dist/main/kubernetes/terminalInput.js');

test('validateKubernetesTerminalInput preserves exact non-empty terminal input', () => {
  const inputs = [
    ' ',
    '\r',
    '\n',
    '\t',
    '\u001b[A',
    '中文',
    '\u001b[D',
    '\u0003',
    'ls -l\r',
  ];

  for (const input of inputs) {
    assert.equal(validateKubernetesTerminalInput(input), input);
  }
});

test('validateKubernetesTerminalInput enforces the 65,536 character boundary', () => {
  const maximumInput = 'x'.repeat(65_536);

  assert.equal(validateKubernetesTerminalInput(maximumInput), maximumInput);
  assert.throws(
    () => validateKubernetesTerminalInput(`${maximumInput}x`),
    /within the allowed size/i
  );
});

test('validateKubernetesTerminalInput rejects empty and non-string input', () => {
  assert.throws(() => validateKubernetesTerminalInput(''), /within the allowed size/i);
  assert.throws(() => validateKubernetesTerminalInput(Buffer.from('x')), /must be text/i);
});

test('Kubernetes terminal IPC uses the exact-input validator for keyboard data', async () => {
  const main = await readFile(path.join(__dirname, '..', 'dist', 'main', 'kubernetes', 'ipcHandlers.js'), 'utf8');
  const handlerStart = main.indexOf('IPC_CHANNELS.kubernetesWriteTerminal');
  const handlerEnd = main.indexOf('IPC_CHANNELS.kubernetesResizeTerminal', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0);
  assert.match(handler, /validateKubernetesTerminalInput\)\(payload\.data\)/);
  assert.doesNotMatch(handler, /validateKubernetesText\)?\(payload\.data/);
});
