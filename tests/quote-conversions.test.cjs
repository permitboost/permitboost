const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash, webcrypto } = require('node:crypto');
const vm = require('node:vm');

const root = resolve(__dirname, '..');
const helper = readFileSync(resolve(root, 'quote-conversions.js'), 'utf8');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const formScript = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes("getElementById('quoteForm')"));
const key = 'permitboost.quoteConversion';
const digest = value => createHash('sha256').update(value).digest('hex');
const submitted = () => new Map([
  ['email', ' Casey.Example+Quote@GMAIL.COM '],
  ['phone', '202-555-0144']
]);
const clone = value => JSON.parse(JSON.stringify(value));

function harness({ store = new Map(), storageMode, crypto = webcrypto, fetch } = {}) {
  const calls = [];
  const window = {
    crypto,
    location: {},
    setTimeout,
    clearTimeout,
    sessionStorage: {
      getItem(name) {
        if(storageMode === 'blocked') throw new Error('Storage blocked');
        return store.get(name) ?? null;
      },
      setItem(name, value) {
        if(storageMode) throw new Error('Storage unavailable');
        store.set(name, value);
      },
      removeItem(name) {
        if(storageMode === 'blocked') throw new Error('Storage blocked');
        store.delete(name);
      }
    },
    gtag(...args) {
      calls.push(args);
      if(args[0] === 'event') args[2].event_callback();
    }
  };
  const fields = submitted();
  const elements = {
    quoteForm: {
      action: 'https://formspree.io/f/mqpkgjlp',
      addEventListener(name, fn) { this[name] = fn; }
    },
    quoteSubmit: { disabled: false, textContent: 'Send project' },
    quoteError: { style: {} }
  };
  const context = vm.createContext({
    window, TextEncoder, Uint8Array, console: { error() {} },
    document: { getElementById: name => elements[name] },
    FormData: function() { return new Map(fields); }, fetch
  });
  vm.runInContext(helper, context);
  return {
    window, store, calls, elements, fields,
    api: window.PermitBoostConversions,
    conversions: () => calls.filter(call => call[0] === 'event'),
    installForm: () => vm.runInContext(formScript, context),
    submit() { elements.quoteForm.submit({ preventDefault() {} }); }
  };
}

async function waitFor(predicate) {
  for(let n = 0; n < 100; n++) {
    if(predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected asynchronous form behavior did not complete');
}

test('confirmed submissions store normalized hashes, never raw contact data', async () => {
  const h = harness();
  await h.api.recordSuccess(submitted());
  const saved = h.store.get(key);
  const record = JSON.parse(saved);
  assert.deepEqual(record.user_data, {
    sha256_email_address: digest('caseyexample+quote@gmail.com'),
    sha256_phone_number: digest('+12025550144')
  });
  assert(!saved.includes('@') && !saved.includes('202-555-0144'));
  assert.equal(h.conversions().length, 0);
});

test('thank-you consumption queues user data first, preserves the Ads action/value and records once', async () => {
  const h = harness();
  await h.api.recordSuccess(submitted());
  const record = JSON.parse(h.store.get(key));
  await h.api.consumePending();
  assert.equal(h.calls[0][0], 'set');
  assert.equal(h.calls[0][1], 'user_data');
  assert.deepEqual(clone(h.calls[0][2]), record.user_data);
  const conversion = h.conversions()[0][2];
  assert.equal(conversion.send_to, 'AW-18201677678/lDv9CPaPzPIcEO6enudD');
  assert.equal(conversion.value, 175);
  assert.equal(conversion.currency, 'USD');
  assert.equal(conversion.transaction_id, record.submission_id);
  assert(!h.store.has(key));
  h.api.consumePending();
  const refresh = harness({ store: h.store });
  refresh.api.consumePending();
  assert.equal(h.conversions().length, 1);
  assert.equal(refresh.conversions().length, 0);
});

test('direct visits do not track; distinct successful submissions remain distinct leads', async () => {
  const h = harness();
  h.api.consumePending();
  assert.equal(h.conversions().length, 0);
  for(let n = 0; n < 2; n++) {
    await h.api.recordSuccess(submitted());
    await h.api.consumePending();
  }
  assert.equal(h.conversions().length, 2);
  assert.notEqual(h.conversions()[0][2].transaction_id, h.conversions()[1][2].transaction_id);
});

test('Formspree must confirm success; double submits are ignored and the original submitted snapshot is hashed', async () => {
  let respond, sent, requestCount = 0;
  const h = harness({ fetch(url, options) {
    requestCount++;
    assert.equal(url, 'https://formspree.io/f/mqpkgjlp');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Accept, 'application/json');
    sent = options.body;
    return new Promise(resolve => { respond = resolve; });
  } });
  h.installForm();
  h.submit(); h.submit();
  assert.equal(requestCount, 1);
  assert.equal(h.store.size, 0);
  assert.equal(h.conversions().length, 0);
  assert.equal(h.window.location.href, undefined);
  assert.equal(sent.get('phone'), '202-555-0144');
  h.fields.set('email', 'changed@example.com');
  respond({ ok: true });
  await waitFor(() => h.window.location.href === '/thanks.html');
  assert.equal(JSON.parse(h.store.get(key)).user_data.sha256_email_address,
    digest('caseyexample+quote@gmail.com'));
});

for(const kind of ['HTTP rejection', 'network failure', 'non-JSON error response']) {
  test(kind + ' restores the form and leaves no conversion or stale success record', async () => {
    const h = harness({ fetch: async () => {
      if(kind === 'network failure') throw new Error('Network failed');
      return { ok: false, json: async () => {
        if(kind === 'non-JSON error response') throw new SyntaxError('Invalid JSON');
        return { errors: [{ message: 'Rejected' }] };
      } };
    } });
    await h.api.recordSuccess(submitted());
    h.installForm(); h.submit();
    await waitFor(() => !h.elements.quoteSubmit.disabled);
    assert.equal(h.elements.quoteSubmit.textContent, 'Send project');
    assert.equal(h.elements.quoteError.style.display, 'block');
    assert.match(h.elements.quoteError.textContent, /818-835-2552/);
    assert.equal(h.window.location.href, undefined);
    assert.equal(h.store.size, 0);
    h.api.consumePending();
    assert.equal(h.conversions().length, 0);
  });
}

for(const storageMode of ['blocked', 'full']) {
  test(storageMode + ' storage tracks on the successful form response, then redirects without replay', async () => {
    const h = harness({ storageMode, fetch: async () => ({ ok: true }) });
    h.installForm(); h.submit();
    await waitFor(() => h.window.location.href === '/thanks.html');
    assert.equal(h.conversions().length, 1);
    assert.equal(h.conversions()[0][2].value, 175);
    assert.equal(h.calls[0][2].sha256_phone_number, digest('+12025550144'));
    h.api.consumePending();
    assert.equal(h.conversions().length, 1);
  });
}

test('malformed, expired and future records are consumed without conversion', async () => {
  const h = harness();
  await h.api.recordSuccess(submitted());
  const valid = JSON.parse(h.store.get(key));
  const invalid = [
    'bad JSON', 'null',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, submitted_at: Date.now() - 31 * 60 * 1000 }),
    JSON.stringify({ ...valid, submitted_at: Date.now() + 60 * 1000 }),
    JSON.stringify({ ...valid, submitted_at: 'yesterday' })
  ];
  for(const record of invalid) {
    h.store.set(key, record);
    h.api.consumePending();
    assert.equal(h.conversions().length, 0);
    assert(!h.store.has(key));
  }
});

