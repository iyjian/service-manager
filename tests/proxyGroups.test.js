const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  findManualProxyOption,
  listManualProxyGroups,
  normalizeSavedProxySelections,
  validSavedProxySelections,
} = require('../dist/main/proxy/proxyGroups.js');

const RECORDS = {
  GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['节点选择'] },
  '节点选择': { name: '节点选择', type: 'Selector', now: 'HK-01', all: ['HK-01', 'US-01', 'DIRECT'] },
  '全球直连': { name: '全球直连', type: 'Selector', now: 'DIRECT', all: ['DIRECT', '节点选择'] },
  '自动选择': { name: '自动选择', type: 'URLTest', now: 'HK-01', all: ['HK-01', 'US-01'] },
  'HK-01': { name: 'HK-01', type: 'Shadowsocks', history: [{ time: 'now', delay: 42 }] },
  'US-01': { name: 'US-01', type: 'Shadowsocks', history: [{ time: 'now', delay: 0 }] },
  DIRECT: { name: 'DIRECT', type: 'Direct' },
};

test('listManualProxyGroups returns only selectable Selector groups with all runtime candidates', () => {
  assert.deepEqual(listManualProxyGroups(RECORDS), {
    groups: [
      {
        name: '节点选择',
        now: 'HK-01',
        options: [
          { name: 'HK-01', type: 'Shadowsocks', delayMs: 42 },
          { name: 'US-01', type: 'Shadowsocks' },
          { name: 'DIRECT', type: 'Direct' },
        ],
      },
      {
        name: '全球直连',
        now: 'DIRECT',
        options: [
          { name: 'DIRECT', type: 'Direct' },
          { name: '节点选择', type: 'Selector' },
        ],
      },
    ],
  });
});

test('findManualProxyOption accepts only candidates exposed by a Selector group', () => {
  assert.equal(findManualProxyOption(RECORDS, '全球直连', 'DIRECT')?.name, 'DIRECT');
  assert.equal(findManualProxyOption(RECORDS, '全球直连', 'HK-01'), undefined);
  assert.equal(findManualProxyOption(RECORDS, '自动选择', 'HK-01'), undefined);
});

test('normalizeSavedProxySelections migrates a legacy primary-group selection without replacing a newer value', () => {
  assert.deepEqual(normalizeSavedProxySelections(undefined, 'HK-01', '节点选择'), { '节点选择': 'HK-01' });
  assert.deepEqual(normalizeSavedProxySelections({ '节点选择': 'US-01' }, 'HK-01', '节点选择'), {
    '节点选择': 'US-01',
  });
});

test('validSavedProxySelections skips candidates and groups removed by a subscription refresh', () => {
  assert.deepEqual(
    validSavedProxySelections(RECORDS, {
      '节点选择': 'HK-01',
      '全球直连': 'DIRECT',
      '自动选择': 'HK-01',
      '已删除策略': 'US-01',
    }),
    [
      ['节点选择', 'HK-01'],
      ['全球直连', 'DIRECT'],
    ]
  );
});

test('project documentation describes selectable subscription strategy groups', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

  assert.match(readme, /Strategy Groups/);
  assert.match(readme, /Selector/);
  assert.match(agents, /selectedProxies/);
  assert.match(agents, /Selector/);
});

