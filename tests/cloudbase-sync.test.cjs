const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { beforeEach, test } = require('node:test');

let storage;
const remoteRows = new Map();
const writes = [];
let cloudbaseConfig;
let failedReads = 0;
let failedWrites = 0;
let access = 'anon';

const createMockApp = (config) => {
  cloudbaseConfig = config;
  return {
    rdb: () => ({
      from: (table) => {
        assert.equal(table, 'schedule_records');
        const filters = [];
        let updatedAfter = null;
        const query = {
          eq: (field, value) => {
            filters.push([field, value]);
            return query;
          },
          gte: (field, value) => {
            assert.equal(field, 'updated_at');
            updatedAfter = value;
            return query;
          },
          order: async (field, options) => {
            assert.equal(field, 'updated_at');
            assert.equal(options.ascending, true);
            if (failedReads > 0) {
              failedReads -= 1;
              throw new Error('read denied');
            }
            return {
              data: [...remoteRows.values()]
                .filter((row) => filters.every(([name, value]) => row[name] === value))
                .filter((row) => !updatedAfter || row.updated_at >= updatedAfter),
              error: null
            };
          }
        };
        return {
          select: () => query,
          upsert: async (record, options) => {
            assert.equal(access, 'anon');
            if (failedWrites > 0) {
              failedWrites -= 1;
              throw new Error('network unavailable');
            }
            assert.equal(options.onConflict, 'owner_id,date,person');
            const key = `${record.owner_id}_${record.date}_${record.person}`;
            const row = { ...record, updated_at: new Date(record.client_updated_at).toISOString() };
            writes.push({ key, record });
            remoteRows.set(key, row);
            return { data: null, error: null };
          }
        };
      }
    })
  };
};

beforeEach(() => {
  storage = new Map();
  writes.length = 0;
  remoteRows.clear();
  cloudbaseConfig = null;
  failedReads = 0;
  failedWrites = 0;
  access = 'anon';
});

const syncSource = fs.readFileSync(path.join(__dirname, '..', 'cloudbase-sync.js'), 'utf8');
function createDevice(options, deviceStorage = storage) {
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => deviceStorage.get(key) ?? null,
      setItem: (key, value) => deviceStorage.set(key, String(value)),
      removeItem: (key) => deviceStorage.delete(key)
    },
    createCloudBaseApp: createMockApp,
    setInterval, clearInterval
  });
  vm.runInContext(syncSource, context);
  return context.createScheduleSync(options);
}

test('automatically connects as anonymous and reads the shared schedule without auth APIs', async (t) => {
  let sync;
  const snapshots = [];
  remoteRows.set('daily-assistant-internal-shared_2026-10-20_军', {
    owner_id: 'daily-assistant-internal-shared',
    date: '2026-10-20', person: '军', off: true, client_updated_at: 123,
    updated_at: new Date(123).toISOString(), device_id: 'device-a'
  });
  t.after(() => sync?.disconnect());
  sync = createDevice({
    config: { env: 'test-env-123', region: 'ap-shanghai', accessKey: 'test-publishable-key' },
    onRecords: (records, initial) => snapshots.push({ records, initial })
  });

  await sync.resume();

  assert.deepEqual(JSON.parse(JSON.stringify(cloudbaseConfig)), {
    env: 'test-env-123', region: 'ap-shanghai', accessKey: 'test-publishable-key', persistence: 'none', endPointMode: 'CLOUD_API'
  });
  assert.equal(typeof createMockApp(cloudbaseConfig).auth, 'undefined');
  assert.equal(snapshots.at(-1).records['2026-10-20_军'].off, true);
  assert.equal(snapshots.at(-1).initial, true);
  assert.match(sync.status(), /共享排班已连接/);
});

