const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadProxyGroupView() {
  return import(pathToFileURL(
    path.join(__dirname, '..', 'dist', 'renderer', 'models', 'proxyGroupView.js'),
  ).href);
}

function groupData(overrides = {}) {
  return {
    groups: [{
      name: 'PROXY',
      now: 'Node A',
      options: [
        { name: 'Node A', type: 'ss', delayMs: 21 },
        { name: 'Node B', type: 'vmess' },
      ],
    }],
    ...overrides,
  };
}

test('proxy group selection and delay changes retain the existing DOM structure', async () => {
  const { haveSameProxyGroupStructure } = await loadProxyGroupView();
  const previous = groupData();
  const next = groupData({
    groups: [{
      name: 'PROXY',
      now: 'Node B',
      options: [
        { name: 'Node A', type: 'ss', delayStatus: 'unavailable' },
        { name: 'Node B', type: 'vmess', delayMs: 48 },
      ],
    }],
  });

  assert.equal(haveSameProxyGroupStructure(previous, next), true);
});

test('proxy group node, order, and type changes require a structural rebuild', async () => {
  const { haveSameProxyGroupStructure } = await loadProxyGroupView();
  const previous = groupData();

  assert.equal(haveSameProxyGroupStructure(previous, groupData({
    groups: [{
      name: 'PROXY',
      options: [
        { name: 'Node B', type: 'vmess' },
        { name: 'Node A', type: 'ss' },
      ],
    }],
  })), false);
  assert.equal(haveSameProxyGroupStructure(previous, groupData({
    groups: [{
      name: 'PROXY',
      options: [
        { name: 'Node A', type: 'trojan' },
        { name: 'Node B', type: 'vmess' },
      ],
    }],
  })), false);
});

test('unchanged custom rules do not require rebuilding their rows', async () => {
  const { haveSameProxyCustomRules } = await loadProxyGroupView();
  const previous = [{
    id: 'rule-1',
    type: 'DOMAIN-SUFFIX',
    target: 'PROXY',
    value: 'example.com',
  }];

  assert.equal(haveSameProxyCustomRules(previous, previous.map((rule) => ({ ...rule }))), true);
  assert.equal(haveSameProxyCustomRules(previous, [{ ...previous[0], target: 'DIRECT' }]), false);
});
