(() => {
  const AUTH_KEY = 'daily-assistant-cloudbase-auth-v1';
  const PENDING_KEY = 'daily-assistant-sync-pending-v1';
  const DEVICE_KEY = 'daily-assistant-sync-device-v1';
  const COLLECTION = 'scheduleRecords';

  function createScheduleSync({ config, onRecords, onStatus }) {
    const env = String(config?.env || '').trim();
    const region = String(config?.region || 'ap-shanghai').trim();
    const configured = Boolean(env && region && typeof globalThis.createCloudBaseApp === 'function');
    let app = null;
    let auth = null;
    let collection = null;
    let listener = null;
    let account = readJSON(AUTH_KEY, {}).account || '';
    let pendingFlush = null;
    let flushRequested = false;
    let hasInitialSnapshot = false;
    let records = {};
    let status = configured ? '尚未连接云端' : '云端服务尚未配置';
    const deviceId = getDeviceId();

    function readJSON(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
      catch { return fallback; }
    }

    function setStatus(value) {
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
      app = globalThis.createCloudBaseApp({ env, region });
      auth = app.auth({ persistence: 'local' });
      collection = app.database().collection(COLLECTION);
    }

    function stopWatch() {
      listener?.close?.();
      listener = null;
      hasInitialSnapshot = false;
    }

    function normalizeSnapshot(snapshot) {
      const documents = snapshot?.docs || {};
      const entries = Array.isArray(documents)
        ? documents.map((document) => [document?._id, document])
        : Object.entries(documents);
      return Object.fromEntries(entries
        .filter(([, document]) => document && typeof document === 'object')
        .map(([id, document]) => {
          const { _id, ...record } = document;
          return [String(_id || id), record];
        })
        .filter(([key, record]) => key && record.date && record.person));
    }

    function applySnapshot(snapshot) {
      records = normalizeSnapshot(snapshot);
      setStatus('已连接，排班实时同步');
      const initial = !hasInitialSnapshot;
      if (initial) {
        hasInitialSnapshot = true;
        const pending = getPending();
        Object.entries(pending).forEach(([key, local]) => {
          const remote = records[key];
          if (remote && compareRecord(local, remote) <= 0) delete pending[key];
          else records[key] = local;
        });
        savePending(pending);
      }
      onRecords?.({ ...records }, initial);
      flushPending();
    }

    function openWatch() {
      stopWatch();
      records = {};
      try {
        listener = collection.watch({
          onChange: applySnapshot,
          onError: (error) => setStatus(`云端连接中断：${error?.message || '正在尝试重连'}`)
        });
      } catch (error) {
        setStatus(`无法开启实时同步：${error.message || '请检查云端配置'}`);
        throw error;
      }
    }

    async function signIn(value, password) {
      ensureClient();
      const credential = value.includes('@') ? { email: value, password } : { username: value, password };
      const result = await auth.signInWithPassword(credential);
      if (result?.error) throw result.error;
      const user = result?.data?.user;
      account = user?.username || user?.email || value;
      localStorage.setItem(AUTH_KEY, JSON.stringify({ account }));
      openWatch();
    }

    function flushPending() {
      if (!collection || !hasInitialSnapshot) return Promise.resolve();
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
              const result = await collection.doc(key).set({ data: record });
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
        const result = await auth.getUser();
        if (result?.error) throw result.error;
        if (!result?.data?.user) {
          setStatus('尚未连接云端');
          return;
        }
        const user = result.data.user;
        account = user.username || user.email || account;
        if (account) localStorage.setItem(AUTH_KEY, JSON.stringify({ account }));
        openWatch();
        setStatus('正在连接云端…');
      } catch (error) {
        setStatus(`云端暂不可用：${error?.message || '网络暂不可用，排班仍保存在本机'}`);
      }
    }

    async function connect(value, password) {
      if (!configured) {
        setStatus('云端服务尚未配置');
        throw new Error(status);
      }
      stopWatch();
      setStatus('正在登录共享账号…');
      try {
        await signIn(String(value || '').trim(), password);
      } catch (error) {
        setStatus(error?.message || '无法连接云端');
        throw error;
      }
    }

    async function disconnect() {
      stopWatch();
      account = '';
      localStorage.removeItem(AUTH_KEY);
      try { await auth?.signOut(); } catch {}
      setStatus(configured ? '已断开云端同步' : '云端服务尚未配置');
    }

    function writeRecord(key, record) {
      const pending = getPending();
      pending[key] = record;
      savePending(pending);
      if (collection && hasInitialSnapshot) flushPending();
    }

    function getDeviceId() {
      let value = localStorage.getItem(DEVICE_KEY);
      if (!value) {
        value = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(DEVICE_KEY, value);
      }
      return value;
    }

    return {
      configured,
      connect,
      disconnect,
      deviceId: () => deviceId,
      email: () => account,
      flushPending,
      resume,
      replaceRecords,
      status: () => status,
      writeRecord
    };
  }

  const host = typeof window === 'undefined' ? globalThis : window;
  host.createScheduleSync = createScheduleSync;
})();
