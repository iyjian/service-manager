const test = require('node:test');
const assert = require('node:assert/strict');
const { NotesUploadSchedule } = require('../dist/main/s3/notesUploadSchedule');

test('idle upload resets with editing but continuous edits cannot exceed five minutes', () => {
  const schedule = new NotesUploadSchedule();
  assert.equal(schedule.delay(0), undefined);
  schedule.changed(0);
  assert.equal(schedule.delay(0), 30_000);
  schedule.changed(20_000);
  assert.equal(schedule.delay(20_000), 30_000);
  for (let time = 40_000; time <= 280_000; time += 20_000) schedule.changed(time);
  assert.equal(schedule.delay(280_000), 20_000);
  assert.equal(schedule.delay(300_000), 0);
});

test('successful upload resets the deadline and retains edits made during upload', () => {
  const schedule = new NotesUploadSchedule();
  schedule.changed(0);
  schedule.changed(40_000);
  schedule.succeeded(45_000, true);
  assert.equal(schedule.delay(45_000), 25_000);
  schedule.succeeded(70_000, false);
  assert.equal(schedule.delay(70_000), undefined);
  schedule.changed(360_000);
  assert.equal(schedule.delay(360_000), 10_000);
});

test('failure backoff grows to fifteen minutes, is not bypassed by typing, and resets after success', () => {
  const schedule = new NotesUploadSchedule();
  let now = 0;
  for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    schedule.failed(now);
    schedule.changed(now + 1000);
    assert.equal(schedule.canExpedite(now + 1000), false);
    assert.ok(schedule.delay(now + 1000) >= delay - 1000);
    now += delay;
    assert.equal(schedule.canExpedite(now), true);
  }
  schedule.succeeded(now, false);
  schedule.changed(now);
  schedule.failed(now);
  assert.equal(schedule.delay(now), 30_000);
});
