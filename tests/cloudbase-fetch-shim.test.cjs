const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const shimSource = fs.readFileSync(path.join(__dirname, '..', 'cloudbase-fetch-shim.js'), 'utf8');

function androidTransport(bridge, fetch = async () => { throw new Error('Browser transport must not run'); }) {
  const window = {
    fetch,
    CLOUDBASE_SYNC_CONFIG: { env: 'internal-env' },
    AndroidBridge: { cloudBaseScheduleRequest: (...args) => bridge(window, ...args) }
  };
  vm.runInNewContext(shimSource, {
    window, Headers, Request, Response, URL, DOMException, setTimeout, clearTimeout
  });
  return window;
}

test('Android sends schedule upserts through async native HTTPS without a login request', async () => {
  const window = androidTransport((host, id, method, path, headers, body) => {
    assert.equal(method, 'POST');
    assert.equal(path, '/v1/rdb/rest/schedule_records?on_conflict=owner_id%2Cdate%2Cperson');
    assert.equal(JSON.parse(headers).authorization, undefined);
    assert.equal(JSON.parse(headers).prefer, 'resolution=merge-duplicates');
    assert.equal(JSON.parse(body).person, '军');
    queueMicrotask(() => host.onCloudBaseScheduleResponse({ id, status: 201, body: '' }));
  });
  const response = await window.fetch('https://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records?on_conflict=owner_id%2Cdate%2Cperson', {
    method: 'POST', headers: { Authorization: 'Bearer publishable', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ person: '军', off: true })
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '');
});

test('Android preserves HTTP errors and their response details for the SDK', async () => {
  const window = androidTransport((host, id) => {
    host.onCloudBaseScheduleResponse({ id, status: 400, body: '{"message":"invalid column","code":"42703"}' });
  });
  const response = await window.fetch('https://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records');
  assert.equal(response.ok, false);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, 'invalid column');
});

test('Android rejects network failures so offline writes stay queued', async () => {
  const window = androidTransport((host, id) => {
    host.onCloudBaseScheduleResponse({ id, error: 'Unable to resolve host' });
  });
  await assert.rejects(window.fetch('https://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records'), /Unable to resolve host/);
});

test('Android native transport only handles the configured schedule table', async () => {
  let browserCalls = 0;
  const window = androidTransport(() => { throw new Error('Must not proxy other endpoints'); }, async () => {
    browserCalls += 1;
    return new Response('[]');
  });
  for (const url of [
    'https://other-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records',
    'https://internal-env.api.tcloudbasegateway.com/auth/v1/signin',
    'https://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/other_table',
    'http://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records'
  ]) await window.fetch(url);
  assert.equal(browserCalls, 4);
});

test('Android can abort a pending request and ignores its late result', async () => {
  let requestId;
  const window = androidTransport((host, id) => { requestId = id; });
  const controller = new AbortController();
  const request = window.fetch('https://internal-env.api.tcloudbasegateway.com/v1/rdb/rest/schedule_records', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  window.onCloudBaseScheduleResponse({ id: requestId, status: 204, body: '' });
});

test('retries CloudBase network failures through XMLHttpRequest', async () => {
  const calls = [];
  class FakeXHR {
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    setRequestHeader(name, value) { calls.push(['header', name, value]); }
    send(body) {
      calls.push(['xhr', this.method, this.url, body]);
      this.status = 401;
      this.statusText = 'Unauthorized';
      this.responseText = JSON.stringify({ code: 'INVALID_CREDENTIALS' });
      this.getAllResponseHeaders = () => 'content-type: application/json\r\n';
      this.onload();
    }
  }
  const nativeFetch = async () => { throw new TypeError('Failed to fetch'); };
  const window = { fetch: nativeFetch, XMLHttpRequest: FakeXHR };
  vm.runInNewContext(shimSource, { window, Headers, XMLHttpRequest: FakeXHR });

  const response = await window.fetch(
    'https://env.ap-shanghai.tcb-api.tencentcloudapi.com/web/auth/v1/signin',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"internal"}' }
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'INVALID_CREDENTIALS');
  assert.equal(calls.find(([kind]) => kind === 'xhr')[1], 'POST');
  assert.equal(calls.find(([kind]) => kind === 'xhr')[3], '{"username":"internal"}');
});

test('does not retry requests to other services', async () => {
  let calls = 0;
  const nativeFetch = async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  };
  class UnexpectedXHR {
    constructor() { throw new Error('XHR must not be used for other services'); }
  }
  const window = { fetch: nativeFetch, XMLHttpRequest: UnexpectedXHR };
  vm.runInNewContext(shimSource, { window, Headers, XMLHttpRequest: UnexpectedXHR });

  await assert.rejects(window.fetch('https://example.com/api'), /Failed to fetch/);
  assert.equal(calls, 1);
});

test('reports both network paths when CloudBase remains unreachable', async () => {
  const window = {
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    XMLHttpRequest: class {
      open() {}
      setRequestHeader() {}
      send() { this.onerror(); }
    }
  };
  vm.runInNewContext(shimSource, { window, Headers, XMLHttpRequest: window.XMLHttpRequest });

  await assert.rejects(
    window.fetch('https://env.ap-shanghai.tcb-api.tencentcloudapi.com/web/auth/v1/signin', { method: 'POST' }),
    /CloudBase fetch and XHR failed: Failed to fetch; CloudBase XHR request failed/
  );
});
