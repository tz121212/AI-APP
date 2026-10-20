// Android WebView versions differ in how fetch handles cross-origin requests.
// Retry CloudBase requests through XMLHttpRequest when fetch reports a network failure.
(() => {
  const host = typeof window === 'undefined' ? globalThis : window;
  const nativeFetch = host.fetch?.bind(host);
  if (!nativeFetch || host.__dailyCloudbaseFetchShim) return;
  host.__dailyCloudbaseFetchShim = true;

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
    if (!isCloudBaseUrl(input)) return nativeFetch(input, init);
    return nativeFetch(input, init).catch((fetchError) => xhrFetch(input, init).catch((xhrError) => {
      const details = [fetchError?.message, xhrError?.message].filter(Boolean).join('; ');
      throw new TypeError(`CloudBase fetch and XHR failed: ${details}`);
    }));
  };
})();
