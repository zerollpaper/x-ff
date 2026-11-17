import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFollowBack } from '../src/followback.js';

// 本物の自己紹介は使わず、よくある書き方をまねた文で確かめる
describe('フォロバ宣言の判定', () => {
  const yes = [
    ['フォロバ100%　よろしく', 'フォロバ100%'],
    ['基本〇〇はフォロバ１００％！', 'フォロバ100%'],
    ['Follow Back 100%', 'Follow Back'],
    ['【相互フォローほぼ１００％】させてもらいます', '相互フォロー'],
    ['〇〇垢はフォロバします。', 'フォロバします'],
    ['荒らし以外フォロバします', 'フォロバします'],
    ['基本的にフォロー返しをします', 'フォロー返しをします'],
    ['中世史│基本フォロバ│', '基本フォロバ'],
    ['野球垢と〇〇全員フォロバ', '全員フォロバ'],
    ['無言フォローOK→大体フォロバ返します', '大体フォロバ'],
    ['フォローやいいねを貰ったら積極的にフォローします', '貰ったら積極的にフォローします'],
  ];
  for (const [text, hit] of yes) {
    it(`拾う: ${text}`, () => assert.equal(detectFollowBack(text), hit));
  }

  const no = [
    'フォロバはマイペースにしてるのであまりお気になさらず',
    '※鍵垢はフォロバしない可能性が高いです',
    '無言フォロー大歓迎！',
    '無言フォロー失礼します',
    'フォロー外しはいつでもお気軽に',
    '',
  ];
  for (const text of no) {
    it(`拾わない: ${text || '（空）'}`, () => assert.equal(detectFollowBack(text), null));
  }

  it('名前に書いてあっても拾う', () => {
    assert.equal(detectFollowBack('China food clips', 'Someone 1376（互fo）'), '互fo');
  });
});
