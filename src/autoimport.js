// ダウンロードフォルダを見張り、xporter が書き出した JSON を自動で取り込む。
// - 対象は XPorter_(following|followers)_<owner>_exported_<日時>.json だけ（CSV や別名のファイルは見ない）。
// - 一度処理したファイル名は meta に覚え、二度は取り込まない（取り込みの記録をわざと消したあとに
//   サーバーを再起動しても、同じファイルが戻ってこないようにするため）。
// - 起動時は、すでに取り込んだ一番新しい記録より新しいファイルだけを取り込む
//   （昔のエクスポートが残っていても、履歴の最初に割り込ませないため）。
// - Chrome は .crdownload に書いてから名前を変えるので、名前が対象の形になった時点で中身は揃っている。
//   念のため少し待ってから読み、JSON として読めなければ何回か読み直す。
import { readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { parseExportFilename, UserError } from './store.js';

const PATTERN = /^XPorter_(following|followers)_.+_exported_\d{4}-\d{2}-\d{2}-at-\d{2}-\d{2}-\d{2}( \(\d+\))?\.json$/;
const META_KEY = 'auto_imported';
const KEEP = 500; // 覚えておくファイル名の数（古いものから忘れる）

export function isExportFile(name) {
  return PATTERN.test(name);
}

export function createAutoImporter(store, { dir, delayMs = 1500, retries = 3, log = console.log } = {}) {
  const db = store.db;
  const status = { enabled: true, dir, error: null, last: null };
  const timers = new Map();
  let watcher = null;

  const processed = () => {
    try {
      return new Set(JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY)?.value ?? '[]'));
    } catch {
      return new Set();
    }
  };
  const remember = (name) => {
    const list = [...processed(), name].slice(-KEEP);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      META_KEY,
      JSON.stringify(list),
    );
  };

  // 1つのファイルを取り込む。戻り値は結果（テストと画面の表示に使う）
  function handle(name) {
    if (!isExportFile(name) || processed().has(name)) return null;
    let content;
    try {
      content = readFileSync(join(dir, name), 'utf8');
      JSON.parse(content);
    } catch (e) {
      // 書き込み途中などで読めない：呼んだ側がもう一度試す
      return { filename: name, retry: true, error: e.code === 'ENOENT' ? 'ファイルがありません' : 'まだ読めません' };
    }
    let result;
    try {
      result = { filename: name, ...store.importExport({ filename: name, content }) };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      result = { filename: name, error: e.message };
    }
    remember(name);
    status.last = { ...result, at: store.now().toISOString() };
    log(`x-ff 自動取り込み: ${name} → ${result.error ?? (result.duplicate ? '取り込み済み' : `${result.count}人`)}`);
    return result;
  }

  // 少し待ってから取り込む。読めなければ何回か待ち直す
  function schedule(name, left = retries) {
    clearTimeout(timers.get(name));
    timers.set(
      name,
      setTimeout(() => {
        timers.delete(name);
        try {
          const r = handle(name);
          if (r?.retry && left > 0) schedule(name, left - 1);
        } catch (e) {
          status.error = `取り込みに失敗しました: ${e.message}`;
          log(status.error);
        }
      }, delayMs),
    );
  }

  // 起動時：フォルダにあるファイルのうち、取り込み済みの記録より新しいものだけを取り込む
  function scan() {
    let names;
    try {
      names = readdirSync(dir).filter(isExportFile);
    } catch (e) {
      status.error = folderError(e, dir);
      return [];
    }
    const latest = {};
    for (const s of db.prepare('SELECT kind, max(taken_at) AS t FROM snapshots GROUP BY kind').all()) latest[s.kind] = s.t;
    const done = processed();
    const results = [];
    const sorted = names
      .filter((n) => !done.has(n))
      .map((n) => ({ n, info: parseExportFilename(n) }))
      .sort((a, b) => a.info.takenAt.localeCompare(b.info.takenAt));
    for (const { n, info } of sorted) {
      if (latest[info.kind] && info.takenAt <= latest[info.kind]) {
        remember(n); // 古いエクスポートは取り込まず、二度と見ない
        continue;
      }
      const r = handle(n);
      if (r) results.push(r);
    }
    return results;
  }

  function start() {
    scan();
    try {
      watcher = watch(dir, (_event, name) => {
        if (name && isExportFile(String(name))) schedule(String(name));
      });
      watcher.on('error', (e) => { status.error = folderError(e, dir); });
      log(`x-ff: ${dir} を見張っています（xporter の JSON を自動で取り込みます）`);
    } catch (e) {
      status.error = folderError(e, dir);
      log(`x-ff: ${status.error}`);
    }
  }

  function stop() {
    watcher?.close();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { handle, scan, start, stop, status: () => ({ ...status }) };
}

function folderError(e, dir) {
  if (e.code === 'EPERM' || e.code === 'EACCES') {
    return `${dir} を読む許可がありません（システム設定 › プライバシーとセキュリティ › ファイルとフォルダ で node に「ダウンロード」フォルダへのアクセスを許可してください）`;
  }
  if (e.code === 'ENOENT') return `${dir} が見つかりません`;
  return `${dir} を見張れません: ${e.message}`;
}
