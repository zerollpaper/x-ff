// コマンドから取り込む: npm run import -- XPorter_following_....json XPorter_followers_....json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExportFilename, Store, UserError } from './store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('使い方: npm run import -- <xporter の JSON ファイル>...');
  process.exit(1);
}
const store = new Store(process.env.XFF_DB ?? join(ROOT, 'data', 'x-ff.sqlite'));
const key = (f) => {
  try {
    return parseExportFilename(f).takenAt;
  } catch {
    return '';
  }
};
let failed = false;
for (const f of [...files].sort((a, b) => key(a).localeCompare(key(b)))) {
  try {
    const r = store.importExport({ filename: f, content: readFileSync(f, 'utf8') });
    if (r.duplicate) console.log(`取り込み済み: ${f}`);
    else {
      const diff = r.isFirst ? '（初回）' : `（+${r.added} / -${r.removed}）`;
      console.log(`${r.kind}: ${r.count}件 ${diff} ${f}`);
      if (r.warning) console.warn(`  注意: ${r.warning}`);
    }
  } catch (e) {
    failed = true;
    console.error(`失敗: ${f}: ${e instanceof UserError ? e.message : e.stack}`);
  }
}
store.close();
process.exit(failed ? 1 : 0);
