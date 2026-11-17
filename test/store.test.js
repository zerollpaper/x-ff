import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseExportFilename, Store, UserError } from '../src/store.js';

const DAY = 24 * 60 * 60 * 1000;

// 本物のエクスポートは個人データなので、テストでは架空のアカウントを作る
function acct(id, extra = {}) {
  return { id: String(id), username: `user${id}`, name: `User ${id}`, bio: '', followers_count: 1, ...extra };
}
function file(kind, date, owner = 'me') {
  const [y, mo, d] = date.split('-');
  return `XPorter_${kind}_${owner}_exported_${y}-${mo}-${d}-at-12-00-00.json`;
}
function setup(start = '2026-01-01T00:00:00') {
  let t = new Date(start).getTime();
  const store = new Store(':memory:', { now: () => new Date(t) });
  return {
    store,
    advance: (days) => { t += days * DAY; },
    imp: (kind, date, ids, owner) =>
      store.importExport({ filename: file(kind, date, owner), content: JSON.stringify(ids.map((i) => acct(i))) }),
    get: (id) => store.listAccounts().find((a) => a.id === String(id)),
  };
}

describe('ファイル名の読み取り', () => {
  it('種類・持ち主・日時を読む', () => {
    const r = parseExportFilename('/x/XPorter_followers_demo_user_exported_2026-11-17-at-16-34-56.json');
    assert.equal(r.kind, 'followers');
    assert.equal(r.owner, 'demo_user');
    assert.equal(r.takenAt, new Date(2026, 10, 17, 16, 34, 56).toISOString());
  });
  it('ブラウザが付ける (1) は許す', () => {
    assert.equal(parseExportFilename('XPorter_following_a_exported_2026-11-17-at-16-34-56 (1).json').kind, 'following');
  });
  it('CSV や名前を変えたファイルは断る', () => {
    assert.throws(() => parseExportFilename('XPorter_following_a_exported_2026-11-17-at-16-34-56.csv'), UserError);
    assert.throws(() => parseExportFilename('following.json'), UserError);
  });
});

