const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const rendererDir = path.join(__dirname, '..', 'dist', 'renderer');
const mainDir = path.join(__dirname, '..', 'dist', 'main');

test('home layout renders the nav rail with per-page shells', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');
  const main = await readFile(path.join(mainDir, 'main.js'), 'utf8');
  const preload = await readFile(path.join(mainDir, 'preload.js'), 'utf8');

  assert.match(html, /<nav id="nav-rail" class="nav-rail"/);
  assert.match(html, /<main class="app-shell" data-page="hosts">/);
  assert.match(html, /<main class="app-shell hidden" data-page="proxy">/);
  assert.match(html, /id="proxy-log-dialog"/);
  assert.match(html, /id="proxy-mode-seg"/);
  assert.match(html, /id="proxy-sub-url"/);
  assert.match(html, /aria-label="Strategy groups"/);
  assert.match(html, /id="proxy-group-list"/);
  assert.match(html, />Strategy Groups</);
  assert.doesNotMatch(html, /id="proxy-refresh-groups-btn"/);
  assert.doesNotMatch(html, />Refresh<\/button>/);
  assert.doesNotMatch(proxyPage, /const refreshGroupsButton = requireElement/);
  assert.doesNotMatch(proxyPage, /refreshGroupsButton\.addEventListener/);
  assert.match(proxyPage, /onShow:\s*\(\) => \{\s*void refreshState\(\)\.then\(\(\) => refreshGroups\(\)\);/);
  assert.match(proxyPage, /setMessage\('Proxy started\.', 'success'\);\s*await refreshGroups\(\);/);
  assert.doesNotMatch(html, /id="proxy-apply-port-btn"/);
  assert.doesNotMatch(proxyPage, /applyPortButton/);
  assert.doesNotMatch(proxyPage, /setMixedPort\(/);
  assert.match(proxyPage, /const isMixedPortEditable = state\.running === 'stopped' \|\| state\.running === 'error';/);
  assert.match(proxyPage, /mixedPortInput\.disabled = !isMixedPortEditable;/);
  assert.match(proxyPage, /const port = Number\(mixedPortInput\.value\);[\s\S]{0,120}startProxy\(port\)/);
  assert.match(proxyPage, /mixedPortDraft = mixedPortInput\.value/);
  assert.match(html, /Set before starting\./);
  assert.doesNotMatch(main, /proxy:set-mixed-port/);
  assert.doesNotMatch(preload, /proxy:set-mixed-port/);
  assert.match(preload, /startProxy:\s*\(mixedPort\)\s*=>\s*electron_1\.ipcRenderer\.invoke\('proxy:start', mixedPort\)/);
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
  assert.match(proxyPage, /setTun\(enabled\)[\s\S]{0,160}await refreshGroups\(\)/);
});

test('proxy controls keep user-facing text in English apart from the approved Custom Rules heading', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');

  assert.doesNotMatch(html, /全局|直连/);
  assert.doesNotMatch(proxyPage, /授权|撤销|内核/);
});

test('proxy page provides Custom Rules controls in its shared content container', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const proxyPage = await readFile(path.join(rendererDir, 'proxyPage.js'), 'utf8');
  const styles = await readFile(path.join(rendererDir, 'tailwind.css'), 'utf8');

  assert.match(html, /class="proxy-page-container"/);
  assert.match(html, /aria-label="Custom rules"/);
  assert.match(html, /id="proxy-exception-type"/);
  assert.match(html, /id="proxy-rule-target"/);
  assert.match(html, /id="proxy-exception-value"/);
  assert.match(html, /id="proxy-exception-list"/);
  assert.match(html, />自定义规则</);
  assert.doesNotMatch(html, />Direct Exceptions</);
  assert.match(html, /<option value="PROXY">PROXY<\/option>/);
  assert.match(html, /<option value="DIRECT">DIRECT<\/option>/);
  assert.match(html, /placeholder="example\.com"/);
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
  assert.match(proxyPage, /const RULE_VALUE_PLACEHOLDERS/);
  assert.match(proxyPage, /target: ruleTargetSelect\.value/);
  assert.match(proxyPage, /document\.createTextNode\(exception\.target\)/);
  assert.doesNotMatch(proxyPage, /innerHTML\s*=\s*[^;]*(?:exception|rule)\.(?:type|target|value)/);
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

test('Host header shows live total app memory instead of host runtime totals', async () => {
  const html = await readFile(path.join(rendererDir, 'index.html'), 'utf8');
  const renderer = await readFile(path.join(rendererDir, 'renderer.js'), 'utf8');
  const preload = await readFile(path.join(mainDir, 'preload.js'), 'utf8');
  const main = await readFile(path.join(mainDir, 'main.js'), 'utf8');

  assert.match(html, /id="page-stats"/);
  assert.match(renderer, /Memory \$\{formatGigabytes\(bytes\)\} GB/);
  assert.match(renderer, /getAppMemoryUsage\(\)/);
  assert.match(renderer, /const APP_MEMORY_REFRESH_INTERVAL_MS = 5000/);
  assert.match(renderer, /window\.setInterval\(\(\) => void refreshAppMemoryUsage\(\), APP_MEMORY_REFRESH_INTERVAL_MS\)/);
  assert.match(preload, /getAppMemoryUsage/);
  assert.match(main, /app:memory-usage/);
  assert.doesNotMatch(renderer, /\$\{hosts\.length\} host/);
  assert.doesNotMatch(renderer, /tunnels`,[\s\S]{0,80}services/);
  assert.doesNotMatch(renderer, /stat-up/);
});

test('host cards omit aggregate runtime counts while retaining individual row statuses', async () => {
  const renderer = await readFile(path.join(rendererDir, 'renderer.js'), 'utf8');
  const oldHostHeaderSummary = /⇄ \$\{tunnelRunning\}\/\$\{tunnelCount\} · ▶ \$\{serviceRunning\}\/\$\{serviceCount\}/;

  assert.doesNotMatch(renderer, /host-panel-count/);
  assert.match('⇄ ${tunnelRunning}/${tunnelCount} · ▶ ${serviceRunning}/${serviceCount}', oldHostHeaderSummary);
  assert.doesNotMatch(renderer, oldHostHeaderSummary);
  assert.match(renderer, /formatStatus\(forward\.status\)/);
  assert.match(renderer, /formatStatus\(service\.status\)/);
});