test('two devices read and write the same shared rows without logging in', async (t) => {
  const deviceStorageA = new Map();
  const deviceStorageB = new Map();
  const snapshotsA = [];
  const snapshotsB = [];
  let syncA;
  let syncB;
  t.after(async () => {
    await syncA?.disconnect();
    await syncB?.disconnect();
  });

  syncA = createDevice({
    config: { env: 'test-env-123', accessKey: 'test-publishable-key' },
    onRecords: (records) => snapshotsA.push(records)
  }, deviceStorageA);
  await syncA.resume();

  syncB = createDevice({
    config: { env: 'test-env-123', accessKey: 'test-publishable-key' },
    onRecords: (records) => snapshotsB.push(records)
  }, deviceStorageB);
  await syncB.resume();

  syncA.writeRecord('2026-10-22_震', {
    date: '2026-10-22', person: '震', off: true, updatedAt: 456, deviceId: syncA.deviceId()
  });
  await syncA.flushPending();
  await syncB.refresh();

  assert.equal(snapshotsB.at(-1)['2026-10-22_震'].off, true);
  assert.notEqual(syncA.deviceId(), syncB.deviceId());
  assert.equal([...remoteRows.values()].length, 1);
  assert.equal([...remoteRows.values()][0].owner_id, 'daily-assistant-internal-shared');
  assert.equal(writes.at(-1).record.device_id, syncA.deviceId());
  assert.equal(deviceStorageA.get('daily-assistant-sync-device-v1'), syncA.deviceId());
  assert.equal(deviceStorageB.get('daily-assistant-sync-device-v1'), syncB.deviceId());
  assert.deepEqual(JSON.parse(deviceStorageA.get('daily-assistant-sync-pending-v1')), {});
  assert.equal(deviceStorageA.has('daily-assistant-cloudbase-auth-v1'), false);
  assert.equal(deviceStorageB.has('daily-assistant-cloudbase-auth-v1'), false);
});

test('queues an unsynced local schedule before its first anonymous database read', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  storage.set('daily-assistant-sync-pending-v1', JSON.stringify({
    '2026-10-22_军': { date: '2026-10-22', person: '军', off: true, updatedAt: 800, deviceId: 'device-a' }
  }));
  sync = createDevice({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });

  await sync.resume();
  await sync.flushPending();

  assert.equal(writes.at(-1).record.owner_id, 'daily-assistant-internal-shared');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});

test('pulls remote changes on the next refresh and applies them to the calendar callback', async (t) => {
  let sync;
  const snapshots = [];
  t.after(() => sync?.disconnect());
  sync = createDevice({
    config: { env: 'test-env-123', accessKey: 'test-publishable-key' },
    onRecords: (records, initial) => snapshots.push({ records, initial })
  });
  await sync.resume();
  remoteRows.set('daily-assistant-internal-shared_2026-10-23_震', {
    owner_id: 'daily-assistant-internal-shared',
    date: '2026-10-23', person: '震', off: true, client_updated_at: 900,
    updated_at: new Date().toISOString(), device_id: 'device-b'
  });

  assert.equal(await sync.refresh(), true);

  assert.equal(snapshots.at(-1).records['2026-10-23_震'].off, true);
  assert.equal(snapshots.at(-1).records['2026-10-23_震'].deviceId, 'device-b');
  assert.equal(snapshots.at(-1).initial, false);
});

test('keeps local writes queued and retries after an anonymous database write failure', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = createDevice({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });
  await sync.resume();
  failedWrites = 1;
  sync.writeRecord('2026-10-24_震', {
    date: '2026-10-24', person: '震', off: true, updatedAt: 1000, deviceId: sync.deviceId()
  });
  await sync.flushPending();

  assert.equal(JSON.parse(storage.get('daily-assistant-sync-pending-v1'))['2026-10-24_震'].off, true);
  assert.match(sync.status(), /共享排班写入失败/);

  await sync.refresh();
  await sync.flushPending();

  assert.equal(writes.at(-1).key, 'daily-assistant-internal-shared_2026-10-24_震');
  assert.deepEqual(JSON.parse(storage.get('daily-assistant-sync-pending-v1')), {});
});

test('reports anonymous access failures without claiming that syncing connected', async (t) => {
  let sync;
  t.after(() => sync?.disconnect());
  sync = createDevice({ config: { env: 'test-env-123', accessKey: 'test-publishable-key' } });
  failedReads = 1;

  await sync.resume();

  assert.match(sync.status(), /共享排班读取失败：read denied/);
});

test('does not attempt a CloudBase request when app configuration is incomplete', async () => {
  const sync = createDevice({ config: { env: 'test-env-123', accessKey: '' } });

  await sync.resume();

  assert.equal(sync.configured, false);
  assert.equal(cloudbaseConfig, null);
  assert.equal(sync.status(), '云端服务尚未配置');
});