describe('取り込み', () => {
  it('初回は記録開始前からのフォローとして扱い、猶予期間は最初の取り込みから数える', () => {
    const { store, imp, get, advance } = setup('2026-01-01T12:00:00');
    imp('following', '2026-01-01', [1, 2, 3]);
    imp('followers', '2026-01-01', [1, 9]);
    assert.equal(get(1).mutual, true);
    assert.equal(get(2).followingSince, null);
    // 記録を始めたばかりなので、まだ候補に出さない
    assert.equal(get(2).candidate, false);
    assert.equal(get(2).graceLeft, 14);
    advance(14);
    assert.equal(get(2).candidate, true);
    assert.equal(get(1).candidate, false);
    assert.equal(get(9).follower && !get(9).following, true);
    const s = store.summary();
    assert.deepEqual(
      [s.counts.mutual, s.counts.oneSided, s.counts.notFollowedBack, s.counts.candidates],
      [1, 2, 1, 2],
    );
  });

  it('フォロワーを取り込むまではフォローのみを判定しない', () => {
    const { imp, get } = setup();
    imp('following', '2026-01-01', [1]);
    assert.equal(get(1).candidate, false);
  });

  it('同じファイルは二重に取り込まない', () => {
    const { imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.equal(imp('following', '2026-01-01', [1, 2]).duplicate, true);
  });

  it('別アカウントのファイルは断る', () => {
    const { imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => imp('followers', '2026-01-01', [1], 'other'), /別のアカウント/);
  });

  it('id が数値（桁が丸められる形）のファイルは断る', () => {
    const { store } = setup();
    assert.throws(
      () => store.importExport({ filename: file('following', '2026-01-01'), content: '[{"id": 123, "username": "a"}]' }),
      /文字列の数字/,
    );
  });

  it('大きく減った取り込みには警告を付ける', () => {
    const { imp } = setup();
    imp('followers', '2026-01-01', [1, 2, 3, 4, 5]);
    const r = imp('followers', '2026-01-02', [1, 2, 3]);
    assert.equal(r.removed, 2);
    assert.match(r.warning, /2 件減って/);
    assert.equal(imp('followers', '2026-01-03', [1, 2, 3, 6]).warning, undefined);
  });

  it('プロフィールは新しい取り込みの内容だけで上書きする', () => {
    const { store, get } = setup();
    const imp = (date, name) =>
      store.importExport({ filename: file('following', date), content: JSON.stringify([acct(1, { name })]) });
    imp('2026-01-05', '新');
    imp('2026-01-01', '旧');
    assert.equal(get(1).name, '新');
  });

  it('取り込む順番が前後しても、同じ結果になる', () => {
    const a = setup();
    a.imp('following', '2026-01-01', [1, 2]);
    a.imp('following', '2026-01-10', [2, 3]);
    const b = setup();
    b.imp('following', '2026-01-10', [2, 3]);
    b.imp('following', '2026-01-01', [1, 2]);
    const pick = (s) => s.store.listAccounts().map((x) => [x.id, x.following, x.followingSince, x.unfollowedAt]);
    assert.deepEqual(pick(a), pick(b));
  });
});

describe('猶予期間と状態', () => {
  it('新しくフォローした人は猶予期間が過ぎるまで候補にしない', () => {
    const { store, imp, get, advance } = setup('2026-01-01T12:00:00');
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    imp('following', '2026-01-02', [1, 2]);
    advance(1);
    assert.equal(get(2).candidate, false);
    assert.equal(get(2).graceLeft, 14);
    advance(14);
    assert.equal(get(2).candidate, true);
    store.updateSettings({ grace_days: 30 });
    assert.equal(get(2).candidate, false);
    assert.equal(get(2).graceLeft, 16);
  });

  it('保護とゆるく保持は候補から外れる', () => {
    const { store, imp, get, advance } = setup();
    imp('following', '2026-01-01', [1, 2, 3]);
    imp('followers', '2026-01-01', []);
    advance(15);
    store.setStatus(['1'], 'protected');
    store.setStatus(['2'], 'loose');
    assert.deepEqual(store.listAccounts().filter((a) => a.candidate).map((a) => a.id), ['3']);
    assert.equal(get(1).status, 'protected');
  });

  it('ゆるく保持は見直し期間がたつと見直しに出て、もう一度ゆるく保持を押すと延びる', () => {
    const { store, imp, get, advance } = setup();
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    store.setStatus(['1'], 'loose');
    assert.equal(get(1).reviewDue, false);
    advance(90);
    assert.equal(get(1).reviewDue, true);
    store.setStatus(['1'], 'loose');
    assert.equal(get(1).reviewDue, false);
    assert.equal(get(1).reviewLeft, 90);
    // 見直しでフォロバ待ちにすると、猶予期間が始まる（すぐには整理候補に出ない）
    store.setStatus(['1'], 'waiting');
    assert.equal(get(1).candidate, false);
    assert.equal(get(1).graceLeft, 14);
  });

  it('ゆるく保持のまま状態を付け直しても、見直しの日付は変わらない', () => {
    const { store, imp, get, advance } = setup();
    imp('following', '2026-01-01', [1]);
    store.setStatus(['1'], 'loose');
    const first = get(1).reviewed_at;
    advance(3);
    store.setStatus(['1'], 'loose');
    assert.equal(get(1).reviewed_at, first);
  });

  it('知らない状態の値は断る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => store.setStatus(['1'], 'keep'), UserError);
  });

  it('設定の値を確かめる', () => {
    const { store } = setup();
    assert.throws(() => store.updateSettings({ grace_days: -1 }), UserError);
    assert.throws(() => store.updateSettings({ review_days: 1.5 }), UserError);
    assert.deepEqual(store.updateSettings({ grace_days: '7' }), { grace_days: 7, review_days: 90, ff_low: 80, ff_high: 125 });
    // FF比の幅は 100% をはさむ。1つでも範囲の外なら、ほかの値も保存しない
    assert.throws(() => store.updateSettings({ ff_low: 120 }), UserError);
    assert.throws(() => store.updateSettings({ ff_high: 90 }), UserError);
    assert.throws(() => store.updateSettings({ grace_days: 3, ff_low: 0 }), UserError);
    assert.equal(store.getSettings().grace_days, 7);
  });
});

