const assert = require('node:assert/strict');
const test = require('node:test');

const { extractTrafficRecords } = require('../dist/main/proxy/trafficStream.js');

test('extractTrafficRecords frames sequential Mihomo traffic JSON records across chunks', () => {
  const first = extractTrafficRecords('{"up":12,"down":34,"upTotal":56');
  assert.deepEqual(first.records, []);

  const second = extractTrafficRecords(
    `${first.remainder},"downTotal":78}{"up":90,"down":12,"upTotal":146,"downTotal":90}`
  );
  assert.deepEqual(second.records, [
    { upBytesPerSecond: 12, downBytesPerSecond: 34 },
    { upBytesPerSecond: 90, downBytesPerSecond: 12 },
  ]);
  assert.equal(second.remainder, '');
});

test('extractTrafficRecords ignores malformed or negative traffic records', () => {
  const parsed = extractTrafficRecords('{"up":-1,"down":2}{"up":1,"down":"bad"}{"up":3,"down":4}');

  assert.deepEqual(parsed.records, [{ upBytesPerSecond: 3, downBytesPerSecond: 4 }]);
});

test('extractTrafficRecords does not split braces contained in JSON strings', () => {
  const parsed = extractTrafficRecords('{"up":5,"down":6,"note":"brace } and escaped quote \\" stay in record"}');

  assert.deepEqual(parsed.records, [{ upBytesPerSecond: 5, downBytesPerSecond: 6 }]);
  assert.equal(parsed.remainder, '');
});
