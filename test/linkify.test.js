import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanUrl, linkify } from '../public/linkify.js';

describe('リンクの追跡用の文字', () => {
  it('Instagram の igsh・utm_source などを外し、ページを指す部分は残す', () => {
    assert.equal(cleanUrl('https://www.instagram.com/demo_user?igsh=MXNhaTZr%3D%3D&utm_source=qr'), 'https://www.instagram.com/demo_user');
    assert.equal(cleanUrl('https://www.instagram.com/demo_user/?stkn=abc&utm_source=qr'), 'https://www.instagram.com/demo_user/');
  });
  it('YouTube の si は外すが、動画を指す v は残す', () => {
    assert.equal(cleanUrl('https://youtube.com/@demo?si=abc'), 'https://youtube.com/@demo');
    assert.equal(cleanUrl('https://www.youtube.com/watch?v=xyz&si=abc'), 'https://www.youtube.com/watch?v=xyz');
  });
  it('ほかのサイトでは utm_ だけを外し、サイトに必要な文字は残す', () => {
    assert.equal(
      cleanUrl('https://marshmallow-qa.com/demo?t=Q3v6RB&utm_medium=url_text&utm_source=promotion'),
      'https://marshmallow-qa.com/demo?t=Q3v6RB',
    );
    assert.equal(cleanUrl('https://example.com/a?si=keep'), 'https://example.com/a?si=keep');
    assert.equal(cleanUrl('https://x.com/demo_user?s=21&t=abc'), 'https://x.com/demo_user');
    assert.equal(cleanUrl('https://www.youtube.com/@demo?sub_confirmation=1'), 'https://www.youtube.com/@demo?sub_confirmation=1');
  });
  it('自己紹介の URL のリンク先からも外す', () => {
    assert.deepEqual(linkify('https://example.com/x?utm_source=qr').find((p) => p.type === 'url').href, 'https://example.com/x');
  });
});

// リンクになった部分だけを [種類, 文字, リンク先] で取り出す
const links = (t) => linkify(t).filter((p) => p.type !== 'text').map((p) => [p.type, p.text, p.href]);
// 元の文字が欠けずに並んでいるか
const joined = (t) => linkify(t).map((p) => p.text).join('');

describe('自己紹介のリンク', () => {
  it('https:// の URL をリンクにし、日本語や句読点・閉じかっこの手前で終える', () => {
    assert.deepEqual(links('ブログ→https://example.com/a?b=1こちら'), [['url', 'https://example.com/a?b=1', 'https://example.com/a?b=1']]);
    assert.deepEqual(links('(https://example.com/x)。'), [['url', 'https://example.com/x', 'https://example.com/x']]);
    assert.deepEqual(links('https://ja.wikipedia.org/wiki/A_(B)'), [['url', 'https://ja.wikipedia.org/wiki/A_(B)', 'https://ja.wikipedia.org/wiki/A_(B)']]);
  });

  it('https:// のないドメインもリンクにする（よくある末尾のものだけ）', () => {
    assert.deepEqual(links('lit.link/demo_user'), [['url', 'lit.link/demo_user', 'https://lit.link/demo_user']]);
    assert.deepEqual(links('www.example.jp'), [['url', 'www.example.jp', 'https://www.example.jp/']]);
    assert.deepEqual(links('ver.2.0 と Node.js'), []);
  });

  it('メールアドレスは mailto のリンクにし、@ID とは分ける', () => {
    assert.deepEqual(links('お仕事は demo.user+x@example.co.jp まで'), [['email', 'demo.user+x@example.co.jp', 'mailto:demo.user+x@example.co.jp']]);
  });

  it('@ID は X のそのアカウントへのリンクにする', () => {
    assert.deepEqual(links('本垢→@fb_taro サブ:＠sub_1'), [
      ['mention', '@fb_taro', 'https://x.com/fb_taro'],
      ['mention', '＠sub_1', 'https://x.com/sub_1'],
    ]);
    assert.deepEqual(links('@abcdefghijklmnopq は長すぎ'), []);
  });

  it('いくつ混ざっていても元の文字は欠けない', () => {
    const t = '連絡→a@b.jp／@demo_x／https://example.com/(x)、lit.link/y。';
    assert.equal(joined(t), t);
    assert.deepEqual(links(t).map((l) => l[0]), ['email', 'mention', 'url', 'url']);
  });

  it('http(s) 以外のリンク先は作らない', () => {
    assert.deepEqual(links('javascript:alert(1)'), []);
  });
});
