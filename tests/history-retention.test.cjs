const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cleanup } = require('../history-retention.js');

test('removes completed tasks and memos after one calendar month', () => {
  const now = new Date(2026, 9, 20, 12, 0, 0);
  const result = cleanup([
    { id: 'old-complete', completed: true, completedAt: '2026-09-19T12:00:00' },
    { id: 'recent-complete', completed: true, completedAt: '2026-09-21T12:00:00' }
  ], [
    { id: 'old-note', updatedAt: '2026-09-19T12:00:00' },
    { id: 'recent-note', createdAt: '2026-08-01T12:00:00', updatedAt: '2026-09-21T12:00:00' }
  ], now);

  assert.deepEqual(result.expiredTaskIds, ['old-complete']);
  assert.deepEqual(result.tasks.map((task) => task.id), ['recent-complete']);
  assert.deepEqual(result.notes.map((note) => note.id), ['recent-note']);
});

test('cleans old overdue tasks but retains active undated tasks', () => {
  const now = new Date(2026, 9, 20, 12, 0, 0);
  const result = cleanup([
    { id: 'old-overdue', completed: false, dueDate: '2026-09-19', dueTime: '10:00' },
    { id: 'new-overdue', completed: false, dueDate: '2026-10-19', dueTime: '10:00' },
    { id: 'undated', completed: false, createdAt: '2020-01-01T00:00:00' }
  ], [], now);

  assert.deepEqual(result.expiredTaskIds, ['old-overdue']);
  assert.deepEqual(result.tasks.map((task) => task.id), ['new-overdue', 'undated']);
});

test('clamps the one-month cutoff at month ends', () => {
  const now = new Date(2026, 9, 31, 12, 0, 0);
  const result = cleanup([
    { id: 'expired', completed: true, completedAt: '2026-09-29T12:00:00' },
    { id: 'boundary', completed: true, completedAt: '2026-09-30T12:00:00' }
  ], [], now);

  assert.deepEqual(result.expiredTaskIds, ['expired']);
  assert.deepEqual(result.tasks.map((task) => task.id), ['boundary']);
});