describe('自分のアイコン', () => {
  it('X のアイコンのアドレスだけを保存し、空にすると消す', () => {
    const { store } = setup();
    const url = 'https://pbs.twimg.com/profile_images/123/abc_400x400.jpg';
    assert.equal(store.summary().ownerIcon, null);
    store.setOwnerIcon(` ${url} `);
    assert.equal(store.summary().ownerIcon, url);
    assert.throws(() => store.setOwnerIcon('https://example.com/a.jpg'), UserError);
    assert.throws(() => store.setOwnerIcon('javascript:alert(1)'), UserError);
    assert.throws(() => store.setOwnerIcon('https://pbs.twimg.com/profile_images/1/a.jpg?x="y"'), UserError);
    assert.equal(store.getOwnerIcon(), url);
    store.setOwnerIcon('');
    assert.equal(store.getOwnerIcon(), null);
  });
});

describe('FF比', () => {
  function ffSetup() {
    const { store, get } = setup();
    const accts = [
      acct(1, { followers_count: 300, following_count: 100 }), // 300%
      acct(2, { followers_count: 110, following_count: 100 }), // 110%
      acct(3, { followers_count: 50, following_count: 100 }), // 50%
      acct(4, { followers_count: 10, following_count: 0 }), // フォロー 0
    ];
    store.importExport({ filename: file('following', '2026-01-01'), content: JSON.stringify(accts) });
    return { store, get };
  }

  it('フォロワー ÷ フォローを % で出し、設定の幅の外だけ多い・少ないを付ける', () => {
    const { get } = ffSetup();
    assert.equal(get(1).ffRatio, 300);
    assert.equal(get(1).ffSide, 'more');
    assert.equal(get(2).ffRatio, 110);
    assert.equal(get(2).ffSide, null);
    assert.equal(get(3).ffSide, 'less');
    assert.equal(get(4).ffRatio, null);
    assert.equal(get(4).ffSide, null);
  });

  it('幅を変えると判定も変わる', () => {
    const { store, get } = ffSetup();
    store.updateSettings({ ff_low: 40, ff_high: 105 });
    assert.equal(get(2).ffSide, 'more');
    assert.equal(get(3).ffSide, null);
  });
});

