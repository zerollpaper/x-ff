import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createAutoImporter, isExportFile } from '../src/autoimport.js';
import { Store } from '../src/store.js';

// 本物のエクスポートは個人データなので、架空のアカウントで書く
const name = (kind, date, owner = 'me', time = '12-00-00') => `XPorter_${kind}_${owner}_exported_${date}-at-${time}.json`;
const body = (ids) => JSON.stringify(ids.map((i) => ({ id: String(i), username: `user${i}` })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xff-auto-'));
  const store = new Store(':memory:', { now: () => new Date('2026-02-01T00:00:00Z') });
  const put = (file, ids) => writeFileSync(join(dir, file), typeof ids === 'string' ? ids : body(ids));
  const ai = createAutoImporter(store, { dir, log: () => {} });
  return { dir, store, put, ai };
}

describe('ダウンロードフォルダの自動取り込み', () => {
  it('対象は xporter の JSON の名前だけ', () => {
    assert.ok(isExportFile(name('following', '2026-01-01')));
    assert.ok(isExportFile('XPorter_followers_me_exported_2026-01-01-at-12-00-00 (1).json'));
    assert.ok(!isExportFile('XPorter_following_me_exported_2026-01-01-at-12-00-00.csv'));
    assert.ok(!isExportFile('XPorter_following_me_exported_2026-01-01-at-12-00-00.json.crdownload'));
    assert.ok(!isExportFile('report.json'));
  });

  it('新しいファイルを取り込み、同じファイルは二度取り込まない', () => {
    const { store, put, ai } = setup();
    put(name('following', '2026-01-01'), [1, 2]);
    const r = ai.handle(name('following', '2026-01-01'));
    assert.equal(r.count, 2);
    assert.equal(store.listSnapshots().length, 1);
    assert.equal(ai.handle(name('following', '2026-01-01')), null);
    assert.equal(ai.status().last.filename, name('following', '2026-01-01'));
  });

  it('起動時は、取り込み済みより新しいファイルだけを古い順に取り込む', () => {
    const { store, put, ai } = setup();
    put(name('following', '2026-01-05'), [1, 2]);
    store.importExport({ filename: name('following', '2026-01-05'), content: body([1, 2]) });
    put(name('following', '2026-01-01'), [1]); // 取り込み済みより古い
    put(name('following', '2026-01-09'), [1, 2, 3]);
    put(name('following', '2026-01-07'), [1, 2]);
    put('memo.json', '[]');
    const results = ai.scan();
    assert.deepEqual(results.map((r) => r.filename), [name('following', '2026-01-07'), name('following', '2026-01-09')]);
    assert.deepEqual(store.listSnapshots().map((s) => s.taken_at.slice(0, 10)).sort(), ['2026-01-05', '2026-01-07', '2026-01-09']);
    // 古いファイルは取り込まず、次の起動でも見ない
    assert.equal(ai.scan().length, 0);
    assert.equal(ai.handle(name('following', '2026-01-01')), null);
  });

  it('取り込みの記録をわざと消しても、同じファイルを取り込み直さない', () => {
    const { store, put, ai } = setup();
    put(name('following', '2026-01-01'), [1]);
    ai.scan();
    store.deleteSnapshot(store.listSnapshots()[0].id);
    assert.equal(ai.scan().length, 0);
    assert.equal(store.listSnapshots().length, 0);
  });

  it('書き込み途中で読めないファイルは、覚えずにあとで読み直す', () => {
    const { store, put, ai } = setup();
    put(name('followers', '2026-01-01'), '[{"id":');
    assert.equal(ai.handle(name('followers', '2026-01-01')).retry, true);
    put(name('followers', '2026-01-01'), [1]);
    assert.equal(ai.handle(name('followers', '2026-01-01')).count, 1);
    assert.equal(store.listSnapshots().length, 1);
  });

  it('別のアカウントのファイルは取り込まず、理由を残す', () => {
    const { store, put, ai } = setup();
    put(name('following', '2026-01-01'), [1]);
    ai.handle(name('following', '2026-01-01'));
    put(name('following', '2026-01-02', 'someone'), [1]);
    const r = ai.handle(name('following', '2026-01-02', 'someone'));
    assert.ok(r.error);
    assert.equal(store.listSnapshots().length, 1);
    assert.equal(ai.handle(name('following', '2026-01-02', 'someone')), null);
  });

  it('フォルダが読めないときは、状態にエラーを出して止まらない', () => {
    const store = new Store(':memory:');
    const ai = createAutoImporter(store, { dir: join(tmpdir(), 'xff-no-such-dir-zzz'), log: () => {} });
    assert.deepEqual(ai.scan(), []);
    assert.match(ai.status().error, /見つかりません/);
  });
});
