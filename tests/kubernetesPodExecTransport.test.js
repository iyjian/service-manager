const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createKubernetesClient } = require('../dist/main/kubernetes/kubernetesClient');
const {
  buildPodExecCommand,
  createUtf8ChunkDecoder,
} = require('../dist/main/kubernetes/podExecTransport');

test('Pod Exec bootstrap preserves the requested shell as argv data', () => {
  const shell = "/bin/sh'; echo should-not-be-interpolated";
  const command = buildPodExecCommand(shell);

  assert.equal(command[0], shell);
  assert.equal(command[1], '-c');
  assert.equal(command[3], shell);
  assert.equal(command[2].includes(shell), false);
  assert.match(command[2], /exec "\$0" -i/);
});

test('Pod Exec bootstrap silently probes UTF-8 locales in priority order', () => {
  const script = buildPodExecCommand('/bin/sh')[2];
  const candidates = ['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8'];
  const indexes = candidates.map((candidate) => script.indexOf(candidate));

  assert.ok(indexes.every((index) => index >= 0));
  assert.deepEqual([...indexes].sort((left, right) => left - right), indexes);
  assert.match(script, /locale charmap 2>\/dev\/null/);
  assert.match(script, /unset LC_ALL/);
  assert.match(script, /LC_CTYPE=\$_sm_utf8_locale/);
  assert.match(script, /stty iutf8 >\/dev\/null 2>&1 \|\| :/);
});

test('Pod Exec bootstrap upgrades only missing or dumb TERM without probe output', () => {
  const script = buildPodExecCommand('ash')[2];

  assert.match(script, /case "\$\{TERM-\}" in/);
  assert.match(script, /''\|dumb\)/);
  assert.match(script, /infocmp xterm-256color >\/dev\/null 2>&1/);
  assert.match(script, /TERM=xterm-256color tput colors >\/dev\/null 2>&1/);
  assert.match(script, /TERM=xterm/);
});

test('UTF-8 chunk decoder preserves a character split across chunks', () => {
  const decoder = createUtf8ChunkDecoder();
  const bytes = Buffer.from('A中文B', 'utf8');

  assert.equal(decoder.write(bytes.subarray(0, 2)), 'A');
  assert.equal(decoder.write(bytes.subarray(2, 5)), '中');
  assert.equal(decoder.write(bytes.subarray(5, 6)), '');
  assert.equal(decoder.end(bytes.subarray(6)), '文B');
});

test('UTF-8 chunk decoder flushes once and ignores late terminal data', () => {
  const decoder = createUtf8ChunkDecoder();
  const incomplete = Buffer.from('中', 'utf8').subarray(0, 2);

  assert.equal(decoder.write(incomplete), '');
  assert.equal(decoder.end(), '\ufffd');
  assert.equal(decoder.end(), '');
  assert.equal(decoder.write(Buffer.from('late')), '');
});

test('KubernetesClient wires the bootstrap and independent streaming decoders into Pod Exec', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'service-manager-pod-exec-'));
  const kubeconfigPath = path.join(directory, 'config');
  await fs.writeFile(kubeconfigPath, `
apiVersion: v1
kind: Config
clusters:
  - name: cluster
    cluster:
      server: https://127.0.0.1
contexts:
  - name: token
    context:
      cluster: cluster
      user: token
current-context: token
users:
  - name: token
    user:
      token: test-token
`, 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const execCalls = [];
  let socketCloseCount = 0;
  class Api {}
  class KubeConfig {
    loadFromString() {}
    makePathsAbsolute() {}
    setCurrentContext() {}
    getContextObject(name) { return { name }; }
    getCurrentUser() { return { token: 'test-token' }; }
    makeApiClient() { return {}; }
  }
  class Exec {
    async exec(namespace, podName, container, command, stdout, stderr, stdin, tty) {
      execCalls.push({ namespace, podName, container, command, stdout, stderr, stdin, tty });
      return {
        addEventListener() {},
        close() {
          socketCloseCount += 1;
        },
      };
    }
  }
  const client = await createKubernetesClient({ kubeconfigPath, context: 'token' }, {
    loadKubernetesNode: async () => ({
      KubeConfig,
      VersionApi: Api,
      CoreV1Api: Api,
      DiscoveryV1Api: Api,
      AppsV1Api: Api,
      NetworkingV1Api: Api,
      ApiextensionsV1Api: Api,
      CustomObjectsApi: Api,
      Watch: class Watch {},
      Log: class Log {},
      Exec,
      PortForward: class PortForward {},
    }),
  });
  t.after(() => client.close());

  const events = [];
  const handle = await client.openPodExec({
    namespace: 'apps',
    podName: 'api-0',
    container: 'api',
    shell: '/bin/sh',
  }, {
    onData: (data) => events.push(`data:${data}`),
    onClose: () => events.push('close'),
    onError: (error) => events.push(`error:${error.message}`),
    onStatusFailure: (error) => events.push(`status:${error.message}`),
  });

  assert.equal(execCalls.length, 1);
  const call = execCalls[0];
  assert.deepEqual(call.command, buildPodExecCommand('/bin/sh'));
  assert.equal(call.tty, true);

  const chinese = Buffer.from('中', 'utf8');
  call.stdout.write(chinese.subarray(0, 2));
  call.stderr.write(Buffer.from('E', 'utf8'));
  call.stdout.write(chinese.subarray(2));
  assert.deepEqual(events, ['data:E', 'data:中']);

  handle.write('中文');
  assert.equal(call.stdin.read().toString('utf8'), '中文');
  handle.resize(120, 40);
  assert.equal(call.stdout.columns, 120);
  assert.equal(call.stdout.rows, 40);

  call.stderr.write(Buffer.from('文', 'utf8').subarray(0, 2));
  await handle.close();
  assert.deepEqual(events, ['data:E', 'data:中', 'data:�', 'close']);
  assert.equal(socketCloseCount, 1);
});
