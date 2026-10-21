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
const remoteRows = new Map();
let credentials;
let cloudbaseConfig;
let currentUser = null;
let failedWrites = 0;
let failedLogin = null;
let nativeBridge = null;
const createMockApp = (config) => {
  cloudbaseConfig = config;
  return {
    auth: (options) => {
      assert.deepEqual(options, { persistence: 'local' });
      return {
        signInWithPassword: async (value) => {
          credentials = value;
          if (failedLogin) throw failedLogin;
          currentUser = { username: 'sync-user', email: 'sync@example.com' };
          return { data: { user: currentUser, session: { user: currentUser } }, error: null };
        },
        getSession: async () => ({ data: { session: currentUser ? { user: currentUser } : null }, error: null }),
        signOut: async () => { currentUser = null; return { data: {}, error: null }; }
      };
    },
    rdb: () => ({
      from: (table) => {
        assert.equal(table, 'schedule_records');
        return {
          select: () => ({
            gte: (field, value) => ({
              order: async (orderField, options) => {
                assert.equal(field, 'updated_at');
                assert.equal(orderField, 'updated_at');
                assert.deepEqual(options, { ascending: true });
                return {
                  data: [...remoteRows.values()].filter((row) => row.updated_at >= value),
                  error: null
                };
              }
            }),
            order: async (field, options) => {
              assert.equal(field, 'updated_at');
              assert.deepEqual(options, { ascending: true });
              return { data: [...remoteRows.values()], error: null };
            }
          }),
          upsert: async (record, options) => {
            if (failedWrites > 0) {
              failedWrites -= 1;
              throw new Error('network unavailable');
            }
            assert.deepEqual(options, { onConflict: 'owner_id,date,person' });
            const key = `${record.date}_${record.person}`;
            writes.push({ key, record });
            remoteRows.set(key, { ...record, updated_at: new Date(record.client_updated_at).toISOString() });
            return { data: null, error: null };
          }
        };
      }
    })
  };
};

beforeEach(() => {
  storage.clear();
  writes.length = 0;
  remoteRows.clear();
  credentials = null;
  cloudbaseConfig = null;
  currentUser = null;
  failedWrites = 0;
  failedLogin = null;
  nativeBridge = null;
  delete global.AndroidBridge;
  global.createCloudBaseApp = createMockApp;
});

require(path.join(__dirname, '..', 'cloudbase-sync.js'));

test('logs in, reads PostgreSQL schedule rows, and upserts a changed record', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  remoteRows.set('2026-10-20_军', {
    date: '2026-10-20', person: '军', off: true, client_updated_at: 123,
    updated_at: '2026-10-20T00:00:00.000Z', device_id: 'device-a'
  });
  const snapshots = [];
  sync = global.createScheduleSync({
    config: { env: 'test-env-123', region: 'ap-shanghai', accessKey: 'test-publishable-key' },
    onRecords: (records, initial) => snapshots.push({ records, initial })
  });

  await sync.connect(' sync-user ', 'not-a-real-password');
  assert.deepEqual(cloudbaseConfig, {
    env: 'test-env-123', region: 'ap-shanghai', accessKey: 'test-publishable-key', endPointMode: 'CLOUD_API'
  });
  assert.deepEqual(credentials, { username: 'sync-user', password: 'not-a-real-password' });
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-cloudbase-auth-v1')), { account: 'sync-user' });
  assert.equal('password' in JSON.parse(storage.get('daily-assistant-cloudbase-auth-v1')), false);
  assert.equal(snapshots.at(-1).records['2026-10-20_军'].off, true);
  assert.equal(snapshots.at(-1).initial, true);

  sync.writeRecord('2026-10-21_震', { date: '2026-10-21', person: '震', off: true, updatedAt: 456, deviceId: 'device-a' });
  await sync.flushPending();
  assert.deepEqual(writes.at(-1), {
    key: '2026-10-21_震',
    record: { date: '2026-10-21', person: '震', off: true, client_updated_at: 456, device_id: 'device-a' }
  });
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});

test('uses a username login and explains fetch failures as connectivity problems', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });
  await assert.rejects(sync.connect('   ', 'not-a-real-password'), /请输入 CloudBase 邮箱或用户名/);
  assert.equal(cloudbaseConfig, null);

  failedLogin = new Error('Failed to fetch');
  await assert.rejects(sync.connect('sync-user', 'not-a-real-password'), /检查手机网络/);
  assert.deepEqual(credentials, { username: 'sync-user', password: 'not-a-real-password' });
});