describe('種類（有名人・公式・一般）', () => {
  it('付けた種類が一覧に出て、null で未設定に戻せる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2, 3]);
    assert.equal(get(1).kind, null);
    store.setKind(['1', '2'], 'celebrity');
    store.setKind(['3'], 'general');
    assert.deepEqual([get(1).kind, get(2).kind, get(3).kind], ['celebrity', 'celebrity', 'general']);
    store.setKind(['2'], 'official');
    store.setKind(['1'], null);
    assert.deepEqual([get(1).kind, get(2).kind], [null, 'official']);
  });

  it('有名人・公式・メディアは整理候補に出さず、一般と未設定は出す', () => {
    const { store, imp, get, advance } = setup();
    imp('following', '2026-01-01', [1, 2, 3, 4]);
    imp('followers', '2026-01-01', []);
    advance(15);
    store.setKind(['1'], 'celebrity');
    store.setKind(['2'], 'official');
    store.setKind(['3'], 'general');
    assert.deepEqual([1, 2, 3, 4].map((i) => get(i).candidate), [false, false, true, true]);
    assert.deepEqual([1, 2, 3, 4].map((i) => get(i).expectsFollowBack), [false, false, true, true]);
    // 一般に変えれば候補に戻る
    store.setKind(['1'], 'general');
    assert.equal(get(1).candidate, true);
  });

  it('発信者も整理候補に出さない', () => {
    const { store, imp, get, advance } = setup();
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    advance(15);
    store.setKind(['1'], 'creator');
    assert.equal(get(1).kind, 'creator');
    assert.equal(get(1).candidate, false);
  });

  it('種類の値が3つだった頃のデータベースも、値を残したまま発信者を付けられるようにする', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    store.setKind(['1'], 'official');
    // 古い形（発信者がない CHECK）に作り直す
    store.db.exec('ALTER TABLE accounts DROP COLUMN kind');
    store.db.exec("ALTER TABLE accounts ADD COLUMN kind TEXT CHECK (kind IN ('celebrity', 'official', 'general'))");
    store.db.exec("UPDATE accounts SET kind = 'official' WHERE id = '1'");
    assert.throws(() => store.setKind(['2'], 'creator'));
    store.migrate();
    store.setKind(['2'], 'creator');
    assert.deepEqual([get(1).kind, get(2).kind], ['official', 'creator']);
    assert.throws(() => store.setKind(['2'], 'fan'), UserError);
    assert.throws(() => store.db.exec("UPDATE accounts SET kind = 'fan' WHERE id = '2'"));
  });

  it('決まった値以外は断る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => store.setKind(['1'], 'fan'), UserError);
  });

  it('種類は状態とは別に持つ（状態を変えても消えない）', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1]);
    store.setKind(['1'], 'celebrity');
    store.setStatus(['1'], 'protected');
    assert.equal(get(1).kind, 'celebrity');
    assert.equal(get(1).status, 'protected');
  });

  it('種類の列がない古いデータベースにも列を足す', () => {
    const { store } = setup();
    store.db.exec('ALTER TABLE accounts DROP COLUMN kind');
    store.migrate();
    assert.ok(store.db.prepare('PRAGMA table_info(accounts)').all().some((c) => c.name === 'kind'));
  });
});

describe('整理候補の「まだ待つ」', () => {
  it('整理候補でもう一度フォロバ待ちを押すと、猶予期間をそこから数え直す', () => {
    const { store, imp, get, advance } = setup('2026-01-01T12:00:00');
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    advance(15);
    assert.equal(get(1).candidate, true);
    store.setStatus(['1'], 'waiting');
    assert.deepEqual([get(1).candidate, get(1).graceLeft], [false, 14]);
    advance(14);
    assert.equal(get(1).candidate, true);
  });

  it('候補でない人にフォロバ待ちを押しても、猶予期間は変わらない', () => {
    const { store, imp, get, advance } = setup('2026-01-01T12:00:00');
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    advance(5);
    store.setStatus(['1'], 'waiting');
    assert.equal(get(1).graceLeft, 9);
  });

  it('見直しからフォロバ待ちにすると、まだ待つと同じく猶予期間が始まる', () => {
    const { store, imp, get, advance } = setup('2026-01-01T12:00:00');
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', []);
    store.setStatus(['1'], 'loose');
    advance(91);
    assert.equal(get(1).reviewDue, true);
    store.setStatus(['1'], 'waiting');
    assert.deepEqual([get(1).candidate, get(1).reviewDue, get(1).graceLeft], [false, false, 14]);
    advance(14);
    assert.equal(get(1).candidate, true);
  });

  it('相互が外れた人も「まだ待つ」で待てて、また外されたらすぐ候補に戻る', () => {
    const { store, imp, get, advance } = setup('2026-01-03T00:00:00');
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', [1]);
    imp('followers', '2026-01-02', []);
    assert.equal(get(1).candidate, true);
    store.setStatus(['1'], 'waiting');
    assert.equal(get(1).candidate, false);
    // また返してもらって、また外された
    advance(3);
    imp('followers', '2026-01-04', [1]);
    imp('followers', '2026-01-05', []);
    assert.equal(get(1).candidate, true);
  });
});

