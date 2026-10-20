const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};

const streams = [];
class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; streams.push(this); }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  close() { this.closed = true; }
  emit(type, data) { this.listeners[type]?.({ data: JSON.stringify(data) }); }
}
global.EventSource = FakeEventSource;

const requests = [];
global.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  if (String(url).includes('accounts:signInWithPassword')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ email: 'sync@example.com', idToken: 'test-id-token', refreshToken: 'test-refresh-token', expiresIn: '3600' }) };
  }
  return { ok: true, status: 200, text: async () => 'null' };
};

require(path.join(__dirname, '..', 'firebase-sync.js'));

test('signs in, receives the live snapshot, and writes only the changed schedule record', async (t) => {
  let sync;
  t.after(() => {
    sync?.disconnect();
    global.EventSource = undefined;
    global.fetch = undefined;
    global.localStorage = undefined;
  });
  const snapshots = [];
  sync = global.createScheduleSync({
    config: { apiKey: 'public-test-key', databaseURL: 'https://example-default-rtdb.firebaseio.com' },
    onRecords: (records) => snapshots.push(records)
  });

  await sync.connect('sync@example.com', 'not-a-real-password');
  assert.equal(streams.at(-1).url.includes('test-id-token'), true);
  const savedAuth = JSON.parse(storage.get('daily-assistant-sync-auth-v1'));
  assert.equal(savedAuth.refreshToken, 'test-refresh-token');
  assert.equal('password' in savedAuth, false);

  streams.at(-1).emit('put', {
    path: '/',
    data: { '2026-10-20_军': { date: '2026-10-20', person: '军', off: true, updatedAt: 123, deviceId: 'device-a' } }
  });
  assert.equal(snapshots.at(-1)['2026-10-20_军'].off, true);

  sync.writeRecord('2026-10-21_震', { date: '2026-10-21', person: '震', off: true, updatedAt: 456, deviceId: 'device-a' });
  await sync.flushPending();
  const write = requests.find((request) => request.options.method === 'PUT');
  assert.match(write.url, /daily-assistant\/scheduleRecords\/2026-10-21_%E9%9C%87\.json/);
  assert.deepEqual(JSON.parse(write.options.body), { date: '2026-10-21', person: '震', off: true, updatedAt: 456, deviceId: 'device-a' });
  sync.disconnect();
});
