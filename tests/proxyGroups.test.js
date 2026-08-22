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

test('listManualProxyGroups overlays the transient delay test result without treating unavailable as zero milliseconds', () => {
  const delayResults = new Map([
    ['HK-01', { delayMs: 17, status: 'ready' }],
    ['US-01', { status: 'unavailable' }],
  ]);

  assert.deepEqual(listManualProxyGroups(RECORDS, delayResults).groups[0].options, [
    { name: 'HK-01', type: 'Shadowsocks', delayMs: 17, delayStatus: 'ready' },
    { name: 'US-01', type: 'Shadowsocks', delayStatus: 'unavailable' },
    { name: 'DIRECT', type: 'Direct' },
  ]);
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

test('Proxy toggle routes starting state to Stop', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src/renderer/proxyPage.ts'), 'utf8');

  assert.match(
    source,
    /state\.running === 'running'\s*\|\|\s*state\.running === 'starting'[\s\S]{0,180}stopProxy\(\)/
  );
});