test('project documentation describes durable proxy cache, custom rules, and Proxy page constraints', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const directExceptionTypes = [
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'IP-CIDR',
    'IP-CIDR6',
    'SRC-IP-CIDR',
    'GEOIP',
    'DST-PORT',
    'SRC-PORT',
  ];

  for (const document of [readme, agents]) {
    assert.match(document, /subscription\.yaml/);
    assert.match(document, /subscription\.parsed\.json/);
    assert.match(document, /only.*Save & Fetch.*fetches.*replaces.*cache/i);
    assert.match(document, /parsed cache.*first/i);
    assert.match(document, /(?:fallback|fall(?:s)? back).*source YAML/i);
    assert.match(document, /Custom Rules/i);
    assert.match(document, /Type, Target \(`PROXY` \/ `DIRECT`\), and Value/);
    assert.match(document, /`PROXY`[\s\S]{0,120}primary selector/i);
    assert.match(document, /app-created primary selector[\s\S]{0,120}synthesized/i);
    assert.match(document, /skips if no selector exists/i);
    assert.match(document, /Custom Rules[\s\S]{0,120}before[\s\S]{0,120}(?:subscription|synthesized) rules/i);
    assert.match(document, /legacy Direct Exceptions[\s\S]{0,120}migrate[\s\S]{0,120}`DIRECT` custom rules/i);
    assert.match(document, /subsequent settings writes[\s\S]{0,120}`customRules`/i);
    assert.match(document, /top-right[\s\S]{0,120}manually dismissible[\s\S]{0,120}ten seconds/i);
    assert.match(document, /Mixed Port[\s\S]{0,160}before starting/i);
    assert.match(document, /(?:starting|running|stopping)[\s\S]{0,160}(?:cannot|not).*change/i);
    assert.match(document, /127\.0\.0\.1:[^\s`]*port[\s\S]{0,160}occupied/i);
    assert.match(document, /occupied[\s\S]{0,160}(?:does not start|without starting)[\s\S]{0,160}(?:does not overwrite|without overwriting)/i);
    assert.match(document, /successful Start[\s\S]{0,160}persist/i);
    assert.doesNotMatch(document, /port-change restart/i);
    assert.doesNotMatch(document, /port-change[\s\S]{0,120}reactivat/i);
    assert.match(document, /DIRECT/);
    assert.match(document, /before.*subscription.*rules/i);
    assert.match(document, /persist/i);
    for (const type of directExceptionTypes) {
      assert.match(document, new RegExp(`\\b${type}\\b`));
    }
  }

  assert.match(readme, /subscriptionCache\.ts/);
  assert.match(readme, /proxyExceptions\.ts/);
  assert.match(agents, /text-safe custom-rule rendering/i);
  assert.match(agents, /white Proxy content container/i);
  assert.match(agents, /no-duplicate-Host-logo/i);
});

test('project documentation describes one-time Save & Fetch subscription application', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

  for (const document of [readme, agents]) {
    assert.match(document, /Save & Fetch/);
    assert.match(document, /one-time/i);
    assert.match(document, /subscription\.yaml/);
    assert.match(document, /subscription\.parsed\.json/);
    assert.match(
      document,
      /(?:running (?:proxy|core)|(?:proxy|core) (?:is )?(?:already )?running)[\s\S]{0,160}manual(?:ly)?[\s\S]{0,80}(?:restart|stop[\s\S]{0,40}start)|manual(?:ly)?[\s\S]{0,160}(?:restart|stop[\s\S]{0,40}start)[\s\S]{0,160}(?:running (?:proxy|core)|(?:proxy|core) (?:is )?(?:already )?running)/i
    );
    assert.doesNotMatch(document, /Proxy(?: page)?\s+`?Update`?\s+(?:action|button)/i);
  }
});

test('project documentation describes Host-page local app memory totals', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');

  for (const document of [readme, agents]) {
    assert.match(document, /Memory/);
    assert.match(document, /app\.getAppMetrics\(\)/);
    assert.match(document, /Mihomo/);
    assert.match(document, /five seconds/i);
    assert.match(document, /remote SSH services are excluded/i);
  }

  assert.match(readme, /appMemory\.ts/);
  assert.match(agents, /appMemory\.ts/);
});

test('Proxy toggle routes starting state to Stop', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src/renderer/proxyPage.ts'), 'utf8');

  assert.match(
    source,
    /state\.running === 'running'\s*\|\|\s*state\.running === 'starting'[\s\S]{0,180}stopProxy\(\)/
  );
});