describe('未入力', () => {
  it('フォロー中で種類かタグがない人が出て、両方付けるといなくなる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    imp('followers', '2026-01-01', [3]);
    assert.deepEqual([1, 2, 3].map((i) => get(i).unsorted), [true, true, false]);
    store.setKind(['1'], 'general');
    assert.equal(get(1).unsorted, true);
    store.editTags(['1'], { add: ['野球'] });
    assert.equal(get(1).unsorted, false);
    store.editTags(['2'], { add: ['野球'] });
    assert.equal(get(2).unsorted, true);
    assert.equal(store.summary().counts.unsorted, 1);
  });
});

describe('同じ人かも', () => {
  it('自己紹介で相手の ID に触れていれば、両方に相手を出す。まとめたら出さない', () => {
    const { store } = setup();
    store.importExport({
      filename: file('following', '2026-01-01'),
      content: JSON.stringify([
        acct(1, { username: 'main_x', bio: '' }),
        acct(2, { username: 'sub_x', bio: '本垢→@Main_X' }),
        acct(3, { username: 'other', bio: 'よろしく' }),
      ]),
    });
    const m = (id) => store.listAccounts().find((a) => a.id === String(id)).maybeSame.map((p) => p.username);
    assert.deepEqual([m(1), m(2), m(3)], [['sub_x'], ['main_x'], []]);
    store.linkAccounts('1', ['2']);
    assert.deepEqual([m(1), m(2)], [[], []]);
  });
});

describe('同じ人かも（リンク）と本垢からの貼り付け', () => {
  it('プロフィールのリンク先が同じなら同じ人かもに出す。だれでも同じになるリンクは比べない', () => {
    const { store } = setup();
    store.importExport({
      filename: file('following', '2026-01-01'),
      content: JSON.stringify([
        acct(1, { username: 'a1', url: 'https://lit.link/someone' }),
        acct(2, { username: 'a2', url: 'http://www.lit.link/someone/?utm=x' }),
        acct(3, { username: 'a3', url: 'https://instagram.com' }),
        acct(4, { username: 'a4', url: 'https://instagram.com/' }),
      ]),
    });
    const m = (id) => store.listAccounts().find((a) => a.id === String(id)).maybeSame.map((p) => p.username);
    assert.deepEqual([m(1), m(2), m(3), m(4)], [['a2'], ['a1'], [], []]);
  });

  it('サブ垢に本垢の種類とタグを貼り付けると入力済みになり、サブ垢のタグは残る', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    store.setKind(['1'], 'celebrity');
    store.editTags(['1'], { add: ['野球', '音楽'] });
    store.editTags(['2'], { add: ['漫画'] });
    store.linkAccounts('1', ['2']);
    store.copyFromMain('2');
    assert.equal(get(2).kind, 'celebrity');
    assert.deepEqual([...get(2).tags].sort(), ['漫画', '野球', '音楽'].sort());
    assert.equal(get(2).unsorted, false);
    assert.throws(() => store.copyFromMain('1'), UserError);
  });
});

describe('外した人の一覧から消す', () => {
  it('外した人から消すと出なくなり、また外したらもう一度出る', () => {
    const { store, imp, get, advance } = setup('2026-01-03T00:00:00');
    imp('following', '2026-01-01', [1, 2]);
    imp('following', '2026-01-02', [2]);
    assert.equal(get(1).unfollowed, true);
    store.dismissFromList(['1'], 'unfollowed');
    assert.deepEqual([get(1).unfollowed, get(1).unfollowedDismissed], [false, true]);
    assert.equal(store.summary().counts.unfollowed, 0);
    advance(5);
    imp('following', '2026-01-06', [1, 2]);
    imp('following', '2026-01-07', [2]);
    assert.equal(get(1).unfollowed, true);
  });

  it('決まった一覧以外は断る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => store.dismissFromList(['1'], 'followers'), UserError);
    // 整理候補には「消す」を作らない（状態ボタンで外す）
    assert.throws(() => store.dismissFromList(['1'], 'candidates'), UserError);
  });
});

