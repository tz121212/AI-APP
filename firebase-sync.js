(() => {
  const AUTH_KEY = 'daily-assistant-sync-auth-v1';
  const PENDING_KEY = 'daily-assistant-sync-pending-v1';
  const DEVICE_KEY = 'daily-assistant-sync-device-v1';

  function createScheduleSync({ config, onRecords, onStatus }) {
    const apiKey = String(config?.apiKey || '').trim();
    const databaseUrl = String(config?.databaseURL || '').trim().replace(/\/$/, '');
    const configured = Boolean(apiKey && databaseUrl);
    let auth = readJSON(AUTH_KEY, null);
    let idToken = '';
    let tokenExpiresAt = 0;
    let refreshTimer = 0;
    let source = null;
    let pendingFlush = null;
    let flushRequested = false;
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

    function errorMessage(response, data) {
      const code = data?.error?.message || '';
      if (code.includes('INVALID_LOGIN_CREDENTIALS') || code.includes('EMAIL_NOT_FOUND') || code.includes('INVALID_PASSWORD')) return '账号或密码不正确';
      if (code === 'OPERATION_NOT_ALLOWED') return 'Firebase 尚未启用邮箱和密码登录';
      if (code === 'USER_DISABLED') return '此同步账号已停用';
      return code || `云端请求失败 (${response.status})`;
    }

    async function request(url, options = {}) {
      const response = await fetch(url, options);
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!response.ok) {
        const error = new Error(errorMessage(response, data));
        error.status = response.status;
        throw error;
      }
      return data;
    }

    function saveAuth() {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ email: auth?.email || '', refreshToken: auth?.refreshToken || '' }));
    }

    function savePending(pending) {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    }

    function compareRecord(left, right) {
      const timestampDifference = Number(left?.updatedAt || 0) - Number(right?.updatedAt || 0);
      return timestampDifference || String(left?.deviceId || '').localeCompare(String(right?.deviceId || ''));
    }

    function getPending() {
      return readJSON(PENDING_KEY, {});
    }

    function stopStream() {
      if (source) source.close();
      source = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = 0;
    }

    function scheduleTokenRefresh(expiresIn) {
      if (refreshTimer) clearTimeout(refreshTimer);
      tokenExpiresAt = Date.now() + Number(expiresIn || 3600) * 1000;
      refreshTimer = setTimeout(async () => {
        try {
          await refreshAuth();
          openStream();
        } catch {
          setStatus('云端登录已过期，请重新连接');
        }
      }, Math.max(60_000, tokenExpiresAt - Date.now() - 120_000));
    }

    async function signIn(email, password) {
      const data = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
      });
      auth = { email: data.email || email, refreshToken: data.refreshToken };
      saveAuth();
      idToken = data.idToken;
      scheduleTokenRefresh(data.expiresIn);
      openStream();
    }

    async function refreshAuth() {
      if (!auth?.refreshToken) throw new Error('没有保存的同步登录状态');
      const data = await request(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken })
      });
      auth.refreshToken = data.refresh_token || auth.refreshToken;
      saveAuth();
      idToken = data.id_token;
      scheduleTokenRefresh(data.expires_in);
      return idToken;
    }

    let hasInitialSnapshot = false;

    function applyEvent(type, raw) {
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      const path = String(payload.path || '/').split('/').filter(Boolean);
      const data = payload.data;
      if (path.length === 0) {
        if (type === 'put') records = data && typeof data === 'object' ? data : {};
        else if (data && typeof data === 'object') records = { ...records, ...data };
      } else if (path.length === 1) {
        if (data == null) delete records[path[0]];
        else records[path[0]] = data;
      }
      const initial = !hasInitialSnapshot && path.length === 0 && type === 'put';
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
      if (initial) flushPending();
    }

    function openStream() {
      if (!idToken || typeof EventSource === 'undefined') {
        if (typeof EventSource === 'undefined') setStatus('当前环境不支持实时连接');
        return;
      }
      if (source) source.close();
      records = {};
      hasInitialSnapshot = false;
      const url = `${databaseUrl}/daily-assistant/scheduleRecords.json?auth=${encodeURIComponent(idToken)}`;
      source = new EventSource(url);
      source.onopen = () => {
        setStatus('已连接，排班实时同步');
        if (hasInitialSnapshot) flushPending();
      };
      source.onerror = () => setStatus('网络暂不可用，正在等待重连');
      source.addEventListener('put', (event) => applyEvent('put', event.data));
      source.addEventListener('patch', (event) => applyEvent('patch', event.data));
      source.addEventListener('cancel', () => setStatus('Firebase 规则拒绝访问，请检查共享账号和数据库规则'));
      source.addEventListener('auth_revoked', () => setStatus('云端登录已过期，请重新连接'));
    }

    async function ensureFreshToken() {
      if (!idToken || tokenExpiresAt - Date.now() < 60_000) await refreshAuth();
      return idToken;
    }

    async function putRecord(key, record, retry = true) {
      const token = await ensureFreshToken();
      const url = `${databaseUrl}/daily-assistant/scheduleRecords/${encodeURIComponent(key)}.json?auth=${encodeURIComponent(token)}`;
      try {
        await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      } catch (error) {
        if (error.status === 401 && retry) {
          await refreshAuth();
          return putRecord(key, record, false);
        }
        throw error;
      }
    }

    async function flushPending() {
      if (pendingFlush) {
        flushRequested = true;
        return pendingFlush;
      }
      pendingFlush = (async () => {
        while (true) {
          flushRequested = false;
          const pending = getPending();
          const entries = Object.entries(pending);
          if (!entries.length) {
            if (flushRequested) continue;
            return;
          }
          for (const [key, record] of entries) {
            try {
              await putRecord(key, record);
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
      try { await pendingFlush; }
      finally {
        const shouldFlushAgain = flushRequested;
        pendingFlush = null;
        flushRequested = false;
        if (shouldFlushAgain) await flushPending();
      }
    }

    function replaceRecords(nextRecords) {
      const pending = getPending();
      const knownKeys = new Set([...Object.keys(records), ...Object.keys(pending)]);
      knownKeys.forEach((key) => {
        const current = records[key] || pending[key];
        if (current && current.date && current.person) {
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
      if (!auth?.refreshToken) {
        setStatus('尚未连接云端');
        return;
      }
      setStatus('正在连接云端…');
      try {
        await refreshAuth();
        openStream();
      } catch {
        auth = null;
        idToken = '';
        localStorage.removeItem(AUTH_KEY);
        setStatus('云端登录已过期，请重新连接');
      }
    }

    async function connect(email, password) {
      if (!configured) {
        setStatus('云端服务尚未配置');
        throw new Error(status);
      }
      stopStream();
      auth = null;
      idToken = '';
      setStatus('正在登录共享账号…');
      try {
        await signIn(email.trim(), password);
      } catch (error) {
        setStatus(error.message || '无法连接云端');
        throw error;
      }
    }

    function disconnect() {
      stopStream();
      auth = null;
      idToken = '';
      localStorage.removeItem(AUTH_KEY);
      setStatus(configured ? '已断开云端同步' : '云端服务尚未配置');
    }

    function writeRecord(key, record) {
      const pending = getPending();
      pending[key] = record;
      savePending(pending);
      if (idToken) flushPending();
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
      email: () => auth?.email || '',
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
