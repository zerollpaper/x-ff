// 手元で動くWebサーバー。画面（public/）とデータ操作のAPIを出す。
// --lan を付けると、同じ Wi-Fi のスマホなどからも接続を受け付ける。
//   - この Mac からの接続は今までどおり合言葉なしで使える。
//   - ほかの端末からは、画面のファイル（個人データなし）だけ合言葉なしで返し、/api/ は合言葉が要る。
//   - 合言葉は data/.lan-token に保存する。画面は ?token= 付きのアドレスで開くと合言葉をブラウザに覚え、
//     以後は X-XFF-Token ヘッダーで送ってくる。
//   - GET /api/lan-url（この Mac からだけ）：スマホで開くための合言葉付きのアドレス（設定画面の「スマホから使う」に出す）
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAutoImporter } from './autoimport.js';
import { parseExportFilename, Store, UserError } from './store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_BODY = 50 * 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new UserError('Content-Type は application/json にしてください');
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new UserError('送られたデータが大きすぎます');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new UserError('JSON として読めません');
  }
}

// 他のサイトが DNS を細工してこのサーバーを読み取る攻撃を防ぐため、ホスト名は localhost・IP アドレス・.local だけ受け付ける
export function hostAllowed(host) {
  const h = String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || /^[0-9.]+$/.test(h) || /^[0-9a-fA-F:]+$/.test(h);
}

// この Mac 自身からの接続か（自分の LAN アドレスで開いた場合も含む）
function isLocalRequest(req) {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === req.socket.localAddress;
}