describe('同じ人の複数アカウント', () => {
  const mainOf = (s, id) => s.listAccounts().find((a) => a.id === String(id)).main_id;

  it('サブ垢は本垢の id を持ち、本垢は null', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1, 2, 3, 4]);
    store.linkAccounts('1', ['2', '3']);
    assert.deepEqual([1, 2, 3, 4].map((i) => mainOf(store, i)), [null, '1', '1', null]);
  });

  it('組をまたいでまとめると、全員が新しい本垢の下に入り、サブ垢のサブ垢はできない', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1, 2, 3, 4, 5]);
    store.linkAccounts('1', ['2']);
    store.linkAccounts('3', ['4']);
    store.linkAccounts('5', ['2', '3']);
    assert.deepEqual([1, 2, 3, 4, 5].map((i) => mainOf(store, i)), ['5', '5', '5', '5', null]);
  });

  it('本垢を入れ替えられる', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1, 2, 3]);
    store.linkAccounts('1', ['2', '3']);
    store.setMainAccount('2');
    assert.deepEqual([1, 2, 3].map((i) => mainOf(store, i)), ['2', null, '2']);
  });

  it('サブ垢を分けるとそのアカウントだけ外れ、本垢を分けると組がばらける', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1, 2, 3]);
    store.linkAccounts('1', ['2', '3']);
    store.unlinkAccounts(['3']);
    assert.deepEqual([1, 2, 3].map((i) => mainOf(store, i)), [null, '1', null]);
    store.linkAccounts('1', ['3']);
    store.unlinkAccounts(['1']);
    assert.deepEqual([1, 2, 3].map((i) => mainOf(store, i)), [null, null, null]);
  });

  it('1つだけ・存在しないアカウントは断る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => store.linkAccounts('1', ['1']), UserError);
    assert.throws(() => store.linkAccounts('1', ['9']), UserError);
  });

  it('本垢の記録が消えると、サブ垢は独立したアカウントに戻る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1, 2]);
    store.linkAccounts('1', ['2']);
    store.db.prepare('DELETE FROM accounts WHERE id = ?').run('1');
    assert.equal(mainOf(store, 2), null);
  });
});

describe('関係の変化', () => {
  it('相互だった人に外されると「相互が外れた」として候補に入る', () => {
    const { imp, get } = setup();
    imp('following', '2026-01-01', [1]);
    imp('followers', '2026-01-01', [1]);
    imp('followers', '2026-01-05', []);
    const a = get(1);
    assert.equal(a.mutualBroken, true);
    assert.equal(a.candidate, true);
    assert.equal(a.followerLostAt, new Date(2026, 0, 5, 12).toISOString());
  });

  it('外した人は記録が残り、再フォローすると猶予期間が数え直しになる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    imp('followers', '2026-01-01', []);
    store.editTags(['1'], { add: ['野球'] });
    imp('following', '2026-01-03', [2]);
    let a = get(1);
    assert.equal(a.following, false);
    assert.equal(a.everFollowing, true);
    assert.equal(a.unfollowedAt, new Date(2026, 0, 3, 12).toISOString());
    assert.deepEqual(a.tags, ['野球']);
    imp('following', '2026-01-04', [1, 2]);
    a = get(1);
    assert.equal(a.following, true);
    assert.equal(a.followingSince, new Date(2026, 0, 4, 12).toISOString());
    assert.equal(a.unfollowedAt, null);
  });

  it('古い記録の削除は、フォローもフォロワーも外れて日数がたった人だけを消す', () => {
    const { store, imp, get, advance } = setup('2026-01-03T12:00:00');
    imp('following', '2026-01-01', [1, 2, 3]);
    imp('followers', '2026-01-01', [3]);
    imp('following', '2026-01-03', [2]);
    imp('followers', '2026-01-03', []);
    store.editTags(['1'], { add: ['消える'] });
    assert.equal(store.cleanup(30).deleted, 0);
    advance(30);
    assert.equal(store.cleanup(30).deleted, 2);
    assert.equal(get(1), undefined);
    assert.equal(get(3), undefined);
    assert.ok(get(2));
    assert.equal(store.listTags()[0].count, 0);
  });

  it('取り込みを削除すると、前の状態に戻る', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1]);
    imp('following', '2026-01-05', [1, 2]);
    const snap = store.listSnapshots().find((s) => s.taken_at.startsWith('2026-01-05'));
    store.deleteSnapshot(snap.id);
    assert.equal(get(2), undefined);
    assert.equal(get(1).following, true);
  });
});

