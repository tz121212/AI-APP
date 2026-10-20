const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const shimSource = fs.readFileSync(path.join(__dirname, '..', 'cloudbase-fetch-shim.js'), 'utf8');

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
