const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');

test('home layout renders the nav rail with per-page shells', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');

  assert.match(html, /<nav id="nav-rail" class="nav-rail"/);
  assert.match(html, /<main class="app-shell" data-page="hosts">/);
  assert.match(html, /<main class="app-shell hidden" data-page="proxy">/);
  assert.match(html, /id="proxy-log-dialog"/);
  assert.match(html, /id="proxy-mode-seg"/);
  assert.match(html, /id="proxy-sub-url"/);
  assert.match(html, /aria-label="Strategy groups"/);
  assert.match(html, /id="proxy-group-list"/);
  assert.match(html, />Strategy Groups</);
});

test('nav module registers pages and persists the active page', async () => {
  const nav = await readFile(path.join(rendererDir, 'nav.js'), 'utf8');
  assert.match(nav, /registerPage/);
  assert.match(nav, /activatePage/);
  assert.match(nav, /localStorage\.setItem\(ACTIVE_PAGE_STORAGE_KEY, pageId\)/);

  const renderer = await readFile(path.join(rendererDir, 'renderer.js'), 'utf8');
  assert.match(renderer, /from ['"]\.\/nav\.js['"]/);
  assert.match(renderer, /from ['"]\.\/proxyPage\.js['"]/);
  assert.match(renderer, /initNav\('hosts'\)/);
});

test('Save & Fetch is the sole subscription action and only clears its URL after a successful fetch', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');

  assert.match(html, /id="proxy-save-sub-btn"/);
  assert.doesNotMatch(html, /id="proxy-update-sub-btn"/);
  assert.match(proxyPage, /saveAndFetchSubscription\(subUrlInput\.value\)/);
  assert.match(proxyPage, /saveAndFetchSubscription\(subUrlInput\.value\)[\s\S]{0,160}subUrlInput\.value = ''/);
  assert.doesNotMatch(proxyPage, /updateSubscription\(/);
  const fetchIndex = proxyPage.indexOf('saveAndFetchSubscription(subUrlInput.value)');
  assert.notEqual(fetchIndex, -1);
  assert.doesNotMatch(proxyPage.slice(fetchIndex, fetchIndex + 160), /await refreshGroups\(\)/);
  assert.match(proxyPage, /setMixedPort\(port\)[\s\S]{0,160}await refreshGroups\(\)/);
  assert.match(proxyPage, /setTun\(enabled\)[\s\S]{0,160}await refreshGroups\(\)/);
});

test('proxy controls keep all user-facing text in English', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');

  assert.doesNotMatch(html, /规则|全局|直连/);
  assert.doesNotMatch(proxyPage, /授权|撤销|内核/);
});

test('proxy page provides direct-exception controls in its shared content container', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');
  const styles = await readFile(path.join(rendererDir, 'tailwind.css'), 'utf8');

  assert.match(html, /class="proxy-page-container"/);
  assert.match(html, /aria-label="Direct exceptions"/);
  assert.match(html, /id="proxy-exception-type"/);
  assert.match(html, /id="proxy-exception-value"/);
  assert.match(html, /id="proxy-exception-list"/);
  assert.match(html, />Direct Exceptions</);
  for (const type of [
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'IP-CIDR',
    'IP-CIDR6',
    'SRC-IP-CIDR',
    'GEOIP',
    'DST-PORT',
    'SRC-PORT',
  ]) {
    assert.match(html, new RegExp(`<option value="${type}">${type}</option>`));
  }
  assert.match(proxyPage, /proxyApi\.addException/);
  assert.match(proxyPage, /proxyApi\.updateException/);
  assert.match(proxyPage, /proxyApi\.deleteException/);
  assert.match(
    proxyPage,
    /deleteException\(exception\.id\)[\s\S]{0,160}renderState\(state\);\s*clearExceptionEditor\(\);/
  );
  assert.match(styles, /\.proxy-page-container/);
  assert.doesNotMatch(html, /class="page-logo"/);
});

test('compiled tailwind styles cover the nav rail and proxy page', async () => {
  const styles = await readFile(path.join(rendererDir, 'tailwind.css'), 'utf8');
  assert.match(styles, /\.nav-rail/);
  assert.match(styles, /\.nav-item-active/);
  assert.match(styles, /\.seg-item-active/);
  assert.match(styles, /\.proxy-node/);
  assert.match(styles, /\.proxy-strategy-group/);
});
