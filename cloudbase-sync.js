(() => {
  const PENDING_KEY = 'daily-assistant-sync-pending-v1';
  const DEVICE_KEY = 'daily-assistant-sync-device-v1';
  const TABLE = 'schedule_records';
  const SHARED_OWNER = 'daily-assistant-internal-shared';
  const POLL_INTERVAL_MS = 5000;
  const POLL_OVERLAP_MS = 5000;

  function createScheduleSync({ config, onRecords, onStatus }) {
    const env = String(config?.env || '').trim();
    const region = String(config?.region || 'ap-shanghai').trim();
    const accessKey = String(config?.accessKey || '').trim();
    const configured = Boolean(env && region && accessKey && typeof globalThis.createCloudBaseApp === 'function');
    const host = typeof window === 'undefined' ? globalThis : window;
    const documentRef = host.document || globalThis.document;
    let app = null;
    let db = null;
    let pollTimer = null;
    let pollInFlight = null;
    let pendingFlush = null;
    let flushRequested = false;
    let hasInitialSnapshot = false;
    let lastUpdatedAt = 0;
    let connected = false;
    let records = {};
    let status = configured ? '正在连接共享排班…' : '云端服务尚未配置';
    const deviceId = getDeviceId();

    function readJSON(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
      catch { return fallback; }
    }

    function setStatus(value) {
      if (status === value) return;
      status = value;
      onStatus?.(value);
    }

    function getPending() {
      return readJSON(PENDING_KEY, {});
    }

    function savePending(pending) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    }

    function compareRecord(left, right) {
      const timestampDifference = Number(left?.updatedAt || 0) - Number(right?.updatedAt || 0);
      return timestampDifference || String(left?.deviceId || '').localeCompare(String(right?.deviceId || ''));
    }

    function ensureClient() {
      if (app) return;
      app = globalThis.createCloudBaseApp({ env, region, accessKey, persistence: 'none', endPointMode: 'CLOUD_API' });
      db = app.rdb();
      if (!db) throw new Error('CloudBase PostgreSQL 客户端不可用');
    }

    function normalizeRows(rows) {
      return Object.fromEntries((Array.isArray(rows) ? rows : [])
        .filter((row) => row && row.date && row.person)
        .map((row) => {
          const record = {
            date: String(row.date),
            person: String(row.person),
            off: Boolean(row.off),
            updatedAt: Number(row.client_updated_at || 0),
            deviceId: String(row.device_id || ''),
            serverUpdatedAt: String(row.updated_at || '')
          };
          return [`${record.date}_${record.person}`, record];
        }));
    }

    function stopPolling() {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    }

    function isVisible() {
      return !documentRef || documentRef.visibilityState !== 'hidden';
    }

    function startPolling() {
      stopPolling();
      if (!connected || !isVisible()) return;
      refresh();
      pollTimer = setInterval(() => refresh(), POLL_INTERVAL_MS);
      pollTimer?.unref?.();
    }

    function applySnapshot(nextRecords) {
      const initial = !hasInitialSnapshot;
      const changed = initial || Object.entries(nextRecords).some(([key, incoming]) => {
        const current = records[key];
        return !current || compareRecord(current, incoming) !== 0 || current.off !== incoming.off;
      });
      if (initial) records = nextRecords;
      else Object.assign(records, nextRecords);
      lastUpdatedAt = Object.values(nextRecords).reduce((max, row) => {
        const value = Date.parse(row.serverUpdatedAt || '');
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, lastUpdatedAt);
      setStatus(`共享排班已连接，每 ${POLL_INTERVAL_MS / 1000} 秒检查更新`);
      if (initial) {
        hasInitialSnapshot = true;
        const pending = getPending();
        Object.entries(pending).forEach(([key, local]) => {
          const remote = records[key];
          if (remote && compareRecord(local, remote) <= 0) delete pending[key];
        });
        savePending(pending);
      }
      if (changed) onRecords?.({ ...records }, initial);
      flushPending();
    }

    async function refresh() {
      if (!db || !connected) return false;
      if (pollInFlight) return pollInFlight;
      const task = (async () => {
        try {
          let query = db.from(TABLE).select('*').eq('owner_id', SHARED_OWNER);
          if (hasInitialSnapshot && lastUpdatedAt > 0) {
            const overlap = new Date(Math.max(0, lastUpdatedAt - POLL_OVERLAP_MS)).toISOString();
            query = query.gte('updated_at', overlap);
          }
          const result = await query.order('updated_at', { ascending: true });
          if (result?.error) throw result.error;
          if (!connected) return false;
          applySnapshot(normalizeRows(result?.data));
          return true;
        } catch (error) {
          setStatus(`共享排班读取失败：${error?.message || '网络暂不可用'}`);
          return false;
        }
      })();
      pollInFlight = task.finally(() => { pollInFlight = null; });
      return pollInFlight;
    }

    function flushPending() {
      if (!db || !hasInitialSnapshot) return Promise.resolve();
      if (pendingFlush) {
        flushRequested = true;
        return pendingFlush;
      }
      const task = (async () => {
        while (true) {
          flushRequested = false;
          const pending = getPending();
          const entries = Object.entries(pending);
          if (!entries.length) {
            if (flushRequested) continue;
            await Promise.resolve();
            if (flushRequested) continue;
            return;
          }
          for (const [key, record] of entries) {
            try {
              const remote = records[key];
              if (remote && compareRecord(record, remote) <= 0) {
                const latest = getPending();
                if (JSON.stringify(latest[key]) === JSON.stringify(record)) delete latest[key];
                savePending(latest);
                continue;
              }
              const result = await db.from(TABLE).upsert({
                owner_id: SHARED_OWNER,
                date: record.date,
                person: record.person,
                off: record.off,
                client_updated_at: Number(record.updatedAt || 0),
                device_id: String(record.deviceId || '')
              }, { onConflict: 'owner_id,date,person' });
              if (result?.error) throw result.error;
              const latest = getPending();
              if (JSON.stringify(latest[key]) === JSON.stringify(record)) delete latest[key];
              savePending(latest);
            } catch (error) {
              setStatus(`共享排班写入失败：${error?.message || '网络恢复后会继续同步'}`);
              return;
            }
          }
        }
      })();
      pendingFlush = task.finally(() => { pendingFlush = null; });
      return pendingFlush;
    }

    function replaceRecords(nextRecords) {
      const pending = getPending();
      const knownKeys = new Set([...Object.keys(records), ...Object.keys(pending)]);
      knownKeys.forEach((key) => {
        const current = records[key] || pending[key];
        if (current?.date && current?.person) {
          writeRecord(key, { ...current, off: false, deviceId, updatedAt: Date.now() });
        }
      });
      nextRecords.forEach((item) => {
        const key = `${item.date}_${item.person}`;
        writeRecord(key, { ...item, off: true, deviceId, updatedAt: Date.now() });
      });
    }

    async function resume() {
      if (!configured) {
        setStatus('云端服务尚未配置');
        return;
      }
      try {
        ensureClient();
        connected = true;
        startPolling();
        await refresh();
      } catch (error) {
        connected = false;
        stopPolling();
        setStatus(`共享排班暂不可用：${error?.message || '请检查网络连接'}`);
      }
    }

    async function disconnect() {
      connected = false;
      stopPolling();
      hasInitialSnapshot = false;
      lastUpdatedAt = 0;
      setStatus(configured ? '共享排班已暂停' : '云端服务尚未配置');
    }

    function writeRecord(key, record) {
      const pending = getPending();
      pending[key] = record;
      savePending(pending);
      if (db && hasInitialSnapshot) flushPending();
    }

    function getDeviceId() {
      let value = localStorage.getItem(DEVICE_KEY);
      if (!value) {
        value = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(DEVICE_KEY, value);
      }
      return value;
    }

    const handleVisibilityChange = () => {
      if (isVisible()) startPolling();
      else stopPolling();
    };
    const handleOnline = () => {
      if (isVisible()) {
        refresh();
        if (connected && pollTimer === null) startPolling();
      }
    };
    documentRef?.addEventListener?.('visibilitychange', handleVisibilityChange);
    host.addEventListener?.('online', handleOnline);

    return {
      configured,
      connect: resume,
      disconnect,
      deviceId: () => deviceId,
      flushPending,
      refresh,
      resume,
      replaceRecords,
      status: () => status,
      writeRecord
    };
  }

  const host = typeof window === 'undefined' ? globalThis : window;
  host.createScheduleSync = createScheduleSync;
})();
