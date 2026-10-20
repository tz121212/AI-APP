(() => {
  const AUTH_KEY = 'daily-assistant-cloudbase-auth-v1';
  const PENDING_KEY = 'daily-assistant-sync-pending-v1';
  const DEVICE_KEY = 'daily-assistant-sync-device-v1';
  const TABLE = 'schedule_records';
  const POLL_INTERVAL_MS = 5000;
  const POLL_OVERLAP_MS = 5000;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function createScheduleSync({ config, onRecords, onStatus }) {
    const env = String(config?.env || '').trim();
    const region = String(config?.region || 'ap-shanghai').trim();
    const accessKey = String(config?.accessKey || '').trim();
    const configured = Boolean(env && region && accessKey && typeof globalThis.createCloudBaseApp === 'function');
    const host = typeof window === 'undefined' ? globalThis : window;
    const documentRef = host.document || globalThis.document;
    let app = null;
    let auth = null;
    let db = null;
    let pollTimer = null;
    let pollInFlight = null;
    let pendingFlush = null;
    let flushRequested = false;
    let hasInitialSnapshot = false;
    let lastUpdatedAt = 0;
    let connected = false;
    let account = readJSON(AUTH_KEY, {}).account || '';
    let records = {};
    let status = configured ? '尚未连接云端' : '云端服务尚未配置';
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
      app = globalThis.createCloudBaseApp({ env, region, accessKey, endPointMode: 'CLOUD_API' });
      auth = app.auth({ persistence: 'local' });
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
      const maxUpdatedAt = Object.values(nextRecords).reduce((max, row) => {
        const value = Date.parse(row.serverUpdatedAt || '');
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, lastUpdatedAt);
      lastUpdatedAt = maxUpdatedAt;
      setStatus(`已连接，排班每 ${POLL_INTERVAL_MS / 1000} 秒检查更新`);
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
          let query = db.from(TABLE).select('*');
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
          setStatus(`云端同步暂不可用：${error?.message || '排班仍保存在本机'}`);
          return false;
        }
      })();
      pollInFlight = task.finally(() => { pollInFlight = null; });
      return pollInFlight;
    }

    async function signIn(value, password) {
      const identifier = String(value || '').trim();
      if (!identifier) throw new Error('请输入 CloudBase 邮箱或用户名');
      ensureClient();
      const credentials = EMAIL_PATTERN.test(identifier)
        ? { email: identifier, password }
        : { username: identifier, password };
      const result = await auth.signInWithPassword(credentials);
      if (result?.error) throw result.error;
      const session = result?.data?.session;
      if (!session || session.user?.is_anonymous) throw new Error('登录未建立有效账号会话，请检查账号和登录配置');
      const user = session.user || result?.data?.user;
      account = identifier;
      localStorage.setItem(AUTH_KEY, JSON.stringify({ account }));
      connected = true;
      startPolling();
      await refresh();
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
            } catch {
              setStatus('排班已保存在本机，网络恢复后会继续同步');
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
        const result = await auth.getSession();
        if (result?.error) throw result.error;
        const session = result?.data?.session;
        if (!session || session.user?.is_anonymous) {
          connected = false;
          setStatus('尚未连接云端');
          return;
        }
        const user = session.user;
        account = user.username || account || user.email || '';
        if (account) localStorage.setItem(AUTH_KEY, JSON.stringify({ account }));
        connected = true;
        startPolling();
        await refresh();
      } catch (error) {
        connected = false;
        stopPolling();
        setStatus(`云端暂不可用：${error?.message || '网络暂不可用，排班仍保存在本机'}`);
      }
    }

    async function connect(value, password) {
      if (!configured) {
        setStatus('云端服务尚未配置');
        throw new Error(status);
      }
      stopPolling();
      connected = false;
      setStatus('正在登录共享账号…');
      try {
        await signIn(String(value || '').trim(), password);
      } catch (error) {
        connected = false;
        stopPolling();
        const message = String(error?.message || '无法连接云端');
        const displayMessage = /cloudbase fetch and xhr failed/i.test(message)
          ? 'Android WebView 的 fetch 和 XHR 都无法连接 CloudBase。请切换手机 Wi-Fi/移动网络后重试；如仍失败，请检查手机网络是否能访问腾讯云开发。'
          : /failed to fetch|networkerror|load failed/i.test(message)
            ? '无法连接 CloudBase 登录服务（Failed to fetch）。请检查手机网络是否能访问腾讯云开发。账号密码错误会显示具体认证错误。'
            : message;
        setStatus(displayMessage);
        throw new Error(displayMessage);
      }
    }

    async function disconnect() {
      connected = false;
      stopPolling();
      hasInitialSnapshot = false;
      lastUpdatedAt = 0;
      account = '';
      localStorage.removeItem(AUTH_KEY);
      try { await auth?.signOut(); } catch {}
      setStatus(configured ? '已断开云端同步' : '云端服务尚未配置');
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
      connect,
      disconnect,
      deviceId: () => deviceId,
      account: () => account,
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