test('uses the official email password credential when an email is entered', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });

  await sync.connect('sync@example.com', 'not-a-real-password');

  assert.deepEqual(credentials, { email: 'sync@example.com', password: 'not-a-real-password' });
  assert.equal(sync.account(), 'sync@example.com');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-cloudbase-auth-v1')), { account: 'sync@example.com' });
});

test('uses the native CloudBase token exchange when Android exposes it', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  let sessionInput;
  nativeBridge = {
    isNativeCloudBaseLoginConfigured: () => true,
    cloudBasePasswordLogin: (username, password) => {
      assert.equal(username, 'sync-user');
      assert.equal(password, 'not-a-real-password');
      return JSON.stringify({ configured: true, ok: true, access_token: 'user-access-token', refresh_token: 'refresh-token', user_id: 'user-1' });
    }
  };
  global.AndroidBridge = nativeBridge;
  const originalCreate = global.createCloudBaseApp;
  global.createCloudBaseApp = (config) => {
    const app = originalCreate(config);
    const baseAuth = app.auth({ persistence: 'local' });
    app.auth = (options) => ({
      ...baseAuth,
      setSession: async (tokens) => {
        sessionInput = tokens;
        currentUser = { username: 'sync-user' };
        return { data: { session: { user: currentUser } }, error: null };
      }
    });
    return app;
  };
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });
  await sync.connect('sync-user', 'not-a-real-password');
  assert.deepEqual(sessionInput, { access_token: 'user-access-token', refresh_token: 'refresh-token' });
});

test('shows the CloudBase environment and provider context for rejected credentials', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  failedLogin = Object.assign(new Error('Invalid login credentials'), { code: 'invalid_credentials' });
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });

  await assert.rejects(
    sync.connect('sync-user', 'not-a-real-password'),
    /CloudBase 已拒绝用户名登录：Invalid login credentials \[invalid_credentials\].*test-env-123.*腾讯云控制台账号不能直接登录/
  );
});

test('resumes a saved session and queues local rows until the first PostgreSQL read', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  currentUser = { username: 'sync-user', email: 'sync@example.com' };
  storage.set('daily-assistant-cloudbase-auth-v1', JSON.stringify({ account: 'sync-user' }));
  storage.set('daily-assistant-sync-pending-v1', JSON.stringify({
    '2026-10-22_军': { date: '2026-10-22', person: '军', off: true, updatedAt: 800, deviceId: 'device-a' }
  }));
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });

  await sync.resume();
  await sync.flushPending();
  assert.equal(sync.account(), 'sync-user');
  assert.equal(writes.at(-1).key, '2026-10-22_军');
  assert.equal(JSON.parse(storage.get('daily-assistant-sync-pending-v1'))['2026-10-22_军'], undefined);
});

test('keeps and uploads a newer pending record when the initial PostgreSQL snapshot is empty', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  currentUser = { username: 'sync-user', email: 'sync@example.com' };
  storage.set('daily-assistant-sync-pending-v1', JSON.stringify({
    '2026-10-22_军': { date: '2026-10-22', person: '军', off: true, updatedAt: 800, deviceId: 'device-a' }
  }));
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });

  await sync.resume();
  await sync.flushPending();
  assert.equal(writes.at(-1).key, '2026-10-22_军');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});

test('pulls another device update on the next refresh', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  const snapshots = [];
  sync = global.createScheduleSync({
    config: { env: 'test-env-123', accessKey: 'test-publishable-key' },
    onRecords: (records, initial) => snapshots.push({ records, initial })
  });
  await sync.connect('sync-user', 'not-a-real-password');
  remoteRows.set('2026-10-23_震', {
    date: '2026-10-23', person: '震', off: true, client_updated_at: 900,
    updated_at: new Date().toISOString(), device_id: 'device-b'
  });

  await sync.refresh();
  assert.equal(snapshots.at(-1).records['2026-10-23_震'].off, true);
  assert.equal(snapshots.at(-1).records['2026-10-23_震'].deviceId, 'device-b');
  assert.equal(snapshots.at(-1).initial, false);
});

test('retains queued records after an upsert failure and retries after a later refresh', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = global.createScheduleSync({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });
  await sync.connect('sync-user', 'not-a-real-password');
  failedWrites = 1;
  sync.writeRecord('2026-10-24_震', { date: '2026-10-24', person: '震', off: true, updatedAt: 1000, deviceId: 'device-a' });
  await sync.flushPending();
  assert.equal(JSON.parse(storage.get('daily-assistant-sync-pending-v1'))['2026-10-24_震'].off, true);

  await sync.refresh();
  await sync.flushPending();
  assert.equal(writes.at(-1).key, '2026-10-24_震');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});