describe('タグ', () => {
  it('付け外しと、名前の大文字小文字の違いをまとめる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    store.editTags(['1', '2'], { add: ['VTuber', ' 野球  ファン '] });
    store.editTags(['2'], { add: ['vtuber'], remove: ['野球 ファン'] });
    assert.deepEqual(get(1).tags, ['VTuber', '野球 ファン']);
    assert.deepEqual(get(2).tags, ['VTuber']);
    assert.deepEqual(store.listTags().map((t) => [t.name, t.count]), [['VTuber', 2], ['野球 ファン', 1]]);
  });

  it('既にある名前に変えると1つにまとまる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1, 2]);
    store.editTags(['1'], { add: ['A'] });
    store.editTags(['2'], { add: ['B'] });
    const b = store.listTags().find((t) => t.name === 'B');
    assert.deepEqual(store.renameTag(b.id, 'a'), { merged: true });
    assert.deepEqual(store.listTags().map((t) => [t.name, t.count]), [['A', 2]]);
    assert.deepEqual(get(2).tags, ['A']);
  });

  it('タグを削除するとアカウントから外れる', () => {
    const { store, imp, get } = setup();
    imp('following', '2026-01-01', [1]);
    store.editTags(['1'], { add: ['A'] });
    store.deleteTag(store.listTags()[0].id);
    assert.deepEqual(get(1).tags, []);
  });

  it('空のタグ名は断る', () => {
    const { store, imp } = setup();
    imp('following', '2026-01-01', [1]);
    assert.throws(() => store.editTags(['1'], { add: ['  '] }), UserError);
  });
});

