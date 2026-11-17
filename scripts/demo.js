// 試し用のデータ（架空のアカウントだけ）を data/demo.sqlite に作り直す。本物のデータ（data/x-ff.sqlite）には触らない。
// 使い方：npm run demo（データを作って 4880 番で起動する。ダウンロードフォルダの自動取り込みはしない）
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const path = process.env.XFF_DB ?? join(ROOT, 'data', 'demo.sqlite');
if (!/demo/.test(path)) throw new Error(`試し用のファイル名には demo を含めてください: ${path}`);
for (const ext of ['', '-wal', '-shm']) rmSync(path + ext, { force: true });

// 取り込みの日時を「今」から何日前かで決める（いつ試しても同じ見え方になるように）
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const fname = (kind, d) => {
  const p = (x) => String(x).padStart(2, '0');
  return `XPorter_${kind}_demo_user_exported_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-at-${p(d.getHours())}-${p(d.getMinutes())}-00.json`;
};

// 架空のアカウント（アイコンは X の標準アイコン。実在の人の画像は使わない）
const DEFAULT_ICON = 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';
const A = {
  1: ['mutual_aoi', 'あおい（相互）', '野球とアニメが好き'],
  2: ['mutual_kai', 'かい（相互）', 'ホークスファン'],
  3: ['mutual_rin', 'りん（相互）', '音楽とカメラ', 'https://lit.link/rin_demo/'],
  4: ['broken_sou', 'そう（相互が外れた）', '前は相互だった人'],
  5: ['keep_mio', 'みお（保護）', '返ってこなくても残したい人'],
  6: ['loose_old', 'ゆる（見直し期限）', 'ゆるく保持にして時間がたった人'],
  7: ['loose_new', 'ゆる（まだ期間内）', 'ゆるく保持にしたばかりの人'],
  8: ['star_demo', '有名人の例', '俳優・タレント（有名人は整理候補に出ない）'],
  9: ['news_demo', 'ニュース公式の例', '公式アカウント（公式・メディアは整理候補に出ない）'],
  10: ['tuber_demo', '野球解説YouTuberの例', 'YouTube で野球解説（発信者は整理候補に出ない）'],
  11: ['main_hana', 'はな（本垢）', 'サブ→@sub_hana'],
  12: ['sub_hana', 'はな（サブ垢）', '本垢→@main_hana'],
  13: ['fb_taro', 'たろう（フォロバ宣言）', '無言フォロー歓迎、フォロバします！'],
  14: ['gone_ken', 'けん（外した人）', '前にフォローしていた人'],
  15: ['new_back', 'しん（新しくフォロー→返ってきた）', 'フォロー返してくれた人'],
  16: ['new_wait', 'なな（新しくフォロー→返ってこない）', '猶予期間を過ぎた人'],
  17: ['new_fresh', 'まき（フォローしたばかり）', 'まだ猶予期間中の人'],
  18: ['gone_yu', 'ゆう（外した人2）', '前にフォローしていた人'],
  19: ['taro_sub', 'たろう（新しく見つけたサブ垢）', '本垢→@fb_taro'],
  22: ['rin_photo', 'りん（写真用・リンクが同じ）', '写真を載せています', 'https://lit.link/rin_demo'],
  20: ['fan_only1', 'ファン1（フォロワーのみ）', 'こちらはフォローしていない'],
  21: ['fan_only2', 'ファン2（フォロワーのみ）', 'こちらはフォローしていない'],
};
const acct = (i) => ({ id: String(i), username: A[i][0], name: A[i][1], bio: A[i][2], url: A[i][3] ?? '', profile_image_url: DEFAULT_ICON, followers_count: 100 * i, following_count: i === 1 ? 90 : (i % 3 ? 50 : 300) * i });
// FF比の色の例：1 はほぼ同じ（灰色）、3の倍数の人はフォローの方がずっと多い（ピンク）、ほかはフォロワーの方がずっと多い（青）
const store = new Store(path);
const imp = (kind, ago, ids) => store.importExport({ filename: fname(kind, daysAgo(ago)), content: JSON.stringify(ids.map(acct)) });

// 1回目（40日前）：記録開始
imp('following', 40, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 18]);
imp('followers', 40, [1, 2, 3, 4, 20, 21]);
// 2回目（25日前）：15・16 を新しくフォロー、14 を外した。4 にフォローを外された
imp('following', 25, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 18]);
imp('followers', 25, [1, 2, 3, 15, 20, 21]);
// 3回目（3日前）：17 を新しくフォロー、18 を外した
imp('following', 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 19, 22]);
imp('followers', 3, [1, 2, 3, 15, 20, 21]);

store.setStatus(['5'], 'protected');
store.setStatus(['6', '7'], 'loose');
// 6 は「ゆるく保持」にしてから見直し期間（90日）以上たったことにする
store.db.prepare('UPDATE accounts SET reviewed_at = ? WHERE id = ?').run(daysAgo(100).toISOString(), '6');
store.setKind(['8'], 'celebrity');
store.setKind(['9'], 'official');
store.setKind(['10'], 'creator');
// 入力し終わった人の例だけ「一般」にする。ほかの人は、取り込んだばかりと同じく種類は未選択（未入力タブに出る）
store.setKind(['1', '2', '3', '13'], 'general');
store.editTags(['13'], { add: ['野球'] });

// タグ（木の形）
const tag = (name, parent) => {
  const id = store.tagId(name, true);
  if (parent) store.setTagParent(id, store.tagId(parent, false));
};
tag('野球'); tag('NPB', '野球'); tag('ホークス', 'NPB'); tag('NPB総合', 'NPB');
tag('漫画・アニメ'); tag('音楽'); tag('芸能'); tag('タレント', '芸能');
store.editTags(['2'], { add: ['ホークス'] });
store.editTags(['10'], { add: ['NPB総合'] });
store.editTags(['1'], { add: ['漫画・アニメ', 'NPB総合'] });
store.editTags(['3'], { add: ['音楽'] });
store.editTags(['8'], { add: ['タレント'] });
store.setNote('5', '昔からの知り合い');

// 同じ人の複数アカウント
store.linkAccounts('11', ['12']);

store.close();
console.log(`試し用データを作りました: ${path}`);
