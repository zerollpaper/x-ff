// 自己紹介の文字から、リンクにする部分（URL・メールアドレス・@ID）を見つける。
// 画面（app.js）とテスト（test/linkify.test.js）の両方から使うので、DOM には触らず、部品の並びだけを返す。
//   { type: 'text', text }                    … そのまま出す文字
//   { type: 'url', text, href }               … URL（https:// のないもの・www. で始まるもの・よくある末尾のドメインも拾う）
//   { type: 'email', text, href: 'mailto:…' } … メールアドレス（押すとメールのアプリで新しいメールを作る）
//   { type: 'mention', text, href }           … @ID（X のそのアカウントへのリンク。全角の ＠ も X と同じく扱う）

// URL に使える文字（ASCII だけ。日本語の直前で URL が終わるように）
const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]";
// https:// のないドメインは、よく使われる末尾のものだけリンクにする（「ver.2.0」「Node.js」などを誤ってリンクにしないため）
const BARE_TLDS = 'com|net|org|jp|co|io|me|tv|link|app|dev|info|xyz|site|online|fm|gg|ly|to|shop|store|blog|page|tokyo|art|fun|live|studio|world|club';

const PATTERN = new RegExp(
  [
    // メールアドレス
    '(?<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,})',
    // https:// か www. で始まる URL
    `(?<url>(?:https?://|www\\.)${URL_CHARS}+)`,
    // https:// のないドメイン（例：lit.link/abc、youtube.com/@abc）
    `(?<bare>(?<![A-Za-z0-9_@./-])[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${BARE_TLDS})(?![A-Za-z0-9-])(?:/${URL_CHARS}*)?)`,
    // @ID（前が英数字や @ ならメールアドレスなどの一部なので拾わない。16文字以上は X の ID になれないので拾わない）
    '(?<mpre>^|[^A-Za-z0-9_@＠.])(?<at>[@＠])(?<user>[A-Za-z0-9_]{1,15})(?![A-Za-z0-9_@＠])',
  ].join('|'),
  'g',
);

// URL の終わりに付いた句読点や閉じかっこは、URL に含めない（「…/abc)」「…/abc。」など）
function trimUrl(s) {
  let t = s;
  for (;;) {
    const last = t.at(-1);
    if (/[.,!?:;'"\]]/.test(last)) t = t.slice(0, -1);
    else if (last === ')' && (t.match(/\(/g) ?? []).length < (t.match(/\)/g) ?? []).length) t = t.slice(0, -1);
    else return t;
  }
}

function safeHref(s) {
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return ['http:', 'https:'].includes(u.protocol) ? cleanUrl(u.href) : null;
  } catch {
    return null;
  }
}

// 追跡用の文字（どこから来たか・誰がシェアしたかの印）をリンクから外す。なくてもページは同じように開く。
// 追跡用だとはっきりしている名前だけを外し、ほかは残す（サイトによっては必要なものがあるため）
const TRACKING_ANY = /^(utm_.+|fbclid|gclid)$/i;
const TRACKING_BY_SITE = [
  [/(^|\.)instagram\.com$/i, ['igsh', 'igshid', 'stkn']],
  [/(^|\.)(youtube\.com|youtu\.be)$/i, ['si', 'feature']],
  [/^open\.spotify\.com$/i, ['si']],
  [/(^|\.)(x\.com|twitter\.com)$/i, ['s', 't']],
  [/(^|\.)amazon\.(co\.jp|jp|com)$/i, ['ref_']],
];
export function cleanUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  const site = TRACKING_BY_SITE.find(([re]) => re.test(u.hostname))?.[1] ?? [];
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_ANY.test(key) || site.includes(key.toLowerCase())) u.searchParams.delete(key);
  }
  return u.href;
}

export function linkify(text) {
  const src = String(text ?? '');
  const out = [];
  let last = 0;
  const pushText = (t) => {
    if (!t) return;
    const prev = out.at(-1);
    if (prev?.type === 'text') prev.text += t;
    else out.push({ type: 'text', text: t });
  };
  for (const m of src.matchAll(PATTERN)) {
    const g = m.groups;
    let start = m.index;
    let part = null;
    if (g.email) {
      part = { type: 'email', text: g.email, href: `mailto:${g.email}` };
    } else if (g.url || g.bare) {
      const t = trimUrl(g.url ?? g.bare);
      const href = safeHref(t);
      if (href) part = { type: 'url', text: t, href };
    } else if (g.user) {
      start += g.mpre.length;
      part = { type: 'mention', text: g.at + g.user, href: `https://x.com/${g.user}` };
    }
    if (!part) continue;
    pushText(src.slice(last, start));
    out.push(part);
    last = start + part.text.length;
  }
  pushText(src.slice(last));
  return out;
}