describe('タグの大分類と小分類', () => {
  function withTags() {
    const s = setup();
    s.imp('following', '2026-01-01', [1, 2, 3]);
    s.store.editTags(['1'], { add: ['野球', 'MLB'] });
    s.store.editTags(['2'], { add: ['MLB'] });
    s.store.editTags(['3'], { add: ['野球'] });
    s.tag = (name) => s.store.listTags().find((t) => t.name === name);
    return s;
  }

  it('親を決めると、小分類と重なっている大分類は外れ、人数は小分類込みで数える', () => {
    const { store, get, tag } = withTags();
    store.setTagParent(tag('MLB').id, tag('野球').id);
    assert.deepEqual(get(1).tags, ['MLB']);
    assert.deepEqual(get(3).tags, ['野球']);
    assert.equal(tag('MLB').parent_id, tag('野球').id);
    assert.deepEqual([tag('野球').count, tag('野球').total], [1, 3]);
  });

  it('誰にも付けずにタグだけを作れる（上の分類を指定でき、同じ名前は作らない）', () => {
    const { store, tag } = withTags();
    const r = store.createTag(' 球団 ', tag('野球').id);
    assert.deepEqual([r.name, r.parent, r.parentDirect], ['球団', '野球', 2]); // 野球に直接付いているのは 1 と 3
    assert.equal(tag('球団').parent_id, tag('野球').id);
    assert.deepEqual([tag('球団').count, tag('球団').total], [0, 0]);
    assert.equal(store.createTag('アニメ').parent, null);
    assert.equal(tag('アニメ').parent_id, null);
    assert.throws(() => store.createTag('MLB'), UserError);
    assert.throws(() => store.createTag('   '), UserError);
    assert.throws(() => store.createTag('新しいタグ', 99999), UserError);
    assert.equal(tag('新しいタグ'), undefined);
  });

  it('小分類を後から付けても、大分類は重ねて残さない', () => {
    const { store, get, tag } = withTags();
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.editTags(['3'], { add: ['MLB'] });
    assert.deepEqual(get(3).tags, ['MLB']);
    store.editTags(['2'], { add: ['野球'] });
    assert.deepEqual(get(2).tags, ['MLB']);
  });


  it('親を外すと、ただのタグに戻る', () => {
    const { store, tag } = withTags();
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.setTagParent(tag('MLB').id, null);
    assert.equal(tag('MLB').parent_id, null);
  });


  it('大分類どうしをまとめると、小分類もまとめた先に移る', () => {
    const { store, imp, get, tag } = withTags();
    imp('following', '2026-01-02', [1, 2, 3, 4]);
    store.editTags(['4'], { add: ['ベースボール'] });
    store.setTagParent(tag('MLB').id, tag('ベースボール').id);
    store.renameTag(tag('ベースボール').id, '野球');
    assert.equal(tag('MLB').parent_id, tag('野球').id);
    assert.deepEqual(get(1).tags, ['MLB']);
    assert.deepEqual(get(4).tags, ['野球']);
  });


  it('3段以上にでき、絞り込み用の人数は下の段すべてを含める', () => {
    const { store, imp, get, tag } = withTags();
    imp('following', '2026-01-02', [1, 2, 3, 4]);
    store.editTags(['4'], { add: ['ドジャース', 'MLB', '野球'] });
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.setTagParent(tag('ドジャース').id, tag('MLB').id);
    // 4 にはドジャースだけが残る（MLB・野球はドジャースから分かる）
    assert.deepEqual(get(4).tags, ['ドジャース']);
    assert.deepEqual([tag('野球').total, tag('MLB').total, tag('ドジャース').total], [4, 3, 1]);
  });

  it('後から付けた上の段のタグも、下の段があれば重ねない', () => {
    const { store, get, tag } = withTags();
    store.editTags(['1'], { add: ['ドジャース'] });
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.setTagParent(tag('ドジャース').id, tag('MLB').id);
    store.editTags(['1'], { add: ['野球', 'MLB'] });
    assert.deepEqual(get(1).tags, ['ドジャース']);
  });

  it('自分自身や自分の下の段を、上の分類にはできない', () => {
    const { store, tag } = withTags();
    store.editTags(['1'], { add: ['ドジャース'] });
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.setTagParent(tag('ドジャース').id, tag('MLB').id);
    assert.throws(() => store.setTagParent(tag('野球').id, tag('ドジャース').id), /下にあるので/);
    assert.throws(() => store.setTagParent(tag('野球').id, tag('野球').id), /自分自身/);
  });

  it('途中の段を消すと、その下は1つ上の段につながり直す', () => {
    const { store, get, tag } = withTags();
    store.editTags(['2'], { add: ['ドジャース'] });
    store.setTagParent(tag('MLB').id, tag('野球').id);
    store.setTagParent(tag('ドジャース').id, tag('MLB').id);
    store.deleteTag(tag('MLB').id);
    assert.equal(tag('ドジャース').parent_id, tag('野球').id);
    assert.deepEqual(get(2).tags, ['ドジャース']);
  });

  it('自分の下の段にあるタグには、まとめられない', () => {
    const { store, tag } = withTags();
    store.setTagParent(tag('MLB').id, tag('野球').id);
    assert.throws(() => store.renameTag(tag('野球').id, 'MLB'), /まとめられません/);
  });

  it('古いデータベースに親の欄を足す', () => {
    const store = new Store(':memory:');
    store.db.exec('DROP TABLE account_tags; DROP TABLE tags; CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)');
    store.migrate();
    const cols = store.db.prepare('PRAGMA table_info(tags)').all().map((c) => c.name);
    assert.ok(cols.includes('parent_id'));
  });
});

describe('フォロバ宣言', () => {
  it('一覧に、自己紹介から判定した言葉が入る', () => {
    const { store, get } = setup();
    store.importExport({
      filename: file('following', '2026-01-01'),
      content: JSON.stringify([acct(1, { bio: '野球垢はフォロバします' }), acct(2, { bio: '野球が好き' })]),
    });
    assert.equal(get(1).followBack, 'フォロバします');
    assert.equal(get(2).followBack, null);
  });
});
