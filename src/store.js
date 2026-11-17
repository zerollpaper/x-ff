// データの保存と判定のロジック。画面やサーバーからはこのクラスだけを使う。
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { detectFollowBack } from './followback.js';

export const STATUSES = ['waiting', 'loose', 'protected'];
// 種類：どういう立場のアカウントか（タグ＝話題とは別の軸）。未設定は null
// celebrity 有名人（本業で知られる人：選手・芸能人・作家・記者・政治家）
// creator 発信者（個人で継続して発信する人：YouTuber・解説・note・論客など）
// official 公式・メディア（組織や、中の人が前に出ない情報アカウント）/ general 一般（発言するだけの人）
export const KINDS = ['celebrity', 'creator', 'official', 'general'];
// フォローを返してくる相手ではない種類。整理候補に出さない（未設定は一般と同じに扱う）
const NO_FOLLOW_BACK_KINDS = ['celebrity', 'creator', 'official'];
const KIND_COLUMN = `kind TEXT CHECK (kind IN (${KINDS.map((k) => `'${k}'`).join(', ')}))`;
// 同じ人の複数アカウント：サブ垢は main_id に本垢の id を持つ（本垢は null）。段は1段だけ
const MAIN_COLUMN = 'main_id TEXT REFERENCES accounts(id) ON DELETE SET NULL';
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { grace_days: 14, review_days: 90, ff_low: 80, ff_high: 125 };
// 設定の値として受け付ける範囲（整数）。FF比の幅は「ほぼ同じ」とみなす範囲なので 100% をはさむ
const SETTING_RANGES = {
  grace_days: [0, 3650, '猶予期間は 0〜3650 の整数（日）'],
  review_days: [0, 3650, '見直し期間は 0〜3650 の整数（日）'],
  ff_low: [1, 100, 'FF比の幅の下は 1〜100 の整数（%）'],
  ff_high: [100, 100000, 'FF比の幅の上は 100〜100000 の整数（%）'],
};
// 前回より大きく減った取り込みは、途中で止まったエクスポートかもしれないので警告する
const SHRINK_WARN_RATIO = 0.2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  profile_image_url TEXT NOT NULL DEFAULT '',
  followers_count INTEGER,
  following_count INTEGER,
  tweet_count INTEGER,
  listed_count INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  account_created_at TEXT,
  profile_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'loose', 'protected')),
  reviewed_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  ${KIND_COLUMN},
  ${MAIN_COLUMN},
  dismissed_candidate_at TEXT,
  dismissed_unfollowed_at TEXT,
  wait_from TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('following', 'followers')),
  taken_at TEXT NOT NULL,
  source_file TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (kind, taken_at)
);
CREATE TABLE IF NOT EXISTS snapshot_members (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (snapshot_id, account_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS account_tags (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, tag_id)
) WITHOUT ROWID;
`;

const FILE_RE =
  /^XPorter_(followers|following)_([A-Za-z0-9_]+)_exported_(\d{4})-(\d{2})-(\d{2})-at-(\d{2})-(\d{2})-(\d{2})(?: \(\d+\))?\.json$/;

export class UserError extends Error {}

// プロフィールのリンクを比べられる形にする（https・www・末尾の / ・? 以降を落とす）。
// 「instagram.com」だけのように、だれでも同じになるリンクは比べない
const COMMON_SITES = new Set(['x.com', 'twitter.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'linktr.ee', 'lit.link', 'note.com', 'threads.net']);
export function normalizeLink(url) {
  const u = String(url ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!u || COMMON_SITES.has(u)) return null;
  return u;
}

// 同じ人かもしれない組を探す（まだ同じ人としてまとめていない組だけ）。手がかりは2つ：
// - 自己紹介に「本垢→@…」「サブ:@…」のように相手の ID が書いてある（どちらか一方が書いていればよい）
// - プロフィールのリンク先が同じ（同じ lit.link・Instagram など）
// 戻り値：Map<id, [{ id, username }]>
export function findMaybeSame(accounts) {
  const byName = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
  const rootOf = (a) => a.main_id ?? a.id;
  const out = new Map();
  const add = (x, y) => {
    if (!out.has(x.id)) out.set(x.id, []);
    if (!out.get(x.id).some((p) => p.id === y.id)) out.get(x.id).push({ id: y.id, username: y.username });
  };
  for (const a of accounts) {
    for (const m of String(a.bio ?? '').matchAll(/@([A-Za-z0-9_]{1,15})/g)) {
      const b = byName.get(m[1].toLowerCase());
      if (!b || b.id === a.id || rootOf(a) === rootOf(b)) continue;
      add(a, b);
      add(b, a);
    }
  }
  const byLink = new Map();
  for (const a of accounts) {
    const k = normalizeLink(a.url);
    if (!k) continue;
    if (!byLink.has(k)) byLink.set(k, []);
    byLink.get(k).push(a);
  }
  for (const list of byLink.values()) {
    for (const a of list) for (const b of list) if (a.id !== b.id && rootOf(a) !== rootOf(b)) add(a, b);
  }
  return out;
}

// ファイル名から種類・持ち主・取得日時（ローカル時刻）を読む
export function parseExportFilename(filename) {
  const base = String(filename).split(/[\\/]/).pop();
  const m = FILE_RE.exec(base);
  if (!m) {
    throw new UserError(
      `ファイル名の形式が違います: ${base}（xporter が付けた名前のまま、JSON で取り込んでください）`,
    );
  }
  const [, kind, owner, y, mo, d, h, mi, s] = m;
  const takenAt = new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { kind, owner, takenAt: takenAt.toISOString() };
}

function normalizeRecord(r, i) {
  if (!r || typeof r !== 'object') throw new UserError(`${i + 1}件目がオブジェクトではありません`);
  const id = typeof r.id === 'number' ? null : String(r.id ?? '');
  if (!/^\d+$/.test(id ?? '')) {
    throw new UserError(`${i + 1}件目の id が文字列の数字ではありません（JSON で出力したファイルか確認してください）`);
  }
  if (!r.username) throw new UserError(`${i + 1}件目に username がありません`);
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id,
    username: String(r.username),
    name: String(r.name ?? ''),
    bio: String(r.bio ?? ''),
    location: String(r.location ?? ''),
    url: String(r.url ?? ''),
    profile_image_url: String(r.profile_image_url ?? ''),
    followers_count: num(r.followers_count),
    following_count: num(r.following_count),
    tweet_count: num(r.tweet_count),
    listed_count: num(r.listed_count),
    verified: r.verified ? 1 : 0,
    is_private: r.protected ? 1 : 0,
    account_created_at: r.created_at ? String(r.created_at) : null,
  };
}

export class Store {
  constructor(path = ':memory:', { now = () => new Date() } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.now = now;
  }

  // 古い形のデータベースを今の形に合わせる
  migrate() {
    const cols = this.db.prepare('PRAGMA table_info(tags)').all().map((c) => c.name);
    if (!cols.includes('parent_id')) {
      this.db.exec('ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL');
    }
    const accCols = this.db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
    if (!accCols.includes('kind')) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN ${KIND_COLUMN}`);
    }
    if (!accCols.includes('main_id')) {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN ${MAIN_COLUMN}`);
    }
    // 外した人の一覧から消した日時（dismissed_candidate_at は使わなくなったが、古いデータとの互換のため列は残す）
    // wait_from：整理候補で「まだ待つ」を押した日時（猶予期間をここから数え直す）
    for (const c of ['dismissed_candidate_at', 'dismissed_unfollowed_at', 'wait_from']) {
      if (!accCols.includes(c)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${c} TEXT`);
    }
    // 種類の値を増やしたとき：SQLite は CHECK を書き換えられないので、列を作り直して値を移す
    const tableSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get().sql;
    if (KINDS.some((k) => !tableSql.includes(`'${k}'`))) {
      this.tx(() => {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${KIND_COLUMN.replace(/\bkind\b/g, 'kind_new')}`);
        this.db.exec('UPDATE accounts SET kind_new = kind');
        this.db.exec('ALTER TABLE accounts DROP COLUMN kind');
        this.db.exec('ALTER TABLE accounts RENAME COLUMN kind_new TO kind');
      });
    }
  }

  close() {
    this.db.close();
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- 設定 ----
  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const { key, value } of this.db.prepare('SELECT key, value FROM settings').all()) {
      if (key in out) out[key] = Number(value);
    }
    return out;
  }

  updateSettings(patch) {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const next = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] === undefined) continue;
      const v = Number(patch[key]);
      const [min, max, label] = SETTING_RANGES[key];
      if (!Number.isInteger(v) || v < min || v > max) throw new UserError(`${label}にしてください`);
      next[key] = v;
    }
    for (const [key, v] of Object.entries(next)) stmt.run(key, String(v));
    return this.getSettings();
  }

  getOwner() {
    return this.db.prepare("SELECT value FROM meta WHERE key = 'owner'").get()?.value ?? null;
  }

  // 自分のアイコン。エクスポートには自分のプロフィールが入っていないので、X で画像のアドレスをコピーして設定に貼ってもらう。
  // 画面で読み込むので、X のアイコンの置き場所（pbs.twimg.com/profile_images/）のアドレスだけを受け付ける。空にすると消す
  getOwnerIcon() {
    return this.db.prepare("SELECT value FROM meta WHERE key = 'owner_icon'").get()?.value ?? null;
  }

  setOwnerIcon(url) {
    const u = String(url ?? '').trim();
    if (!u) {
      this.db.exec("DELETE FROM meta WHERE key = 'owner_icon'");
      return { ownerIcon: null };
    }
    if (!/^https:\/\/pbs\.twimg\.com\/profile_images\/[A-Za-z0-9_\-./]+$/.test(u)) {
      throw new UserError('X のアイコンの画像アドレス（https://pbs.twimg.com/profile_images/… で始まるもの）を貼ってください');
    }
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('owner_icon', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(u);
    return { ownerIcon: u };
  }

  // ---- 取り込み ----
  importExport({ filename, content }) {
    const { kind, owner, takenAt } = parseExportFilename(filename);
    let rows;
    try {
      rows = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      throw new UserError('JSON として読めません');
    }
    if (!Array.isArray(rows)) throw new UserError('JSON の中身が配列ではありません');
    const records = rows.map(normalizeRecord);
    const ids = new Set(records.map((r) => r.id));
    if (ids.size !== records.length) throw new UserError('同じ id が重複しています');

    const known = this.getOwner();
    if (known && known.toLowerCase() !== owner.toLowerCase()) {
      throw new UserError(`別のアカウント（@${owner}）のファイルです。このツールは @${known} 用です`);
    }
    const dup = this.db
      .prepare('SELECT id FROM snapshots WHERE kind = ? AND taken_at = ?')
      .get(kind, takenAt);
    if (dup) return { kind, takenAt, count: records.length, duplicate: true };

    const prev = this.db
      .prepare('SELECT id FROM snapshots WHERE kind = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 1')
      .get(kind, takenAt);
    const prevIds = prev ? this.membersOf(prev.id) : null;

    this.tx(() => {
      if (!known) this.db.prepare("INSERT INTO meta (key, value) VALUES ('owner', ?)").run(owner);
      const snap = this.db
        .prepare('INSERT INTO snapshots (kind, taken_at, source_file, imported_at) VALUES (?, ?, ?, ?)')
        .run(kind, takenAt, String(filename).split(/[\\/]/).pop(), this.now().toISOString());
      const snapId = Number(snap.lastInsertRowid);
      const upsert = this.db.prepare(`
        INSERT INTO accounts (id, username, name, bio, location, url, profile_image_url, followers_count,
          following_count, tweet_count, listed_count, verified, is_private, account_created_at, profile_seen_at)
        VALUES (:id, :username, :name, :bio, :location, :url, :profile_image_url, :followers_count,
          :following_count, :tweet_count, :listed_count, :verified, :is_private, :account_created_at, :seen)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username, name = excluded.name, bio = excluded.bio, location = excluded.location,
          url = excluded.url, profile_image_url = excluded.profile_image_url,
          followers_count = excluded.followers_count, following_count = excluded.following_count,
          tweet_count = excluded.tweet_count, listed_count = excluded.listed_count, verified = excluded.verified,
          is_private = excluded.is_private, account_created_at = excluded.account_created_at,
          profile_seen_at = excluded.profile_seen_at
        WHERE excluded.profile_seen_at >= accounts.profile_seen_at`);
      const member = this.db.prepare('INSERT INTO snapshot_members (snapshot_id, account_id) VALUES (?, ?)');
      for (const r of records) {
        upsert.run({ ...r, seen: takenAt });
        member.run(snapId, r.id);
      }
    });

    const result = { kind, takenAt, count: records.length, duplicate: false, isFirst: !prevIds };
    if (prevIds) {
      result.added = [...ids].filter((id) => !prevIds.has(id)).length;
      result.removed = [...prevIds].filter((id) => !ids.has(id)).length;
      if (prevIds.size > 0 && result.removed / prevIds.size > SHRINK_WARN_RATIO) {
        result.warning =
          `前回より ${result.removed} 件減っています。エクスポートが途中で止まっていないか確認してください` +
          '（途中のファイルなら「取り込み済みのファイル」から削除できます）';
      }
    }
    return result;
  }

  membersOf(snapshotId) {
    return new Set(
      this.db
        .prepare('SELECT account_id FROM snapshot_members WHERE snapshot_id = ?')
        .all(snapshotId)
        .map((r) => r.account_id),
    );
  }

  listSnapshots() {
    return this.db
      .prepare(`SELECT s.id, s.kind, s.taken_at, s.source_file, s.imported_at,
          (SELECT COUNT(*) FROM snapshot_members m WHERE m.snapshot_id = s.id) AS count
        FROM snapshots s ORDER BY s.taken_at DESC, s.kind`)
      .all();
  }

  deleteSnapshot(id) {
    const r = this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(Number(id));
    if (r.changes === 0) throw new UserError('その取り込みは見つかりません');
    // どの取り込みにも出てこなくなったアカウントは消す（タグなども一緒に消える）
    this.db.exec('DELETE FROM accounts WHERE id NOT IN (SELECT account_id FROM snapshot_members)');
    if (!this.db.prepare('SELECT 1 FROM snapshots').get()) this.db.exec("DELETE FROM meta WHERE key = 'owner'");
  }

  // ---- 取り込みの履歴から、各アカウントの今の関係を計算する ----
  // 返す値: Map<id, { following, follower, followingSince, unfollowedAt, followerSince, followerLostAt, everFollowing, everFollower }>
  //   followingSince: 今回続けてフォローしている期間が始まった取り込みの日時。記録を始める前からなら null
  //   unfollowedAt: フォローしていた人が初めて一覧から消えた取り込みの日時（今フォロー中なら null）
  relations() {
    const snaps = this.db.prepare('SELECT id, kind, taken_at FROM snapshots ORDER BY taken_at').all();
    const members = new Map();
    for (const { snapshot_id, account_id } of this.db
      .prepare('SELECT snapshot_id, account_id FROM snapshot_members')
      .all()) {
      if (!members.has(snapshot_id)) members.set(snapshot_id, new Set());
      members.get(snapshot_id).add(account_id);
    }
    const rel = new Map();
    const get = (id) => {
      if (!rel.has(id)) {
        rel.set(id, {
          following: false,
          follower: false,
          followingSince: null,
          unfollowedAt: null,
          followerSince: null,
          followerLostAt: null,
          everFollowing: false,
          everFollower: false,
        });
      }
      return rel.get(id);
    };
    for (const kind of ['following', 'followers']) {
      const list = snaps.filter((s) => s.kind === kind);
      const isF = kind === 'following';
      let prev = null;
      list.forEach((s, i) => {
        const cur = members.get(s.id) ?? new Set();
        for (const id of cur) {
          const r = get(id);
          const was = prev?.has(id);
          if (isF) {
            r.everFollowing = true;
            if (!was) r.followingSince = i === 0 ? null : s.taken_at;
          } else {
            r.everFollower = true;
            if (!was) r.followerSince = i === 0 ? null : s.taken_at;
          }
        }
        if (prev) {
          for (const id of prev) {
            if (cur.has(id)) continue;
            const r = get(id);
            if (isF) r.unfollowedAt = s.taken_at;
            else r.followerLostAt = s.taken_at;
          }
        }
        prev = cur;
      });
      if (prev) {
        for (const id of prev) {
          const r = get(id);
          if (isF) {
            r.following = true;
            r.unfollowedAt = null;
          } else {
            r.follower = true;
            r.followerLostAt = null;
          }
        }
      }
    }
    return rel;
  }

  // ---- 一覧 ----
  listAccounts() {
    const now = this.now().getTime();
    const { grace_days, review_days, ff_low, ff_high } = this.getSettings();
    const rel = this.relations();
    const tagRows = this.db
      .prepare('SELECT at.account_id, t.name FROM account_tags at JOIN tags t ON t.id = at.tag_id ORDER BY t.name')
      .all();
    const tags = new Map();
    for (const { account_id, name } of tagRows) {
      if (!tags.has(account_id)) tags.set(account_id, []);
      tags.get(account_id).push(name);
    }
    const hasFollowers = !!this.db.prepare("SELECT 1 FROM snapshots WHERE kind = 'followers'").get();
    const firstFollowingAt =
      this.db.prepare("SELECT taken_at FROM snapshots WHERE kind = 'following' ORDER BY taken_at LIMIT 1").get()
        ?.taken_at ?? null;
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY username COLLATE NOCASE').all();
    const maybeSame = findMaybeSame(rows);
    return rows
      .map((a) => {
        const r = rel.get(a.id);
        const oneSided = r.following && !r.follower && hasFollowers;
        // 記録を始める前からフォローしていた人も、最初の取り込みの日から猶予期間を数える
        // （記録を始めたばかりで全員が候補に出るのを避けるため）
        // 整理候補で「まだ待つ」を押していれば、そこから数え直す
        const base = r.followingSince ?? firstFollowingAt;
        const since = a.wait_from && (!base || a.wait_from > base) ? a.wait_from : base;
        const sinceMs = since ? Date.parse(since) : null;
        const graceLeft = sinceMs === null ? 0 : Math.max(0, Math.ceil((sinceMs + grace_days * DAY - now) / DAY));
        const reviewedMs = a.reviewed_at ? Date.parse(a.reviewed_at) : null;
        const reviewLeft =
          reviewedMs === null ? 0 : Math.max(0, Math.ceil((reviewedMs + review_days * DAY - now) / DAY));
        // 相互だったのに外された人は、返ってくるのを待つ意味がないので猶予期間を待たずに候補にする
        // 相互が外れた人は待たずに候補にする（ただし外されたあとに「まだ待つ」を押していれば待つ）
        const brokenNow = r.everFollower && (!a.wait_from || (r.followerLostAt && r.followerLostAt > a.wait_from));
        const candidateRaw =
          oneSided && a.status === 'waiting' && (graceLeft === 0 || brokenNow) && !NO_FOLLOW_BACK_KINDS.includes(a.kind);
        // 外した人の一覧から消した人は出さない。ただし消したあとにまた外したときは、もう一度出す
        // （整理候補から外すのは、状態ボタン（ゆるく保持・保護）でやる）
        const changedAfter = (d, ...ts) => ts.some((t) => t && t > d);
        const unfollowedRaw = !r.following && r.everFollowing;
        const unfDismissed = !!a.dismissed_unfollowed_at && !changedAfter(a.dismissed_unfollowed_at, r.unfollowedAt);
        // FF比（フォロワー ÷ フォロー、%）。フォロー数が 0 か分からないときは出さない
        const ffRatio = a.followers_count != null && a.following_count ? (a.followers_count * 100) / a.following_count : null;
        return {
          ...a,
          verified: !!a.verified,
          is_private: !!a.is_private,
          tags: tags.get(a.id) ?? [],
          // 自己紹介か名前に「フォローを返します」と書いてあれば、その言葉（フォロバ宣言）
          followBack: detectFollowBack(a.bio, a.name),
          ...r,
          mutual: r.following && r.follower,
          // 相互だったのに、こちらだけがフォローしている状態になった
          mutualBroken: oneSided && r.everFollower,
          graceLeft,
          reviewLeft,
          // 有名人・公式・メディアはもともとフォローを返す相手ではないので、整理候補に出さない
          expectsFollowBack: !NO_FOLLOW_BACK_KINDS.includes(a.kind),
          candidate: candidateRaw,
          // 未入力：フォロー中で、種類かタグがまだない人（新しくフォローした人はまずここに出る）
          unsorted: r.following && (!a.kind || !(tags.get(a.id) ?? []).length),
          // 同じ人かもしれないアカウント（自己紹介でお互いの ID に触れている。まだまとめていないものだけ）
          maybeSame: maybeSame.get(a.id) ?? [],
          unfollowed: unfollowedRaw && !unfDismissed,
          unfollowedDismissed: unfollowedRaw && unfDismissed,
          reviewDue: oneSided && a.status === 'loose' && reviewLeft === 0,
          ffRatio,
          // 設定の幅（ほぼ同じとみなす範囲）より上ならフォロワーの方がずっと多い、下ならフォローの方がずっと多い
          ffSide: ffRatio === null ? null : ffRatio > ff_high ? 'more' : ffRatio < ff_low ? 'less' : null,
        };
      });
  }

  summary() {
    const accounts = this.listAccounts();
    const latest = (kind) =>
      this.db.prepare('SELECT taken_at FROM snapshots WHERE kind = ? ORDER BY taken_at DESC LIMIT 1').get(kind)
        ?.taken_at ?? null;
    const count = (f) => accounts.filter(f).length;
    return {
      owner: this.getOwner(),
      ownerIcon: this.getOwnerIcon(),
      settings: this.getSettings(),
      latest: { following: latest('following'), followers: latest('followers') },
      counts: {
        following: count((a) => a.following),
        followers: count((a) => a.follower),
        mutual: count((a) => a.mutual),
        oneSided: count((a) => a.following && !a.follower),
        notFollowedBack: count((a) => a.follower && !a.following),
        unsorted: count((a) => a.unsorted),
        candidates: count((a) => a.candidate),
        review: count((a) => a.reviewDue),
        unfollowed: count((a) => a.unfollowed),
      },
    };
  }

  // ---- 状態・メモ ----
  checkIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new UserError('アカウントが選ばれていません');
    return ids.map(String);
  }

  setStatus(ids, status) {
    if (!STATUSES.includes(status)) throw new UserError(`状態の値が違います: ${status}`);
    const now = this.now();
    // ゆるく保持にした日から見直しまでの日数を数える。
    // 見直し期間がたった人（見直しタブに出ている人）にもう一度「ゆるく保持」を押したら、
    // 「まだ保持する」という意味なので、見直し期間をそこから数え直す
    const due = new Date(now.getTime() - this.getSettings().review_days * DAY).toISOString();
    const stmt = this.db.prepare(
      `UPDATE accounts SET status = ?, reviewed_at = CASE
         WHEN ? = 'loose' AND (status != 'loose' OR reviewed_at IS NULL OR reviewed_at <= ?) THEN ? ELSE reviewed_at END
       WHERE id = ?`,
    );
    // 猶予期間をそこから始め直すとき：
    // - 整理候補に出ている人にもう一度「フォロバ待ち」（＝まだ待つ）を押した
    // - ほかの状態（見直しのゆるく保持・保護）から「フォロバ待ち」にした
    const list = this.checkIds(ids);
    const candidates = new Set();
    if (status === 'waiting') {
      for (const a of this.listAccounts()) if (a.candidate || a.status !== 'waiting') candidates.add(a.id);
    }
    const wait = this.db.prepare('UPDATE accounts SET wait_from = ? WHERE id = ?');
    this.tx(() => {
      for (const id of list) {
        stmt.run(status, status, due, now.toISOString(), id);
        if (candidates.has(id)) wait.run(now.toISOString(), id);
      }
    });
  }

  // 外した人（list = 'unfollowed'）の一覧から消す。on = false で元に戻す
  // （整理候補には「消す」を作らない。状態ボタンで外す）
  dismissFromList(ids, list, on = true) {
    const col = { unfollowed: 'dismissed_unfollowed_at' }[list];
    if (!col) throw new UserError(`一覧の名前が違います: ${list}`);
    const stmt = this.db.prepare(`UPDATE accounts SET ${col} = ? WHERE id = ?`);
    const at = on ? this.now().toISOString() : null;
    this.tx(() => {
      for (const id of this.checkIds(ids)) stmt.run(at, id);
    });
  }

  // ---- 同じ人の複数アカウント ----
  // subIds を mainId のサブ垢にする。サブ垢のサブ垢は作らず、まとめて mainId の下に入れ直す
  linkAccounts(mainId, subIds) {
    const main = String(mainId);
    const subs = this.checkIds(subIds).filter((id) => id !== main);
    if (!subs.length) throw new UserError('まとめるアカウントを2つ以上選んでください');
    const exists = this.db.prepare('SELECT 1 FROM accounts WHERE id = ?');
    for (const id of [main, ...subs]) if (!exists.get(id)) throw new UserError(`アカウントが見つかりません: ${id}`);
    this.tx(() => {
      // 選んだアカウントがすでに別の組に入っていたら、その組の全員を新しい本垢の下に集める
      const rootOf = this.db.prepare('SELECT coalesce(main_id, id) AS r FROM accounts WHERE id = ?');
      const membersOf = this.db.prepare('SELECT id FROM accounts WHERE id = ? OR main_id = ?');
      const members = new Set();
      for (const id of [main, ...subs]) {
        const root = rootOf.get(id).r;
        for (const r of membersOf.all(root, root)) members.add(r.id);
      }
      const set = this.db.prepare('UPDATE accounts SET main_id = ? WHERE id = ?');
      for (const id of members) set.run(id === main ? null : main, id);
    });
  }

  // サブ垢に、本垢の種類とタグを貼り付ける（サブ垢にすでにあるタグは残す）
  copyFromMain(id) {
    const sub = this.db.prepare('SELECT id, main_id FROM accounts WHERE id = ?').get(String(id));
    if (!sub) throw new UserError('アカウントが見つかりません');
    if (!sub.main_id) throw new UserError('本垢ではなく、サブ垢で使ってください');
    const main = this.db.prepare('SELECT kind FROM accounts WHERE id = ?').get(sub.main_id);
    const tagNames = this.db
      .prepare('SELECT t.name FROM account_tags at JOIN tags t ON t.id = at.tag_id WHERE at.account_id = ?')
      .all(sub.main_id)
      .map((r) => r.name);
    this.tx(() => {
      if (main.kind) this.db.prepare('UPDATE accounts SET kind = ? WHERE id = ?').run(main.kind, sub.id);
    });
    if (tagNames.length) this.editTags([sub.id], { add: tagNames });
  }

  // 組から外す。本垢を指定したときは、その組をばらす
  unlinkAccounts(ids) {
    const list = this.checkIds(ids);
    this.tx(() => {
      for (const id of list) {
        this.db.prepare('UPDATE accounts SET main_id = NULL WHERE id = ? OR main_id = ?').run(id, id);
      }
    });
  }

  // 組の中で、このアカウントを本垢にする
  setMainAccount(id) {
    const acc = this.db.prepare('SELECT main_id FROM accounts WHERE id = ?').get(String(id));
    if (!acc) throw new UserError('アカウントが見つかりません');
    if (!acc.main_id) return;
    const old = acc.main_id;
    this.tx(() => {
      this.db.prepare('UPDATE accounts SET main_id = ? WHERE main_id = ? OR id = ?').run(String(id), old, old);
      this.db.prepare('UPDATE accounts SET main_id = NULL WHERE id = ?').run(String(id));
    });
  }

  // 種類を付ける。null で未設定に戻す
  setKind(ids, kind) {
    if (kind !== null && !KINDS.includes(kind)) throw new UserError(`種類の値が違います: ${kind}`);
    const stmt = this.db.prepare('UPDATE accounts SET kind = ? WHERE id = ?');
    this.tx(() => {
      for (const id of this.checkIds(ids)) stmt.run(kind, id);
    });
  }

  setNote(id, note) {
    const r = this.db.prepare('UPDATE accounts SET note = ? WHERE id = ?').run(String(note ?? ''), String(id));
    if (r.changes === 0) throw new UserError('アカウントが見つかりません');
  }

  // ---- タグ ----
  cleanTagName(name) {
    const n = String(name ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!n) throw new UserError('タグ名が空です');
    if (n.length > 40) throw new UserError('タグ名は40文字以内にしてください');
    return n;
  }

  tagId(name, create) {
    const n = this.cleanTagName(name);
    const row = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(n);
    if (row) return row.id;
    if (!create) return null;
    return Number(this.db.prepare('INSERT INTO tags (name) VALUES (?)').run(n).lastInsertRowid);
  }

  editTags(ids, { add = [], remove = [] }) {
    const list = this.checkIds(ids);
    this.tx(() => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO account_tags (account_id, tag_id) VALUES (?, ?)');
      const del = this.db.prepare('DELETE FROM account_tags WHERE account_id = ? AND tag_id = ?');
      for (const name of add) {
        const t = this.tagId(name, true);
        for (const id of list) ins.run(id, t);
      }
      for (const name of remove) {
        const t = this.tagId(name, false);
        if (t !== null) for (const id of list) del.run(id, t);
      }
      this.dropImpliedParents();
    });
  }

  // 小分類が付いている人には、その大分類を重ねて付けない（小分類から分かるため）
  dropImpliedParents() {
    // 付いているタグの上の段（親・祖父母…）を全部たどり、重ねて付いていれば外す
    this.db.exec(`WITH RECURSIVE anc(account_id, tag_id) AS (
        SELECT at.account_id, t.parent_id FROM account_tags at JOIN tags t ON t.id = at.tag_id
        WHERE t.parent_id IS NOT NULL
        UNION
        SELECT anc.account_id, t.parent_id FROM anc JOIN tags t ON t.id = anc.tag_id
        WHERE t.parent_id IS NOT NULL)
      DELETE FROM account_tags WHERE (account_id, tag_id) IN (SELECT account_id, tag_id FROM anc)`);
  }

  // count: そのタグが直接付いている人数 / total: 下の段すべてを含めた人数
  listTags() {
    const tags = this.db.prepare('SELECT id, name, parent_id FROM tags ORDER BY name').all();
    const members = new Map(tags.map((t) => [t.id, new Set()]));
    for (const { account_id, tag_id } of this.db.prepare('SELECT account_id, tag_id FROM account_tags').all()) {
      members.get(tag_id)?.add(account_id);
    }
    const children = new Map();
    for (const t of tags) {
      if (t.parent_id === null) continue;
      if (!children.has(t.parent_id)) children.set(t.parent_id, []);
      children.get(t.parent_id).push(t.id);
    }
    const subtree = (id, out = new Set()) => {
      for (const a of members.get(id) ?? []) out.add(a);
      for (const c of children.get(id) ?? []) subtree(c, out);
      return out;
    };
    return tags.map((t) => ({ ...t, count: members.get(t.id).size, total: subtree(t.id).size }));
  }

  getTag(id) {
    const t = this.db.prepare('SELECT id, name, parent_id FROM tags WHERE id = ?').get(Number(id));
    if (!t) throw new UserError('タグが見つかりません');
    return t;
  }

  // a が b の下の段（子・孫…）にあるか
  isDescendant(a, b) {
    let cur = this.getTag(a).parent_id;
    const seen = new Set();
    while (cur !== null && !seen.has(cur)) {
      if (cur === Number(b)) return true;
      seen.add(cur);
      cur = this.getTag(cur).parent_id;
    }
    return false;
  }

  // 1つ上の段（親）を決める。段の数に制限はないが、自分自身や自分の下の段を親にはできない
  // 誰にも付けずにタグだけを作る（分類を先に用意してから人を振り分けるため）。同じ名前のタグがあれば作らない。
  // 上の分類に直接付いている人の数も返す（下の段ができると、その人たちは下の段へ移す必要があるため）
  createTag(name, parentId = null) {
    const n = this.cleanTagName(name);
    if (this.db.prepare('SELECT 1 FROM tags WHERE name = ?').get(n)) throw new UserError(`「${n}」というタグはもうあります`);
    const parent = parentId === null || parentId === undefined || parentId === '' ? null : this.getTag(parentId);
    let id;
    this.tx(() => {
      id = Number(this.db.prepare('INSERT INTO tags (name, parent_id) VALUES (?, ?)').run(n, parent?.id ?? null).lastInsertRowid);
    });
    const parentDirect = parent
      ? this.db.prepare('SELECT COUNT(*) AS n FROM account_tags WHERE tag_id = ?').get(parent.id).n
      : 0;
    return { id, name: n, parent: parent?.name ?? null, parentDirect };
  }

  setTagParent(id, parentId) {
    const tag = this.getTag(id);
    if (parentId === null || parentId === undefined || parentId === '') {
      this.db.prepare('UPDATE tags SET parent_id = NULL WHERE id = ?').run(tag.id);
      return;
    }
    const parent = this.getTag(parentId);
    if (parent.id === tag.id) throw new UserError('自分自身を上の分類にはできません');
    if (this.isDescendant(parent.id, tag.id)) {
      throw new UserError(`「${parent.name}」は「${tag.name}」の下にあるので、上の分類にはできません`);
    }
    this.tx(() => {
      this.db.prepare('UPDATE tags SET parent_id = ? WHERE id = ?').run(parent.id, tag.id);
      this.dropImpliedParents();
    });
  }

  renameTag(id, name) {
    const tag = this.getTag(id);
    const n = this.cleanTagName(name);
    const clash = this.db.prepare('SELECT id, parent_id FROM tags WHERE name = ? AND id != ?').get(n, tag.id);
    if (clash) {
      // 既にある名前に変えたら、2つのタグを1つにまとめる
      if (this.isDescendant(clash.id, tag.id)) {
        throw new UserError('自分の下の段にあるタグには、まとめられません');
      }
      this.tx(() => {
        this.db
          .prepare('INSERT OR IGNORE INTO account_tags (account_id, tag_id) SELECT account_id, ? FROM account_tags WHERE tag_id = ?')
          .run(clash.id, tag.id);
        this.db.prepare('UPDATE tags SET parent_id = ? WHERE parent_id = ?').run(clash.id, tag.id);
        this.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
        this.dropImpliedParents();
      });
      return { merged: true };
    }
    this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(n, tag.id);
    return { merged: false };
  }

  // タグを消すと、その下の段は1つ上の段（消したタグの親）につながり直す
  deleteTag(id) {
    const tag = this.getTag(id);
    this.tx(() => {
      this.db.prepare('UPDATE tags SET parent_id = ? WHERE parent_id = ?').run(tag.parent_id, tag.id);
      this.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
    });
  }

  // ---- 古い記録の削除 ----
  // フォローもフォロワーも外れてから days 日以上たったアカウントを、タグやメモごと消す
  cleanup(days) {
    const d = Number(days);
    if (!Number.isInteger(d) || d < 0) throw new UserError('日数は0以上の整数にしてください');
    const limit = this.now().getTime() - d * DAY;
    const targets = [];
    for (const [id, r] of this.relations()) {
      if (r.following || r.follower) continue;
      const gone = [r.unfollowedAt, r.followerLostAt].filter(Boolean).map(Date.parse);
      if (gone.length && Math.max(...gone) <= limit) targets.push(id);
    }
    const del = this.db.prepare('DELETE FROM accounts WHERE id = ?');
    this.tx(() => {
      for (const id of targets) del.run(id);
    });
    return { deleted: targets.length };
  }
}
