const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/prepare-release.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release@example.invalid');
  const commit = (version, message) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version }) + '\n');
    git('add', 'package.json');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const source = commit('0.3.80', 'Initial source');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  const run = (recovery = '') => {
    const output = path.join(root, 'output');
    fs.writeFileSync(output, '');
    execFileSync(process.execPath, [script], { cwd,
      env: { ...process.env, RELEASE_BRANCH: 'main', RECOVERY_COMMIT: recovery, GITHUB_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'] });
    return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
  };
  return { git, commit, source, run, remote };
}

test('release publishes one bump and retry reuses its exact tag and commit', t => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.version, '0.3.81');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], first.sha);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v0.3.81').split(/\s/)[0], first.sha);
  assert.deepEqual(f.run(), first);
  f.git('checkout', '--detach', f.source);
  assert.deepEqual(f.run(), first);
});

test('release resumes an old branch-only push from the original checkout', t => {
  const f = fixture(t);
  const sha = f.commit('0.3.81', 'chore(release): bump version to 0.3.81 [skip release]');
  f.git('push', 'origin', 'main');
  f.git('checkout', '--detach', f.source);
  assert.equal(f.run().sha, sha);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v0.3.81').split(/\s/)[0], sha);
});

test('explicit recovery tags an older release without moving the newer branch', t => {
  const f = fixture(t);
  const sha = f.commit('0.3.81', 'chore(release): bump version to 0.3.81 [skip release]');
  f.git('commit', '--allow-empty', '-m', 'Fix workflow');
  const newer = f.git('rev-parse', 'HEAD');
  f.git('push', 'origin', 'main');
  assert.equal(f.run(sha).sha, sha);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], newer);
  assert.throws(() => f.run(newer), /not a version-bump commit/);
});

test('release refuses a conflicting remote tag', t => {
  const f = fixture(t);
  f.git('tag', 'v0.3.81');
  f.git('push', 'origin', 'v0.3.81');
  assert.throws(() => f.run(), /refusing to overwrite/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.source);
});

test('release refuses unrelated branch advancement', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-m', 'Other work');
  f.git('push', 'origin', 'main');
  f.git('checkout', '--detach', f.source);
  assert.throws(() => f.run(), /remote branch has advanced/);
});

test('tag rejection leaves the remote branch unchanged with atomic push', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.remote, 'hooks', 'update'), '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\nexit 0\n', { mode: 0o755 });
  assert.throws(() => f.run());
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.source);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v0.3.81'), '');
});
