const assert = require('node:assert/strict');
const path = require('node:path');
const { beforeEach, test } = require('node:test');

const storage = new Map();
global.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key)
};

const writes = [];
let watchOptions;
let closed = false;
let credentials;
let cloudbaseConfig;
let currentUser = null;
let failedWrites = 0;
const createMockApp = (config) => {
  cloudbaseConfig = config;
  return {
    auth: (options) => {
      assert.deepEqual(options, { persistence: 'local' });
      return {
        signInWithPassword: async (value) => {
          credentials = value;
          currentUser = { username: 'sync-user', email: 'sync@example.com' };
          return { data: { user: currentUser }, error: null };
        },
        getUser: async () => ({ data: { user: currentUser }, error: null }),
        signOut: async () => { currentUser = null; return { data: {}, error: null }; }
      };
    },
    database: () => ({
      collection: (name) => {
        assert.equal(name, 'scheduleRecords');
        return {
          watch: (options) => {
            watchOptions = options;
            return { close: () => { closed = true; } };
          },
          doc: (id) => ({ set: async ({ data }) => {
            if (failedWrites > 0) {
              failedWrites -= 1;
              throw new Error('network unavailable');
            }
            writes.push({ id, data });
            return { data: {}, error: null };
          } })
        };
      }
    })
  };
};

beforeEach(() => {
  storage.clear();
  writes.length = 0;
  watchOptions = null;
  closed = false;
  credentials = null;
  cloudbaseConfig = null;
  currentUser = null;
  failedWrites = 0;
  global.createCloudBaseApp = createMockApp;
});

require(path.join(__dirname, '..', 'cloudbase-sync.js'));

test('logs in, merges live schedule records, and writes one changed record', async (t) => {
  let sync;
  t.after(() => {
    sync?.disconnect();
  });
  const snapshots = [];
  sync = global.createScheduleSync({
    config: { env: 'test-env-123', region: 'ap-shanghai' },
    onRecords: (records, initial) => snapshots.push({ records, initial })
  });

  await sync.connect('sync@example.com', 'not-a-real-password');
  assert.deepEqual(cloudbaseConfig, { env: 'test-env-123', region: 'ap-shanghai' });
  assert.deepEqual(credentials, { email: 'sync@example.com', password: 'not-a-real-password' });
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-cloudbase-auth-v1')), { account: 'sync-user' });
  assert.equal('password' in JSON.parse(storage.get('daily-assistant-cloudbase-auth-v1')), false);

  watchOptions.onChange({ docs: {
    '2026-10-20_军': { _id: '2026-10-20_军', date: '2026-10-20', person: '军', off: true, updatedAt: 123, deviceId: 'device-a' }
  } });
  assert.equal(snapshots.at(-1).records['2026-10-20_军'].off, true);
  assert.equal(snapshots.at(-1).initial, true);

  sync.writeRecord('2026-10-21_震', { date: '2026-10-21', person: '震', off: true, updatedAt: 456, deviceId: 'device-a' });
  await sync.flushPending();
  assert.deepEqual(writes.at(-1), {
    id: '2026-10-21_震',
    data: { date: '2026-10-21', person: '震', off: true, updatedAt: 456, deviceId: 'device-a' }
  });
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
  await sync.disconnect();
  assert.equal(closed, true);
});

test('resumes a saved account session and keeps queued records until the initial snapshot', async (t) => {
  let sync;
  t.after(() => {
    sync?.disconnect();
  });
  currentUser = { username: 'sync-user', email: 'sync@example.com' };
  storage.set('daily-assistant-cloudbase-auth-v1', JSON.stringify({ account: 'sync-user' }));
  storage.set('daily-assistant-sync-pending-v1', JSON.stringify({
    '2026-10-22_军': { date: '2026-10-22', person: '军', off: true, updatedAt: 800, deviceId: 'device-a' }
  }));
  sync = global.createScheduleSync({ config: { env: 'test-env-123' } });

  await sync.resume();
  watchOptions.onChange({ docs: {} });
  await sync.flushPending();
  assert.equal(writes.at(-1).id, '2026-10-22_军');
  assert.equal(JSON.parse(storage.get('daily-assistant-sync-pending-v1'))['2026-10-22_军'], undefined);
});

test('retries queued records after a later live snapshot restores connectivity', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = global.createScheduleSync({ config: { env: 'test-env-123' } });
  await sync.connect('sync@example.com', 'not-a-real-password');
  watchOptions.onChange({ docs: {} });
  failedWrites = 1;
  sync.writeRecord('2026-10-23_震', { date: '2026-10-23', person: '震', off: true, updatedAt: 900, deviceId: 'device-a' });
  await sync.flushPending();
  assert.equal(JSON.parse(storage.get('daily-assistant-sync-pending-v1'))['2026-10-23_震'].off, true);

  watchOptions.onChange({ docs: {} });
  await sync.flushPending();
  assert.equal(writes.at(-1).id, '2026-10-23_震');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});