test('unexpected stored contact fields are never forwarded to Google', async () => {
  const h = harness();
  await h.api.recordSuccess(submitted());
  const record = JSON.parse(h.store.get(key));
  record.user_data = { email: 'raw@example.com', phone_number: '2025550144', sha256_email_address: 'raw' };
  h.store.set(key, JSON.stringify(record));
  await h.api.consumePending();
  assert.deepEqual(clone(h.calls[0][2]), {});
});

test('missing Web Crypto preserves standard conversion tracking without storing raw data', async () => {
  const h = harness({ crypto: null });
  await h.api.recordSuccess(submitted());
  assert.deepEqual(JSON.parse(h.store.get(key)).user_data, {});
  await h.api.consumePending();
  assert.equal(h.conversions().length, 1);
});

test('tracking failure cannot break an accepted submission', async () => {
  const h = harness({ storageMode: 'blocked', fetch: async () => ({ ok: true }) });
  h.window.gtag = () => { throw new Error('Tag unavailable'); };
  h.installForm(); h.submit();
  await waitFor(() => h.window.location.href === '/thanks.html');
  assert.equal(h.elements.quoteError.style.display, 'none');
});

test('the quote form still submits and redirects if the tracking helper fails to load', async () => {
  const h = harness({ fetch: async () => ({ ok: true }) });
  delete h.window.PermitBoostConversions;
  h.installForm(); h.submit();
  await waitFor(() => h.window.location.href === '/thanks.html');
  assert.equal(h.conversions().length, 0);
});

test('hashing failure never exposes raw data or prevents ordinary conversion tracking', async () => {
  const h = harness({ crypto: { subtle: { digest: async () => { throw new Error('Hash failed'); } } } });
  await h.api.recordSuccess(submitted());
  assert.deepEqual(JSON.parse(h.store.get(key)).user_data, {});
  await h.api.consumePending();
  assert.equal(h.conversions().length, 1);
});

test('a customer can retry a rejected submission and record only the successful attempt', async () => {
  let attempts = 0;
  const h = harness({ fetch: async () => ({ ok: ++attempts === 2, json: async () => ({}) }) });
  h.installForm(); h.submit();
  await waitFor(() => !h.elements.quoteSubmit.disabled);
  h.submit();
  await waitFor(() => h.window.location.href === '/thanks.html');
  await h.api.consumePending();
  assert.equal(attempts, 2);
  assert.equal(h.conversions().length, 1);
});
