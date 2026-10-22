// Use Android HTTPS for schedule requests: the free CloudBase plan rejects the
// WebView origin in CORS. Browser previews retain their normal fetch transport.
(() => {
  const host = typeof window === 'undefined' ? globalThis : window;
  const nativeFetch = host.fetch?.bind(host);
  if (!nativeFetch || host.__dailyCloudbaseFetchShim) return;
  host.__dailyCloudbaseFetchShim = true;
  const pendingNative = new Map();

  host.onCloudBaseScheduleResponse = (result) => {
    const pending = pendingNative.get(result.id);
    if (!pending) return;
    pendingNative.delete(result.id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (result.error) pending.reject(new TypeError(result.error));
    else pending.resolve(new Response([204, 205, 304].includes(result.status) ? null : result.body, {
      status: result.status,
      headers: { 'Content-Type': 'application/json' }
    }));
  };

  function isNativeScheduleUrl(input) {
    if (typeof host.AndroidBridge?.cloudBaseScheduleRequest !== 'function') return false;
    try {
      const url = new URL(typeof input === 'string' ? input : input.url);
      return url.protocol === 'https:' && !url.port &&
        url.hostname === `${host.CLOUDBASE_SYNC_CONFIG?.env}.api.tcloudbasegateway.com` &&
        url.pathname === '/v1/rdb/rest/schedule_records';
    } catch { return false; }
  }

  async function androidFetch(input, init) {
    const request = new Request(input, init);
    if (request.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
    const body = request.method === 'GET' ? '' : await request.text();
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const url = new URL(request.url);
    return new Promise((resolve, reject) => {
      const cleanup = () => request.signal.removeEventListener('abort', abort);
      const fail = (error) => {
        const pending = pendingNative.get(id);
        if (!pending) return;
        pendingNative.delete(id);
        clearTimeout(pending.timer);
        cleanup();
        reject(error);
      };
      const abort = () => fail(new DOMException('Request aborted', 'AbortError'));
      const timer = setTimeout(() => fail(new TypeError('CloudBase Android request timed out')), 45000);
      pendingNative.set(id, { resolve, reject, timer, cleanup });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) return abort();
      try {
        const headers = Object.fromEntries(request.headers.entries());
        delete headers.authorization;
        host.AndroidBridge.cloudBaseScheduleRequest(id, request.method, url.pathname + url.search, JSON.stringify(headers), body);
      } catch (error) { fail(error); }
    });
  }

  function isCloudBaseUrl(input) {
    const value = typeof input === 'string' ? input : input?.url;
    return typeof value === 'string' && /\.tcb-api\.tencentcloudapi\.com\//i.test(value);
  }

  function xhrFetch(input, init = {}) {
    const request = typeof input === 'string' ? { url: input } : input;
    const method = String(init.method || request.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || request.headers || {});
    const body = init.body === undefined ? request.body : init.body;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, request.url, true);
      headers.forEach((value, key) => xhr.setRequestHeader(key, value));
      xhr.withCredentials = Boolean(init.credentials === 'include' || request.credentials === 'include');
      xhr.timeout = Number(init.timeout || 0);
      xhr.onload = () => {
        const responseHeaders = new Headers();
        xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach((line) => {
          const separator = line.indexOf(':');
          if (separator > 0) responseHeaders.append(line.slice(0, separator), line.slice(separator + 1).trim());
        });
        const text = xhr.responseText || '';
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders,
          url: request.url,
          text: () => Promise.resolve(text),
          json: () => Promise.resolve(text ? JSON.parse(text) : {})
        });
      };
      xhr.onerror = () => reject(new TypeError('CloudBase XHR request failed'));
      xhr.ontimeout = () => reject(new TypeError('CloudBase XHR request timed out'));
      xhr.onabort = () => reject(new TypeError('CloudBase XHR request aborted'));
      if (init.signal) {
        if (init.signal.aborted) xhr.abort();
        else init.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(body === undefined ? null : body);
    });
  }

  host.fetch = (input, init) => {
    if (isNativeScheduleUrl(input)) return androidFetch(input, init);
    if (!isCloudBaseUrl(input)) return nativeFetch(input, init);
    return nativeFetch(input, init).catch((fetchError) => xhrFetch(input, init).catch((xhrError) => {
      const details = [fetchError?.message, xhrError?.message].filter(Boolean).join('; ');
      throw new TypeError(`CloudBase fetch and XHR failed: ${details}`);
    }));
  };
})();
