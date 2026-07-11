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

test('project documentation describes durable proxy cache, direct exceptions, and Proxy page constraints', () => {
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
    assert.match(document, /ProxySettings\.exceptions/);
    assert.match(document, /DIRECT/);
    assert.match(document, /before.*subscription.*rules/i);
    assert.match(document, /persist/i);
    for (const type of directExceptionTypes) {
      assert.match(document, new RegExp(`\\b${type}\\b`));
    }
  }

  assert.match(readme, /subscriptionCache\.ts/);
  assert.match(readme, /proxyExceptions\.ts/);
  assert.match(agents, /text-safe exception rendering/i);
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