function tokenOk(given, token) {
  if (!token || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function loadToken(file) {
  try {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    // まだないので作る
  }
  const t = randomBytes(16).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${t}\n`, { mode: 0o600 });
  return t;
}

// 同じ Wi-Fi の端末から開くためのアドレス（Bonjour 名と IP アドレス）
export function lanUrls(port, token) {
  const hosts = [];
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (name) hosts.push(`${name}.local`);
  } catch {
    // macOS 以外など
  }
  const nets = networkInterfaces();
  const order = Object.keys(nets).sort((x, y) => (x === 'en0' ? -1 : y === 'en0' ? 1 : 0));
  for (const name of order) {
    for (const n of nets[name] ?? []) {
      if (n.family === 'IPv4' && !n.internal && !hosts.includes(n.address)) hosts.push(n.address);
    }
  }
  return hosts.map((h) => `http://${h}:${port}/?token=${token}`);
}

export function createApp(store, { token = null, port = 4870, isLocal = isLocalRequest, autoImporter = null } = {}) {
  const routes = {
    // ダウンロードフォルダの自動取り込みの状態（見張っていなければ enabled: false）
    'GET /api/autoimport': () => autoImporter?.status() ?? { enabled: false },
    'GET /api/summary': () => store.summary(),
    'GET /api/accounts': () => store.listAccounts(),
    'GET /api/tags': () => store.listTags(),
    'GET /api/snapshots': () => store.listSnapshots(),
    'POST /api/import': (b) => {
      const files = Array.isArray(b.files) ? b.files : [b];
      // 古い順に取り込むと、前回との差分が正しく出る
      const takenAt = (f) => {
        try {
          return parseExportFilename(f.filename).takenAt;
        } catch {
          return '';
        }
      };
      const results = [...files]
        .sort((a, b2) => takenAt(a).localeCompare(takenAt(b2)))
        .map((f) => {
          try {
            return { filename: f.filename, ...store.importExport(f) };
          } catch (e) {
            if (e instanceof UserError) return { filename: f.filename, error: e.message };
            throw e;
          }
        });
      return { results };
    },
    'POST /api/snapshots/delete': (b) => store.deleteSnapshot(b.id),
    'POST /api/accounts/status': (b) => store.setStatus(b.ids, b.status),
    'POST /api/accounts/kind': (b) => store.setKind(b.ids, b.kind ?? null),
    'POST /api/accounts/dismiss': (b) => store.dismissFromList(b.ids, b.list, b.on !== false),
    'POST /api/accounts/link': (b) => store.linkAccounts(b.main, b.subs),
    'POST /api/accounts/unlink': (b) => store.unlinkAccounts(b.ids),
    'POST /api/accounts/main': (b) => store.setMainAccount(b.id),
    'POST /api/accounts/copy-from-main': (b) => store.copyFromMain(b.id),
    'POST /api/accounts/tags': (b) => store.editTags(b.ids, b),
    'POST /api/accounts/note': (b) => store.setNote(b.id, b.note),
    'POST /api/tags/create': (b) => store.createTag(b.name, b.parent_id ?? null),
    'POST /api/tags/rename': (b) => store.renameTag(b.id, b.name),
    'POST /api/tags/delete': (b) => store.deleteTag(b.id),
    'POST /api/tags/parent': (b) => store.setTagParent(b.id, b.parent_id),
    'POST /api/settings': (b) => store.updateSettings(b),
    'POST /api/owner-icon': (b) => store.setOwnerIcon(b.url),
    'POST /api/cleanup': (b) => store.cleanup(b.days),
  };

  return async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'このアドレスでは開けません' });
      const url = new URL(req.url, 'http://localhost');
      const local = isLocal(req);
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/lan-url' && req.method === 'GET') {
          if (!local) return send(res, 403, { error: 'この Mac からだけ使えます' });
          if (!token) return send(res, 404, { error: 'スマホ用の接続（--lan）が有効になっていません' });
          return send(res, 200, { urls: lanUrls(port, token) });
        }
        if (!local && !tokenOk(req.headers['x-xff-token'], token)) {
          return send(res, 403, { error: '合言葉が違います', needToken: true });
        }
        // 他のサイトのページから勝手に書き込まれないよう、同じオリジンからの要求だけ受け付ける
        const origin = req.headers.origin;
        if (req.method === 'POST' && origin && origin !== `http://${req.headers.host}`) {
          return send(res, 403, { error: 'ほかのサイトからは操作できません' });
        }
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const body = req.method === 'POST' ? await readJson(req) : {};
        return send(res, 200, (await handler(body)) ?? { ok: true });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'ありません' });
      if (req.method !== 'GET') return send(res, 405, { error: '使えないメソッドです' });
      // 画面のファイルには個人データが入っていないので、合言葉なしで返す
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
      const file = normalize(join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) return send(res, 403, { error: '見られません' });
      const data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, { error: 'ありません' });
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch (e) {
      if (e instanceof UserError) return send(res, 400, { error: e.message });
      console.error(e);
      send(res, 500, { error: '内部エラーが起きました（サーバーのログを見てください）' });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4870);
  const dataDir = join(ROOT, 'data');
  const dbPath = process.env.XFF_DB ?? join(dataDir, 'x-ff.sqlite');
  const lan = process.argv.includes('--lan');
  const token = lan ? loadToken(join(dataDir, '.lan-token')) : null;
  const store = new Store(dbPath);
  // --watch：ダウンロードフォルダ（XFF_WATCH_DIR で変更可）に出てきた xporter の JSON を自動で取り込む
  const autoImporter = process.argv.includes('--watch')
    ? createAutoImporter(store, { dir: process.env.XFF_WATCH_DIR ?? join(homedir(), 'Downloads') })
    : null;
  autoImporter?.start();
  const server = createServer(createApp(store, { token, port, autoImporter }));
  // 同じ番号ですでに動いているときは、分かりやすい言葉で知らせて終わる
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`x-ff: ${port} 番はすでに使われています。前に起動した x-ff が動いていないか確かめて、止めてからもう一度起動してください。`);
    process.exit(1);
  });
  server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`x-ff: http://localhost:${port} を開いてください（データ: ${dbPath}）`);
    if (lan) {
      console.log('同じ Wi-Fi のスマホからは、次のアドレスを開いてください（合言葉付き。人に教えないでください）:');
      for (const u of lanUrls(port, token)) console.log(`  ${u}`);
    }
  });
}
