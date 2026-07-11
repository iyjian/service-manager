const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findManualProxyOption,
  listManualProxyGroups,
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
