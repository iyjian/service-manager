const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compareKubernetesSortValues,
  mergeResourcePage,
  projectLoadedResourceItems,
  projectVirtualWindow,
  resourceQueryKey,
  sanitizeSecretForCache,
} = require('../dist/main/kubernetes/resourceQuery');

const POD_QUERY = {
  context: 'production',
  kind: 'pods',
  namespaceScope: { mode: 'selected', namespaces: ['default', 'apps'] },
  labelSelector: 'app=web',
  fieldSelector: 'status.phase=Running',
};

function summary(uid, resourceVersion, name = uid) {
  return {
    uid,
    name,
    resourceVersion,
    columns: {},
  };
}

test('resourceQueryKey canonicalizes namespace scopes without treating view controls as queries', () => {
  const canonical = resourceQueryKey(POD_QUERY);
  assert.equal(
    resourceQueryKey({
      ...POD_QUERY,
      namespaceScope: { mode: 'selected', namespaces: [' apps ', 'default', 'apps'] },
      nameFilter: 'api',
      sort: { column: 'name', direction: 'desc' },
    }),
    canonical
  );
  assert.equal(
    resourceQueryKey({ ...POD_QUERY, namespaceScope: { mode: 'all', namespaces: ['ignored'] } }),
    resourceQueryKey({ ...POD_QUERY, namespaceScope: { mode: 'all', namespaces: [] } })
  );
  assert.notEqual(resourceQueryKey({ ...POD_QUERY, labelSelector: 'app=worker' }), canonical);
});

test('resourceQueryKey treats cluster-scoped kinds as All Namespaces', () => {
  const selectedScope = { mode: 'selected', namespaces: ['apps'] };
  const allScope = { mode: 'all', namespaces: [] };

  for (const kind of ['nodes', 'namespaces']) {
    assert.equal(
      resourceQueryKey({ ...POD_QUERY, kind, namespaceScope: selectedScope }),
      resourceQueryKey({ ...POD_QUERY, kind, namespaceScope: allScope })
    );
  }

  const customResource = {
    ...POD_QUERY,
    kind: 'custom-resources',
    apiVersion: 'example.test/v1',
    plural: 'widgets',
  };

  assert.equal(
    resourceQueryKey({ ...customResource, scope: 'cluster', namespaceScope: selectedScope }),
    resourceQueryKey({ ...customResource, scope: 'cluster', namespaceScope: allScope })
  );
  assert.notEqual(
    resourceQueryKey({ ...customResource, scope: 'namespaced', namespaceScope: selectedScope }),
    resourceQueryKey({ ...customResource, scope: 'namespaced', namespaceScope: allScope })
  );
  assert.notEqual(
    resourceQueryKey({ ...customResource, scope: 'cluster', namespaceScope: allScope }),
    resourceQueryKey({ ...customResource, scope: 'namespaced', namespaceScope: allScope })
  );
});

test('mergeResourcePage replaces matching UIDs and preserves first-seen order', () => {
  const current = [summary('a', '1'), summary('b', '1')];
  const incoming = [summary('b', '2', 'b-new'), summary('c', '1')];

  assert.deepEqual(mergeResourcePage(current, incoming), [
    summary('a', '1'),
    summary('b', '2', 'b-new'),
    summary('c', '1'),
  ]);
  assert.deepEqual(current, [summary('a', '1'), summary('b', '1')]);
});

test('projectLoadedResourceItems sorts Age by the visible duration semantics', () => {
  const oldest = { ...summary('oldest', '1'), createdAt: '2026-07-10T00:00:00.000Z' };
  const newest = { ...summary('newest', '1'), createdAt: '2026-07-12T00:00:00.000Z' };
  const items = [oldest, newest];

  assert.deepEqual(
    projectLoadedResourceItems(items, { ...POD_QUERY, sort: { column: 'age', direction: 'asc' } })
      .map((item) => item.name),
    ['newest', 'oldest']
  );
  assert.deepEqual(
    projectLoadedResourceItems(items, { ...POD_QUERY, sort: { column: 'age', direction: 'desc' } })
      .map((item) => item.name),
    ['oldest', 'newest']
  );
  assert.deepEqual(items, [oldest, newest]);
});

test('resource-specific count and readiness columns sort numerically', () => {
  assert.ok(compareKubernetesSortValues('data', '2', '10') < 0);
  assert.ok(compareKubernetesSortValues('generation', '10', '2') > 0);
  assert.ok(compareKubernetesSortValues('ready', '2/10', '10/10') < 0);

  const items = [
    { ...summary('ten', '1'), columns: { data: '10' } },
    { ...summary('two', '1'), columns: { data: '2' } },
  ];
  assert.deepEqual(
    projectLoadedResourceItems(items, { ...POD_QUERY, sort: { column: 'data', direction: 'asc' } })
      .map((item) => item.name),
    ['two', 'ten'],
  );
});

test('projectVirtualWindow renders only a bounded slice of 10,000 rows', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => index);
  const window = projectVirtualWindow(rows, 8_000, 32, 640, 8);

  assert.equal(window.totalHeight, 320_000);
  assert.ok(window.items.length <= 36);
  assert.equal(window.items[0], 242);
  assert.equal(window.offsetTop, 7_744);
});

test('projectVirtualWindow clamps scroll offsets at both ends', () => {
  const rows = Array.from({ length: 10 }, (_, index) => index);
  assert.deepEqual(projectVirtualWindow(rows, -100, 10, 20, 1).items, [0, 1, 2]);
  assert.deepEqual(projectVirtualWindow(rows, 100_000, 10, 20, 1).items, [7, 8, 9]);
});

test('sanitizeSecretForCache makes a new object and strips data fields recursively', () => {
  const input = {
    metadata: { name: 'db', nested: { data: { should: 'not survive' }, annotations: { team: 'core' } } },
    data: { password: 'c2VjcmV0' },
    stringData: { password: 'secret' },
    template: [{ stringData: { ignored: true }, metadata: { name: 'child' } }],
  };

  assert.deepEqual(sanitizeSecretForCache(input), {
    metadata: { name: 'db', nested: { annotations: { team: 'core' } } },
    template: [{ metadata: { name: 'child' } }],
  });
  assert.notEqual(sanitizeSecretForCache(input), input);
  assert.deepEqual(input.data, { password: 'c2VjcmV0' });
});
