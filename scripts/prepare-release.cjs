const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function prepareRelease({ branch, recoveryCommit = '', outputFile } = {}) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  git('check-ref-format', `refs/heads/${branch}`);
  if (git('status', '--porcelain')) throw new Error('Release preparation requires a clean checkout.');
  git('fetch', 'origin', `refs/heads/${branch}`);
  const remote = git('rev-parse', 'FETCH_HEAD');
  const source = git('rev-parse', 'HEAD');
  const pkgAt = (sha) => JSON.parse(git('show', `${sha}:package.json`));
  const message = (version) => `chore(release): bump version to ${version} [skip release]`;
  const nextVersion = (version) => {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!parts) throw new Error(`Unsupported version: ${version}`);
    return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
  };
  const isRelease = (sha) => {
    const version = pkgAt(sha).version;
    return git('log', '-1', '--format=%B', sha) === message(version)
      && git('diff-tree', '--no-commit-id', '--name-only', '-r', sha) === 'package.json'
      && nextVersion(pkgAt(`${sha}^`).version) === version;
  };
  let sha;
  let publishBranch = false;
  if (recoveryCommit) {
    if (!/^[a-f0-9]{40}$/i.test(recoveryCommit)) throw new Error('Recovery requires a full commit SHA.');
    git('merge-base', '--is-ancestor', recoveryCommit, remote);
    if (!isRelease(recoveryCommit)) throw new Error('Recovery target is not a version-bump commit.');
    sha = recoveryCommit;
  } else if (isRelease(source)) {
    git('merge-base', '--is-ancestor', source, remote);
    sha = source;
  } else if (remote !== source) {
    // A previous attempt may have pushed the bump but failed before its tag/output.
    if (git('rev-parse', `${remote}^`) !== source || !isRelease(remote)) {
      throw new Error('The remote branch has advanced. Start a new run or select a recovery commit.');
    }
    sha = remote;
  } else {
    const pkg = pkgAt(source);
    pkg.version = nextVersion(pkg.version);
    fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    git('add', 'package.json');
    git('commit', '-m', message(pkg.version));
    sha = git('rev-parse', 'HEAD');
    publishBranch = true;
  }
  const version = pkgAt(sha).version;
  const tag = `v${version}`;
  const refs = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  if (refs) {
    const entries = refs.split('\n').map((line) => line.split(/\s+/));
    const target = entries.find((entry) => entry[1].endsWith('^{}')) || entries[0];
    if (target[0] !== sha) throw new Error(`Tag ${tag} already points to a different commit; refusing to overwrite it.`);
  } else {
    const refspecs = [...(publishBranch ? [`${sha}:refs/heads/${branch}`] : []), `${sha}:refs/tags/${tag}`];
    // Atomic push prevents a successful branch update paired with a failed tag update.
    // The exact same objects/refspecs are safe to retry after a lost response.
    for (let attempt = 1; ; attempt += 1) {
      try { git('push', '--atomic', 'origin', ...refspecs); break; }
      catch (error) { if (attempt === 3) throw error; }
    }
  }
  if (outputFile) fs.appendFileSync(outputFile, `version=${version}\ntag=${tag}\nsha=${sha}\n`);
  return { version, tag, sha };
}

module.exports = { prepareRelease };
if (require.main === module) {
  try {
    console.log(prepareRelease({ branch: process.env.RELEASE_BRANCH,
      recoveryCommit: process.env.RECOVERY_COMMIT, outputFile: process.env.GITHUB_OUTPUT }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
