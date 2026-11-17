import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, hostAllowed, loadToken } from '../src/server.js';
import { Store } from '../src/store.js';

let server;
let base;
before(async () => {
  server = createServer(createApp(new Store(':memory:')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('サーバー', () => {
  it('画面を返す', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<title>x-ff<\/title>/);
  });

  it('自動取り込みを使っていないときは、状態として enabled: false を返す', async () => {
    const r = await (await fetch(`${base}/api/autoimport`)).json();
    assert.equal(r.enabled, false);
  });

  it('public の外のファイルは返さない', async () => {
    const r = await fetch(`${base}/%2e%2e/package.json`);
    assert.notEqual(r.status, 200);
  });

  it('JSON 以外の POST は断る（ほかのサイトからの送信よけ）', async () => {
    const r = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(r.status, 400);
  });

  it('取り込み → 一覧 → 状態の変更ができる', async () => {
    const files = [
      { filename: 'XPorter_followers_me_exported_2026-01-01-at-12-00-00.json', content: JSON.stringify([{ id: '1', username: 'a' }]) },
      { filename: 'XPorter_following_me_exported_2026-01-01-at-12-00-00.json', content: JSON.stringify([{ id: '1', username: 'a' }, { id: '2', username: 'b' }]) },
      { filename: 'broken.json', content: '[]' },
    ];
    const imp = await (await post('/api/import', { files })).json();
    assert.equal(imp.results.filter((r) => r.error).length, 1);
    assert.equal(imp.results.filter((r) => r.count).length, 2);
    let list = await (await fetch(`${base}/api/accounts`)).json();
    assert.deepEqual(list.filter((a) => a.candidate).map((a) => a.id), ['2']);
    assert.equal((await post('/api/accounts/status', { ids: ['2'], status: 'protected' })).status, 200);
    list = await (await fetch(`${base}/api/accounts`)).json();
    assert.equal(list.filter((a) => a.candidate).length, 0);
    const bad = await post('/api/accounts/status', { ids: ['2'], status: 'nope' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /状態の値/);
    assert.equal((await post('/api/accounts/kind', { ids: ['2'], kind: 'official' })).status, 200);
    list = await (await fetch(`${base}/api/accounts`)).json();
    assert.equal(list.find((a) => a.id === '2').kind, 'official');
    assert.equal((await post('/api/accounts/kind', { ids: ['2'], kind: 'nope' })).status, 400);
  });
});

describe('スマホなどほかの端末からの接続', () => {
  let remote;
  let rbase;
  const TOKEN = 'secret-token-123';
  before(async () => {
    remote = createServer(createApp(new Store(':memory:'), { token: TOKEN, isLocal: () => false }));
    await new Promise((r) => remote.listen(0, '127.0.0.1', r));
    rbase = `http://127.0.0.1:${remote.address().port}`;
  });
  after(() => remote.close());

  it('画面のファイルは合言葉なしで返す', async () => {
    assert.equal((await fetch(`${rbase}/`)).status, 200);
    assert.equal((await fetch(`${rbase}/app.js`)).status, 200);
  });

  it('データは合言葉がないと返さない', async () => {
    const r = await fetch(`${rbase}/api/accounts`);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).needToken, true);
    assert.equal((await fetch(`${rbase}/api/accounts`, { headers: { 'x-xff-token': 'wrong' } })).status, 403);
  });

  it('合言葉があれば読み書きできる', async () => {
    const h = { 'x-xff-token': TOKEN };
    assert.equal((await fetch(`${rbase}/api/accounts`, { headers: h })).status, 200);
    const r = await fetch(`${rbase}/api/settings`, {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ grace_days: 10 }),
    });
    assert.equal(r.status, 200);
  });

  it('ほかのサイトのページからの書き込みは断る', async () => {
    const r = await fetch(`${rbase}/api/settings`, {
      method: 'POST',
      headers: { 'x-xff-token': TOKEN, 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ grace_days: 10 }),
    });
    assert.equal(r.status, 403);
  });

  it('スマホ用のアドレスは、ほかの端末には教えない', async () => {
    const r = await fetch(`${rbase}/api/lan-url`, { headers: { 'x-xff-token': TOKEN } });
    assert.equal(r.status, 403);
  });
});

describe('ホスト名とスマホ用アドレス', () => {
  it('localhost・IP・.local だけ受け付ける', () => {
    for (const h of ['localhost:4870', '127.0.0.1:4870', '192.168.1.5:4870', 'mac.local:4870', '[::1]:4870']) {
      assert.equal(hostAllowed(h), true, h);
    }
    for (const h of ['evil.example', 'evil.example:4870', '']) assert.equal(hostAllowed(h), false, h);
  });

  it('この Mac からは、合言葉付きのアドレスがもらえる', async () => {
    const s = createServer(createApp(new Store(':memory:'), { token: 'tkn', port: 4870 }));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const r = await (await fetch(`http://127.0.0.1:${s.address().port}/api/lan-url`)).json();
    s.close();
    assert.ok(r.urls.length > 0);
    assert.ok(r.urls.every((u) => /^http:\/\/[^/]+:4870\/\?token=tkn$/.test(u)));
  });

  it('合言葉のファイルを作り、次からは同じものを使う', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xff-'));
    const f = join(dir, 'sub', '.lan-token');
    const t = loadToken(f);
    assert.match(t, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(loadToken(f), t);
    assert.equal(statSync(f).mode & 0o777, 0o600);
  });
});
