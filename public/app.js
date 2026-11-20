// 画面の動き。データはすべて手元のサーバー（/api/...）とやり取りする。
// 自己紹介などは他人が書いた文字なので、innerHTML には入れず textContent で表示する。
import { cleanUrl, linkify } from './linkify.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABEL = { waiting: 'フォロバ待ち', loose: 'ゆるく保持', protected: '保護' };
// 種類：どういう立場のアカウントか（タグ＝話題とは別の軸）
const KIND_LABEL = { celebrity: '有名人', creator: '発信者', official: '公式・メディア', general: '一般' };
// 7・8・9・0 キーの順
const KIND_KEYS = { 7: 'celebrity', 8: 'creator', 9: 'official', 0: 'general' };
const VIEWS = {
  unsorted: {
    // 種類とタグを付け終わっても、このタブを開いている間は消さない（じっくり入力できるように）。
    // タブを移るか、ページを開き直すといなくなる
    filter: (a) => a.unsorted || (a.following && state.unsortedKeep.has(a.id)),
    help: 'フォロー中で、種類かタグがまだ付いていない人です。新しくフォローした人はまずここに出ます。種類とタグの両方を付けると「入力済み」になり、タブを移るか開き直すと、ここからいなくなります（入力している間は消えません）。',
    empty: '未入力の人はいません。',
  },
  candidates: {
    filter: (a) => a.candidate,
    help: '「フォロバ待ち」のまま猶予期間を過ぎても返ってこない人です（種類が有名人・発信者・公式・メディアの人は出しません）。「まだ待つ」で猶予期間を数え直す、「ゆるく保持」「保護」で残す、のどれかを押すとこのタブからいなくなります。外すなら名前から X を開いてフォローを解除してください（次の取り込みで外した人に移ります）。',
    empty: '整理候補はいません。',
  },
  review: {
    filter: (a) => a.reviewDue,
    help: '「ゆるく保持」にしてから見直し期間がたった人です。「まだ保持」で見直し期間を数え直す、「フォロバ待ち」で猶予期間を始め直す（たっても返ってこなければ整理候補に出る）、「保護」でずっと残す、のどれかを押すとこのタブからいなくなります。',
    empty: '見直しが必要な人はいません。',
  },
  following: {
    filter: (a) => a.following,
    help: 'フォロー中の全員です。状態・種類・タグをここで付けておきます。同じ人の複数アカウントは本垢の1行にまとまり、▶ で開くとサブ垢が並びます。',
    empty: '該当する人はいません。',
  },
  followers: {
    filter: (a) => a.follower,
    help: 'フォロワーの一覧です。「相互」か「フォロワーのみ」かだけを表示します。',
    empty: 'フォロワーのデータがありません。',
    readonly: true,
  },
  unfollowed: {
    filter: (a) => a.unfollowed || (state.showDismissed && a.unfollowedDismissed),
    // 一覧から消す（list は API に渡す名前、label はボタンの文字）
    dismiss: { list: 'unfollowed', label: '外した人から消す', dismissed: (a) => a.unfollowedDismissed },
    help: '前はフォローしていて、今はフォローしていない人です。タグとメモは残っているので、また見かけたときの参考にできます。もう見なくていい人は「外した人から消す」で一覧から外せます（記録は残り、もう一度フォローして外したときはまた出ます）。',
    empty: 'まだいません。',
  },
};

// 取り込み済みの一覧で最初に出す件数（フォロー・フォロワーの3回分）
const SNAPSHOTS_SHOWN = 6;

const state = {
  showAllSnapshots: false,
  // 未入力タブを開いている間に出した人（入力し終わっても、タブを移るまで残す）
  unsortedKeep: new Set(),
  // 整理候補・外した人のタブで、一覧から消した人も表示するか
  showDismissed: false,
  // サブ垢を開いている本垢の id
  expanded: new Set(),
  view: 'candidates',
  accounts: [],
  byId: new Map(),
  tags: [],
  summary: null,
  selected: new Set(),
  shown: [],
  cursor: -1,
};

// ---------- 通信 ----------
// 合言葉（スマホなど Mac 以外から開くときに必要）。アドレスの ?token= をこのブラウザに覚えてアドレスからは消し、
// 以後は X-XFF-Token ヘッダーで送る。Mac から開くときは要らない。
const TOKEN_KEY = 'xff-token';
const TOKEN = (() => {
  const p = new URLSearchParams(location.search);
  const t = p.get('token');
  if (t) {
    try { localStorage.setItem(TOKEN_KEY, t); } catch { /* 覚えられなくても、このページの間は使える */ }
    p.delete('token');
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
    return t;
  }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
})();

class NeedToken extends Error {}

async function api(path, body) {
  const headers = {};
  if (TOKEN) headers['x-xff-token'] = TOKEN;
  const opt = body === undefined ? { headers } : {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opt);
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.needToken) {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 無視 */ }
    throw new NeedToken();
  }
  if (!res.ok) throw new Error(data.error ?? `通信に失敗しました（${res.status}）`);
  return data;
}

function showNeedToken() {
  document.body.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'need-token',
    textContent: 'このブラウザには合言葉が登録されていないため、データを読み込めません。x-ff を動かしている Mac で「設定 › スマホから使う」に出る合言葉付きのアドレスを、この端末で開き直してください。一度開けば、以後はこのブラウザに記憶されます。',
  }));
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NeedToken) showNeedToken();
    else toast(e.message, true);
    return undefined;
  }
}

// ---------- 読み込み ----------
async function loadAll() {
  const [summary, accounts, tags] = await Promise.all([
    api('/api/summary'), api('/api/accounts'), api('/api/tags'),
  ]);
  state.summary = summary;
  state.accounts = accounts;
  state.byId = new Map(accounts.map((a) => [a.id, a]));
  state.tags = tags;
  for (const id of [...state.selected]) if (!state.byId.has(id)) state.selected.delete(id);
  renderHeader();
  renderTagOptions();
}

async function refresh() {
  await loadAll();
  render();
}

// ---------- 表示 ----------
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const fmtNum = (n) => (n == null ? '-' : n.toLocaleString('ja-JP'));

// FF比（フォロワー ÷ フォロー）。ほぼ同じとみなす幅（設定）の中は灰色のまま、外れた人だけ色を付ける
// （フォロワーがずっと多い＝有名人寄りは青、フォローがずっと多い＝フォロバしがちな人はピンク）。判定は store.js
function ffRatio(a) {
  if (a.ffRatio == null) return null;
  const { ff_low, ff_high } = state.summary.settings;
  const el = document.createElement('span');
  el.className = `ff ${a.ffSide ?? ''}`.trim();
  el.textContent = `FF比 ${a.ffRatio < 1 ? '1%未満' : `${fmtNum(Math.round(a.ffRatio))}%`}`;
  el.title = `フォロワー ÷ フォロー。${a.ffSide === 'more' ? 'フォロワーの方がずっと多い' : a.ffSide === 'less' ? 'フォローの方がずっと多い' : 'ほぼ同じ'}（ほぼ同じとみなす幅：${ff_low}〜${ff_high}%）`;
  return el;
}

function renderHeader() {
  const s = state.summary;
  // 自分（上の行と、3列のときの左の列の下の2か所）。アイコンか @ID を押すと X の自分のプロフィールを開く
  for (const owner of $$('.owner')) {
    $('.owner-name', owner).textContent = s.owner ? `@${s.owner}` : 'まだ取り込んでいません';
    if (s.owner) owner.href = `https://x.com/${encodeURIComponent(s.owner)}`;
    else owner.removeAttribute('href');
    owner.title = s.owner ? 'X で自分のプロフィールを開く' : '';
    // 自分のアイコン（設定で貼ったもの）。読み込めなかったときは壊れた印のまま
    const icon = $('.owner-icon', owner);
    icon.hidden = !s.ownerIcon;
    if (s.ownerIcon && icon.getAttribute('src') !== s.ownerIcon) icon.src = s.ownerIcon;
  }
  const st = $('#stats');
  st.replaceChildren();
  const add = (label, value) => {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = value;
    span.append(`${label} `, b);
    st.append(span);
  };
  add('相互', s.counts.mutual);
  add('フォローのみ', s.counts.oneSided);
  add('フォロワーのみ', s.counts.notFollowedBack);
  // 最終取り込みは「最終取り込み」「フォロー 日時 ／」「フォロワー 日時」の塊ごとに改行する（塊の途中では改行しない）
  if (s.latest.following || s.latest.followers) {
    const span = Object.assign(document.createElement('span'), { className: 'stat-latest' });
    const chunk = (...kids) => {
      const c = Object.assign(document.createElement('span'), { className: 'nb' });
      c.append(...kids);
      return c;
    };
    const b = (t) => Object.assign(document.createElement('b'), { textContent: t });
    span.append(
      chunk('最終取り込み'), ' ',
      chunk(b(`フォロー ${fmtDate(s.latest.following) || '-'}`), ' ／'), ' ',
      chunk(b(`フォロワー ${fmtDate(s.latest.followers) || '-'}`)),
    );
    st.append(span);
  }
  // タブの数はアカウントの数（本垢とサブ垢は別々に数える。サブ垢も別に入力が要るため）
  for (const el of $$('[data-count]')) {
    const n = s.counts[el.dataset.count];
    el.textContent = n ? n : '';
  }
}

// ---------- タグの階層 ----------
// 上の段のあとに下の段を並べた順番（深さ付き）で返す
function tagsInOrder() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const t of state.tags) {
      if (t.parent_id !== parentId) continue;
      out.push({ ...t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
function tagByName(name) {
  return state.tags.find((t) => t.name === name);
}
// 上の段の名前を、近い順に返す（例：ホークス → ['NPB', '野球']）
function ancestorNames(name) {
  const out = [];
  let t = tagByName(name);
  const seen = new Set();
  while (t?.parent_id && !seen.has(t.parent_id)) {
    seen.add(t.parent_id);
    t = state.tags.find((p) => p.id === t.parent_id);
    if (t) out.push(t.name);
  }
  return out;
}
function parentName(name) {
  return ancestorNames(name)[0] ?? null;
}
// 全部の段をつないだ名前（例：野球 › NPB › ホークス）
function tagLabel(name) {
  return [...ancestorNames(name).reverse(), name].join(' › ');
}
// 絞り込み：上の段を選んだら、その下の段のどれかが付いた人も出す
function hasTag(a, name) {
  return a.tags.some((t) => t === name || ancestorNames(t).includes(name));
}

// 今のタブに出る人だけで、タグごとの人数（下の段を含む）を数える
function tagCountsInView() {
  const v = view();
  const people = v ? state.accounts.filter(v.filter) : state.accounts;
  const counts = new Map();
  let none = 0;
  for (const a of people) {
    if (!a.tags.length) none++;
    const names = new Set();
    for (const t of a.tags) for (const n of [t, ...ancestorNames(t)]) names.add(n);
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return { counts, none };
}

// タグを付ける欄（選ぶ欄）の中身。木の順に絞り込みと同じ字下げで並べる。
// 下の段があるタグには直接付けない決まりなので選べないようにし、付いているタグも選べないようにする。
// いちばん下に「新しいタグを作る」を置く
const NEW_TAG = '__new';
function fillTagPicker(sel, attached, placeholder) {
  const cur = sel.value;
  const opt = (value, textContent, disabled = false) => Object.assign(document.createElement('option'), { value, textContent, disabled });
  const hasKids = new Set(state.tags.map((t) => t.parent_id).filter(Boolean));
  sel.replaceChildren(
    opt('', placeholder),
    ...tagsInOrder().map((t) => {
      const indent = t.depth ? `${'　'.repeat(t.depth)}└ ` : '';
      const on = attached.includes(t.name);
      return opt(t.name, `${indent}${t.name}${on ? '（付いている）' : ''}`, hasKids.has(t.id) || on);
    }),
    opt(NEW_TAG, '＋新しいタグを作る…'),
  );
  sel.value = [...sel.options].some((o) => o.value === cur && !o.disabled) ? cur : '';
}
// 「新しいタグを作る」を選んだら名前を聞く。やめたら null
function pickedTagName(sel) {
  if (sel.value !== NEW_TAG) return sel.value || null;
  const name = prompt('新しいタグの名前')?.trim();
  if (!name) { sel.value = ''; return null; }
  return name;
}

function renderTagOptions() {
  fillTagPicker($('#bulk-tag'), [], 'タグを選ぶ');
  const sel = $('#f-tag');
  const cur = sel.value;
  const { counts, none } = tagCountsInView();
  for (const o of $$('option', sel)) if (!['', '__none'].includes(o.value)) o.remove();
  $('option[value="__none"]', sel).textContent = `タグなし（${none}）`;
  for (const t of tagsInOrder()) {
    const indent = t.depth ? `${'　'.repeat(t.depth)}└ ` : '';
    const label = `${indent}${t.name}（${counts.get(t.name) ?? 0}）`;
    sel.append(Object.assign(document.createElement('option'), { value: t.name, textContent: label }));
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

function setView(view) {
  if (state.view !== view) {
    state.selected.clear();
    state.cursor = -1;
    state.unsortedKeep = new Set();
  }
  state.view = view;
  for (const b of $$('#tabs button')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
}

function render() {
  const isList = view() !== null;
  $('#list-view').hidden = !isList;
  $('#side').hidden = !isList;
  $('#view-help').hidden = !isList;
  $('#import-view').hidden = state.view !== 'import';
  $('#settings-view').hidden = state.view !== 'settings';
  if (isList) renderList();
  else if (state.view === 'import') renderImport();
  else if (state.view === 'settings') renderSettings();
}

function view() {
  return VIEWS[state.view] ?? null;
}

function matches(a) {
  const q = $('#q').value.trim().toLowerCase();
  if (q) {
    const hay = `${a.name}\n${a.username}\n${a.bio}\n${a.note}\n${a.tags.map(tagLabel).join(' ')}`.toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  const tag = $('#f-tag').value;
  if (tag === '__none' && a.tags.length) return false;
  if (tag && tag !== '__none' && !hasTag(a, tag)) return false;
  const st = $('#f-status').value;
  if (st === 'followed-back') {
    if (!(a.status === 'waiting' && a.mutual)) return false;
  } else if (st === 'waiting') {
    if (!(a.status === 'waiting' && !a.mutual)) return false;
  } else if (st && a.status !== st) return false;
  const kind = $('#f-kind').value;
  if (kind === '__none' && a.kind) return false;
  if (kind && kind !== '__none' && a.kind !== kind) return false;
  const fb = $('#f-fb').value;
  if (fb === 'yes' && !a.followBack) return false;
  if (fb === 'no' && a.followBack) return false;
  const mu = $('#f-mutual').value;
  if (mu === 'yes' && !a.mutual) return false;
  if (mu === 'no' && a.mutual) return false;
  return true;
}

function sortKey(a) {
  if (state.view === 'candidates') return [a.mutualBroken ? 0 : 1, a.username.toLowerCase()];
  if (state.view === 'unfollowed') return [-(Date.parse(a.unfollowedAt) || 0), a.username.toLowerCase()];
  return [0, a.username.toLowerCase()];
}
function compare(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function renderList() {
  const v = view();
  // タグの人数は今のタブの人だけで数えるので、タブや一覧が変わるたびに作り直す
  renderTagOptions();
  $('#view-help').textContent = v.help;
  $('#f-status').hidden = v.readonly;
  $('#bulk').hidden = !!v.readonly;
  $('#show-dismissed-wrap').hidden = !v.dismiss;
  $('#show-dismissed').checked = state.showDismissed;
  $('#bulk-dismiss').hidden = !v.dismiss;
  if (v.dismiss) $('#bulk-dismiss').textContent = `選んだ人を${v.dismiss.label}`;
  $('#bulk-undismiss').hidden = !(v.dismiss && state.showDismissed);
  if (state.view === 'unsorted') for (const x of state.accounts) if (x.unsorted) state.unsortedKeep.add(x.id);
  const all = state.accounts.filter(v.filter);
  const { order, subsOf, people, total } = groupForView(all);
  state.shown = order;
  $('#shown').textContent = people === total ? `${total}人` : `${people} / ${total}人`;
  const rows = $('#rows');
  rows.replaceChildren(...state.shown.map((a) => buildRow(a, v, subsOf)));
  $('#empty').hidden = state.shown.length > 0;
  $('#empty').textContent = all.length ? '条件に合う人はいません。' : v.empty;
  if (state.cursor >= state.shown.length) state.cursor = state.shown.length - 1;
  markCursor(false);
  updateBulk();
}


// 同じ人の複数アカウントを、本垢の1行にまとめる。
// - 本垢がこのタブに出ているなら、サブ垢は本垢の下に入り、▶ で開いたときだけ本垢の直後に並ぶ
// - 本垢がこのタブに出ていないサブ垢は、ふつうの行として出す（「@本垢 のサブ垢」と表示）
// - 絞り込みは1アカウントずつ判定し、組のどれかが合えば本垢の行を出す
// 戻り値の order は画面に並ぶ順（キー操作と一括選択もこの順を使う）、people は行（人）の数
function groupForView(all) {
  const inView = new Set(all.map((a) => a.id));
  const rootOf = (a) => (a.main_id && inView.has(a.main_id) ? a.main_id : a.id);
  const subsOf = new Map();
  for (const a of all) {
    if (rootOf(a) !== a.id) {
      if (!subsOf.has(a.main_id)) subsOf.set(a.main_id, []);
      subsOf.get(a.main_id).push(a);
    }
  }
  const roots = new Set();
  for (const a of all) if (matches(a)) roots.add(rootOf(a));
  const order = [];
  const top = [...roots].map((id) => state.byId.get(id)).sort(compare);
  for (const r of top) {
    order.push(r);
    if (state.expanded.has(r.id)) order.push(...(subsOf.get(r.id) ?? []).sort(compare));
  }
  const total = all.filter((a) => rootOf(a) === a.id).length;
  return { order, subsOf, people: top.length, total };
}

const SAFE_USERNAME = /^[A-Za-z0-9_]{1,30}$/;
function profileUrl(a) {
  return SAFE_USERNAME.test(a.username) ? `https://x.com/${a.username}` : null;
}

function buildRow(a, v, subsOf = new Map()) {
  const li = $('#row-tpl').content.firstElementChild.cloneNode(true);
  li.dataset.id = a.id;
  if (v.readonly) li.classList.add('readonly');
  // 同じ人の複数アカウント
  const subs = subsOf.get(a.id) ?? [];
  const main = a.main_id ? state.byId.get(a.main_id) : null;
  const isSubRow = !!main && [...subsOf.values()].some((list) => list.includes(a));
  const ex = $('.expand', li);
  if (subs.length) {
    ex.hidden = false;
    const open = state.expanded.has(a.id);
    ex.textContent = `${open ? '▼' : '▶'} ほか${subs.length}`;
    ex.setAttribute('aria-expanded', String(open));
  }
  if (isSubRow) li.classList.add('sub');
  const ga = $('.group-actions', li);
  if (main || subs.length) {
    ga.hidden = !!v.readonly;
    $('.make-main', ga).hidden = !main;
    $('.copy-main', ga).hidden = !main;
    $('.unlink', ga).textContent = main ? '別の人にする' : 'まとめを解除';
    $('.unlink', ga).title = main ? 'このアカウントだけ組から外す' : 'この組をばらして、全員を別々のアカウントに戻す';
  }
  const sel = $('.sel', li);
  sel.checked = state.selected.has(a.id);
  const img = $('.avatar', li);
  // アイコンは X の画像サーバーから直接読む（他人のプロフィールから来たアドレスなので、X の画像の置き場所だけを許す）。
  // アイコン未設定の人は X の標準アイコン（abs.twimg.com）。読み込めなかったときは、ブラウザの「壊れた画像」の印のまま
  if (/^https:\/\/(pbs\.twimg\.com\/|abs\.twimg\.com\/sticky\/default_profile_images\/)/.test(a.profile_image_url)) {
    img.src = a.profile_image_url;
  }
  const link = $('.name', li);
  link.textContent = a.name || a.username;
  const url = profileUrl(a);
  if (url) link.href = url;
  $('.handle', li).textContent = `@${a.username}`;
  fillBio($('.bio', li), a.bio);
  fillBadges($('.badges', li), a);
  markEntered(li, a);
  // 未入力タブ：自己紹介でお互いの ID に触れているアカウントがあれば「同じ人かも」を出す。押すとまとめるか聞く
  if (state.view === 'unsorted') {
    for (const p of a.maybeSame ?? []) {
      const b = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'badge maybe-same',
        textContent: `同じ人かも：@${p.username}`,
        title: '自己紹介でお互いの ID に触れているか、プロフィールのリンク先が同じです。押すと、同じ人としてまとめるか確かめます',
      });
      b.dataset.other = p.id;
      $('.badges', li).append(b);
    }
  }
  if (main) {
    const b = Object.assign(document.createElement('span'), {
      className: 'badge',
      textContent: isSubRow ? 'サブ垢' : `@${main.username} のサブ垢`,
      title: `本垢：${main.name || main.username}（@${main.username}）`,
    });
    $('.badges', li).prepend(b);
  }
  const meta = [`フォロワー ${fmtNum(a.followers_count)}`, `フォロー ${fmtNum(a.following_count)}`, ffRatio(a), `ポスト ${fmtNum(a.tweet_count)}`].filter(Boolean);
  if (a.following) meta.push(a.followingSince ? `フォロー開始 ${fmtDate(a.followingSince)}ごろ` : '記録開始前からフォロー');
  if (!a.following && a.unfollowedAt) meta.push(`外した ${fmtDate(a.unfollowedAt)}ごろ`);
  if (a.followerLostAt && !a.follower) meta.push(`フォローを外された ${fmtDate(a.followerLostAt)}ごろ`);
  // 項目ごとに塊にして、1つの項目の途中では改行しない（改行は項目の間でだけ起きる。区切りの「·」は CSS で前の項目に付ける）
  const item = (m) => (typeof m === 'string' ? Object.assign(document.createElement('span'), { textContent: m }) : m);
  $('.meta', li).replaceChildren(...meta.flatMap((m, i) => (i ? [' ', item(m)] : [item(m)])));
  for (const b of $$('.status button', li)) b.setAttribute('aria-pressed', String(b.dataset.status === a.status));
  for (const b of $$('.kind button', li)) b.setAttribute('aria-pressed', String(b.dataset.kind === a.kind));
  // 相互の人はもうフォローを返してもらっているので、「フォロバ待ち」ではなく「相互」と出す
  // （中身の状態は同じ。相互が外れると整理候補に出る）
  if (a.mutual) {
    const w = $('.status button[data-status="waiting"]', li);
    w.textContent = '相互';
    w.classList.add('followed-back');
    w.title = '相互なので返してもらい済み（相互が外れると整理候補に出ます）';
    // 相互の人は状態ボタンを全部押せないようにする（「相互」は印として表示するだけ）
    for (const b of $$('.status button', li)) b.disabled = true;
  }
  // 整理候補・見直しでは、押してある状態のボタンを「まだ待つ」「まだ保持」と出す。
  // 押すと猶予期間・見直し期間をそこから数え直し、どのボタンを押してもこのタブからいなくなる
  if (state.view === 'candidates' && !a.mutual) {
    const w = $('.status button[data-status="waiting"]', li);
    w.textContent = 'まだ待つ';
    w.title = '1：猶予期間をここから数え直して、もう少しフォロバを待つ';
  }
  if (state.view === 'review') {
    const l = $('.status button[data-status="loose"]', li);
    l.textContent = 'まだ保持';
    l.title = '2：見直し期間をここから数え直して、まだ残す';
  }
  if (v.dismiss) {
    const gone = v.dismiss.dismissed(a);
    $('.dismiss-actions', li).hidden = false;
    const b = $('.dismiss', li);
    b.textContent = gone ? '一覧に戻す' : v.dismiss.label;
    b.dataset.on = String(!gone);
    if (gone) $('.badges', li).prepend(Object.assign(document.createElement('span'), { className: 'badge', textContent: '一覧から消した' }));
  }
  renderChips(li, a);
  $('.note', li).value = a.note;
  return li;
}

// 未入力タブで、種類とタグを付け終わった人に「入力済み」の印を付ける（外れたら印も外す）
function markEntered(li, a) {
  li.querySelector('.badge.entered')?.remove();
  if (state.view !== 'unsorted' || a.unsorted) return;
  $('.badges', li).prepend(Object.assign(document.createElement('span'), {
    className: 'badge mutual entered',
    textContent: '入力済み',
    title: '種類とタグが付きました。タブを移ると未入力からいなくなります',
  }));
}

function fillBadges(el, a) {
  const add = (text, cls, title = '') => el.append(Object.assign(document.createElement('span'), { className: `badge ${cls}`, textContent: text, title }));
  if (a.following && a.follower) add('相互', 'mutual');
  else if (a.following && a.mutualBroken) add('相互が外れた', 'broken');
  else if (a.following && !a.follower && state.summary.latest.followers) add('フォローのみ', 'one');
  else if (a.follower && !a.following) add('フォロワーのみ', '');
  if (a.is_private) add('鍵', '');
  if (a.followBack) add('フォロバ宣言', 'fb', `自己紹介か名前に「${a.followBack}」とあります`);
  if (a.following && !a.follower && a.status === 'waiting' && a.expectsFollowBack && a.graceLeft > 0) add(`候補まであと${a.graceLeft}日`, '');
  if (a.following && !a.follower && a.status === 'loose' && a.reviewLeft > 0 && state.view !== 'review') add(`見直しまで${a.reviewLeft}日`, '');
}

function renderChips(li, a) {
  const chips = $('.chips', li);
  const order = tagsInOrder().map((t) => t.name);
  const sorted = [...a.tags].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  chips.replaceChildren(...sorted.map((t) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.title = tagLabel(t); // 全部の段はマウスを乗せると見える
    const p = parentName(t);
    if (p) c.append(Object.assign(document.createElement('span'), { className: 'chip-parent', textContent: `${p} › ` }));
    c.append(t);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = `「${t}」を外す`;
    x.dataset.removeTag = t;
    c.append(x);
    return c;
  }));
}

function updateBulk() {
  const n = state.selected.size;
  $('#sel-count').textContent = `${n}件選択`;
  $('.bulk-actions').setAttribute('aria-disabled', String(n === 0));
  const shownIds = state.shown.map((a) => a.id);
  const allSel = $('#sel-all');
  allSel.checked = shownIds.length > 0 && shownIds.every((id) => state.selected.has(id));
  allSel.indeterminate = !allSel.checked && shownIds.some((id) => state.selected.has(id));
}

// ---------- 操作 ----------
// 相互の人は状態を変えない（相互が外れたら整理候補に出るので、そのとき決める）
function isMutual(id) {
  return !!state.accounts.find((a) => a.id === id)?.mutual;
}

async function setStatus(ids, status) {
  const skipped = ids.filter(isMutual).length;
  const target = ids.filter((id) => !isMutual(id));
  if (!target.length) {
    if (skipped) toast('相互の人の状態は変えられません');
    return;
  }
  await guard(async () => {
    await api('/api/accounts/status', { ids: target, status });
    await refresh();
    if (ids.length > 1) {
      toast(`${target.length}件を「${STATUS_LABEL[status]}」にしました${skipped ? `（相互の${skipped}件はそのまま）` : ''}`);
    }
  });
}

// 今のタブ（整理候補・外した人）の一覧から消す。on = false で戻す
async function dismissFromList(ids, on = true) {
  const d = view()?.dismiss;
  if (!d || !ids.length) return;
  await guard(async () => {
    await api('/api/accounts/dismiss', { ids, list: d.list, on });
    for (const id of ids) state.selected.delete(id);
    await refresh();
    if (ids.length > 1 || on) toast(on ? `${ids.length}件を${d.label.replace('から消す', '')}から消しました（「消した人も表示」で戻せます）` : `${ids.length}件を一覧に戻しました`);
  });
}

// 本垢の行で、サブ垢を開く・閉じる
function toggleExpand(a) {
  if (state.expanded.has(a.id)) state.expanded.delete(a.id);
  else state.expanded.add(a.id);
  renderList();
}

// kind が null なら未設定に戻す
async function setKind(ids, kind) {
  await guard(async () => {
    await api('/api/accounts/kind', { ids, kind });
    await refresh();
    if (ids.length > 1) toast(`${ids.length}件を「${KIND_LABEL[kind]}」にしました`);
  });
}
// 1人分：押した種類にする（押してある種類をもう一度押しても未設定には戻さない。
// 「一般」を確かめのつもりで押して外れてしまうのを防ぐ）
function toggleKind(a, kind) {
  if (a.kind === kind) return;
  return setKind([a.id], kind);
}

async function editTags(ids, add, remove) {
  return guard(async () => {
    await api('/api/accounts/tags', { ids, add, remove });
    // 大分類が自動で外れることがあるので、付け外しの結果はサーバーから読み直す
    const [tags, accounts, summary] = await Promise.all([api('/api/tags'), api('/api/accounts'), api('/api/summary')]);
    state.tags = tags;
    // タブの人数（未入力など）も新しくする。一覧そのものは、続けてタグを付けられるようにそのままにする
    state.summary = summary;
    const fresh = new Map(accounts.map((x) => [x.id, x]));
    renderTagOptions();
    for (const id of ids) {
      const a = state.byId.get(id);
      if (!a) continue;
      // タグだけでなく、タグで変わる判定（未入力など）も新しい値にそろえる
      if (fresh.has(id)) Object.assign(a, fresh.get(id));
      const li = $(`.row[data-id="${CSS.escape(id)}"]`);
      if (li) {
        renderChips(li, a);
        // 一覧は出し直さない（続けてタグを付けられるように）ので、入力済みの印だけ付け直す
        markEntered(li, a);
      }
    }
    // タブの数は各アカウントの新しい判定から数えるので、更新したあとに出し直す
    renderHeader();
    return true;
  });
}

function rowOf(el) {
  const li = el.closest('.row');
  return li ? state.byId.get(li.dataset.id) : null;
}

$('#rows').addEventListener('click', async (e) => {
  const a = rowOf(e.target);
  if (!a) return;
  const li = e.target.closest('.row');
  state.cursor = state.shown.findIndex((x) => x.id === a.id);
  markCursor(false, li);
  const st = e.target.closest('[data-status]');
  if (st) return setStatus([a.id], st.dataset.status);
  const kd = e.target.closest('[data-kind]');
  if (kd) return toggleKind(a, kd.dataset.kind);
  if (e.target.closest('.expand')) return toggleExpand(a);
  const ms = e.target.closest('.maybe-same');
  if (ms) {
    e.preventDefault();
    const other = state.byId.get(ms.dataset.other);
    if (!other) return;
    // 本垢の決め方：自己紹介に「本垢→@相手」のように書いてあれば相手が本垢。
    // 書いていなければ、もう入力済みのほうを本垢にする（あとで「本垢にする」で変えられる）
    const saysMain = (x, y) => new RegExp(`本垢[^@]{0,6}@${y.username}\\b`, 'i').test(x.bio ?? '');
    const [main, sub] = saysMain(a, other) ? [other, a]
      : saysMain(other, a) ? [a, other]
      : a.unsorted && !other.unsorted ? [other, a]
      : (other.followers_count ?? 0) >= (a.followers_count ?? 0) ? [other, a] : [a, other];
    if (!confirm(`@${a.username} と @${other.username} を同じ人としてまとめますか？\n本垢：@${main.username}（あとで変えられます）`)) return;
    return guard(async () => {
      await api('/api/accounts/link', { main: main.id, subs: [sub.id] });
      await refresh();
      toast('同じ人としてまとめました');
    });
  }
  const dm = e.target.closest('.dismiss');
  if (dm) return dismissFromList([a.id], dm.dataset.on === 'true');
  if (e.target.closest('.copy-main')) {
    return guard(async () => {
      await api('/api/accounts/copy-from-main', { id: a.id });
      await refresh();
      toast('本垢の種類とタグを貼り付けました');
    });
  }
  if (e.target.closest('.make-main')) {
    return guard(async () => { await api('/api/accounts/main', { id: a.id }); state.expanded.add(a.id); await refresh(); });
  }
  if (e.target.closest('.unlink')) {
    const msg = a.main_id ? `@${a.username} を組から外して、別の人として表示しますか？` : `@${a.username} の組をばらして、全員を別々に表示しますか？`;
    if (!confirm(msg)) return;
    return guard(async () => { await api('/api/accounts/unlink', { ids: [a.id] }); await refresh(); });
  }
  const rm = e.target.closest('[data-remove-tag]');
  if (rm) return editTags([a.id], [], [rm.dataset.removeTag]);
  if (e.target.classList.contains('sel')) {
    if (e.target.checked) state.selected.add(a.id);
    else state.selected.delete(a.id);
    updateBulk();
  }
});

$('#rows').addEventListener('keydown', async (e) => {
  if (e.isComposing) return;
  if (e.target.classList.contains('note') && e.key === 'Enter') e.target.blur();
});

// タグを足す欄：開く直前に中身を入れる（行ごとに全部のタグを入れておくと重いので）
for (const type of ['pointerdown', 'focusin']) {
  $('#rows').addEventListener(type, (e) => {
    if (!e.target.classList.contains('tag-in')) return;
    const a = rowOf(e.target);
    if (a) fillTagPicker(e.target, a.tags, '+タグ');
  });
}
$('#rows').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('tag-in')) return;
  const sel = e.target;
  const a = rowOf(sel);
  const name = pickedTagName(sel);
  sel.value = '';
  if (a && name) await editTags([a.id], [name], []);
});

$('#rows').addEventListener('change', (e) => {
  if (!e.target.classList.contains('note')) return;
  const a = rowOf(e.target);
  if (!a) return;
  const note = e.target.value;
  guard(async () => {
    await api('/api/accounts/note', { id: a.id, note });
    a.note = note;
    toast('メモを保存しました');
  });
});

// 一括操作
$('#sel-all').addEventListener('change', (e) => {
  for (const a of state.shown) {
    if (e.target.checked) state.selected.add(a.id);
    else state.selected.delete(a.id);
  }
  for (const cb of $$('#rows .sel')) cb.checked = e.target.checked;
  updateBulk();
});
for (const b of $$('[data-bulk-status]')) {
  b.addEventListener('click', () => setStatus([...state.selected], b.dataset.bulkStatus));
}
for (const b of $$('[data-bulk-kind]')) {
  b.addEventListener('click', () => setKind([...state.selected], b.dataset.bulkKind));
}
$('#bulk-dismiss').addEventListener('click', () => {
  if (!state.selected.size) return toast('消す人を選んでください', true);
  dismissFromList([...state.selected], true);
});
$('#bulk-undismiss').addEventListener('click', () => {
  if (!state.selected.size) return toast('戻す人を選んでください', true);
  dismissFromList([...state.selected], false);
});
$('#show-dismissed').addEventListener('change', (e) => { state.showDismissed = e.target.checked; state.cursor = -1; renderList(); });

// 選んだアカウントを同じ人としてまとめる。フォロワーがいちばん多いものを本垢にする（あとで「本垢にする」で変えられる）
$('#bulk-link').addEventListener('click', () => {
  const picked = [...state.selected].map((id) => state.byId.get(id)).filter(Boolean);
  if (picked.length < 2) return toast('まとめるアカウントを2つ以上選んでください', true);
  const main = [...picked].sort((x, y) => (y.followers_count ?? 0) - (x.followers_count ?? 0))[0];
  if (!confirm(`${picked.map((p) => `@${p.username}`).join('、')} を同じ人としてまとめます。\n本垢：@${main.username}（あとで変えられます）`)) return;
  guard(async () => {
    await api('/api/accounts/link', { main: main.id, subs: picked.map((p) => p.id).filter((id) => id !== main.id) });
    state.selected.clear();
    await refresh();
    toast(`${picked.length}アカウントをまとめました`);
  });
});
// まとめて操作のタグ：「新しいタグを作る」を選んだら、その名前を選んだ状態にしておく
$('#bulk-tag').addEventListener('change', (e) => {
  if (e.target.value !== NEW_TAG) return;
  const name = pickedTagName(e.target);
  if (!name) return;
  e.target.append(Object.assign(document.createElement('option'), { value: name, textContent: `${name}（新しいタグ）` }));
  e.target.value = name;
});
$('#bulk-tag-add').addEventListener('click', async () => {
  const name = $('#bulk-tag').value;
  if (!name) return toast('タグを選んでください', true);
  if (await editTags([...state.selected], [name], [])) toast(`${state.selected.size}件に「${name}」を付けました`);
});
$('#bulk-tag-remove').addEventListener('click', async () => {
  const name = $('#bulk-tag').value;
  if (!name) return toast('タグを選んでください', true);
  if (await editTags([...state.selected], [], [name])) toast(`${state.selected.size}件から「${name}」を外しました`);
});

for (const id of ['#q', '#f-tag', '#f-status', '#f-kind', '#f-mutual', '#f-fb']) {
  $(id).addEventListener('input', () => { state.cursor = -1; renderList(); });
}

// ---------- 自己紹介のリンク ----------
// 自己紹介の URL・メールアドレス・@ID をリンクにする（見つけ方は linkify.js。テストあり）。
// 他人が書いた文字なので、文字は textContent で入れ、リンク先も http(s)・mailto・x.com だけにする
function fillBio(el, text) {
  el.replaceChildren(...linkify(text).map((p) => {
    if (p.type === 'text') return p.text;
    const a = Object.assign(document.createElement('a'), { className: `bio-link ${p.type}`, href: p.href, textContent: p.text });
    if (p.type !== 'email') Object.assign(a, { target: '_blank', rel: 'noopener noreferrer' });
    return a;
  }));
}

// ---------- 自己紹介の全文（マウスを乗せたとき） ----------
// 一覧では自己紹介を3行までにしているので、自己紹介かフォロワー数などの行に乗せたら、
// 全文・プロフィールのリンク・フォロワー数などの行をカードで出す（自己紹介が空の人もリンクを見られるように）。
// カードにはマウスを移せる（リンクを押せるように）。タッチの端末では押すと出し、ほかを押すと消す
const CARD_TARGET = '.bio, .meta';
const hovercard = Object.assign(document.createElement('div'), { className: 'hovercard', hidden: true });
document.body.append(hovercard);
let hcTimer = null;
let hcFor = null;
function safeLink(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol) ? cleanUrl(url.href) : null;
  } catch { return null; }
}
function showBioCard(bioEl) {
  const li = bioEl.closest('.row');
  const a = rowOf(bioEl);
  if (!a || (!a.bio && !a.url)) return;
  hcFor = bioEl;
  const parts = [];
  if (a.bio) {
    const p = Object.assign(document.createElement('p'), { className: 'hc-bio' });
    fillBio(p, a.bio);
    parts.push(p);
  }
  const href = safeLink(a.url);
  if (href) {
    parts.push(Object.assign(document.createElement('a'), {
      className: 'hc-url', href, target: '_blank', rel: 'noopener noreferrer',
      textContent: href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
    }));
  }
  const meta = $('.meta', li)?.cloneNode(true);
  if (meta) { meta.classList.add('hc-meta'); parts.push(meta); }
  hovercard.replaceChildren(...parts);
  hovercard.hidden = false;
  // 自己紹介のすぐ下に出す。下に入りきらなければ上に出す。左右は画面からはみ出さないようにする
  const r = bioEl.getBoundingClientRect();
  const w = hovercard.offsetWidth;
  const h = hovercard.offsetHeight;
  hovercard.style.left = `${Math.max(12, Math.min(r.left - 16, innerWidth - w - 12))}px`;
  hovercard.style.top = `${r.bottom + 6 + h <= innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
}
function hideBioCard() {
  clearTimeout(hcTimer);
  hovercard.hidden = true;
  hcFor = null;
}
// マウス：少し止めたら出す（行の上を通り過ぎただけで出ないように）。離れたら少し待って消す（カードへ移れるように）
$('#rows').addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const bio = e.target.closest(CARD_TARGET);
  if (!bio) return;
  clearTimeout(hcTimer);
  if (hcFor === bio) return;
  hcTimer = setTimeout(() => showBioCard(bio), hcFor ? 0 : 350);
});
$('#rows').addEventListener('pointerout', (e) => {
  if (e.pointerType === 'touch' || !e.target.closest(CARD_TARGET)) return;
  clearTimeout(hcTimer);
  hcTimer = setTimeout(hideBioCard, 200);
});
hovercard.addEventListener('pointerenter', () => clearTimeout(hcTimer));
hovercard.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hcTimer = setTimeout(hideBioCard, 200); });
// タッチ：自己紹介を押すと出す・もう一度押すと消す。ほかの所を押しても消す
document.addEventListener('click', (e) => {
  if (hovercard.contains(e.target)) return;
  if (e.target.closest('#rows a')) return; // @ID などのリンクを押したときは、リンクを開くだけ
  const bio = e.target.closest('#rows .bio, #rows .meta');
  if (bio && matchMedia('(hover: none)').matches) {
    if (hcFor === bio) hideBioCard();
    else showBioCard(bio);
    return;
  }
  hideBioCard();
});
window.addEventListener('scroll', () => { if (!hovercard.hidden) hideBioCard(); }, { passive: true });

// ---------- キーボード ----------
function markCursor(scroll = true, li = null) {
  for (const r of $$('#rows .row.current')) r.classList.remove('current');
  const target = li ?? $$('#rows .row')[state.cursor];
  if (!target) return;
  target.classList.add('current');
  if (scroll) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  const inField = e.target.matches('input, select, textarea');
  if (e.key === 'Escape' && inField) { e.target.blur(); return; }
  if (inField || !view()) return;
  const cur = state.shown[state.cursor];
  const li = $$('#rows .row')[state.cursor];
  const ro = view().readonly;
  switch (e.key) {
    case 'j': case 'ArrowDown':
      e.preventDefault();
      state.cursor = Math.min(state.cursor + 1, state.shown.length - 1);
      markCursor();
      break;
    case 'k': case 'ArrowUp':
      e.preventDefault();
      state.cursor = Math.max(state.cursor - 1, 0);
      markCursor();
      break;
    case '/': e.preventDefault(); $('#q').focus(); break;
    case '1': case '2': case '3':
      if (cur && !ro) setStatus([cur.id], ['waiting', 'loose', 'protected'][Number(e.key) - 1]);
      break;
    case '7': case '8': case '9': case '0':
      if (cur && !ro) toggleKind(cur, KIND_KEYS[e.key]);
      break;
    case 'e': if (cur && li && !$('.expand', li).hidden) toggleExpand(cur); break;
    case 't': if (li && !ro) { e.preventDefault(); $('.tag-in', li).focus(); } break;
    case 'o': if (cur && profileUrl(cur)) window.open(profileUrl(cur), '_blank', 'noopener,noreferrer'); break;
    case 'x':
      if (cur && !ro) {
        if (state.selected.has(cur.id)) state.selected.delete(cur.id);
        else state.selected.add(cur.id);
        $('.sel', li).checked = state.selected.has(cur.id);
        updateBulk();
      }
      break;
    default: return;
  }
});

// ---------- 取り込み ----------
async function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.name.toLowerCase().endsWith('.json'));
  const log = $('#import-log');
  if (files.length === 0) return toast('JSON ファイルを選んでください', true);
  const payload = await Promise.all(files.map(async (f) => ({ filename: f.name, content: await f.text() })));
  const data = await guard(() => api('/api/import', { files: payload }));
  if (!data) return;
  setView('import');
  log.replaceChildren();
  const line = (text, cls) => log.append(Object.assign(document.createElement('div'), { className: cls, textContent: text }));
  for (const r of data.results) {
    const kind = r.kind === 'following' ? 'フォロー' : 'フォロワー';
    if (r.error) line(`失敗：${r.filename} — ${r.error}`, 'err');
    else if (r.duplicate) line(`取り込み済みなので飛ばしました：${r.filename}`, 'muted');
    else {
      line(`${kind} ${r.count}人を取り込みました${r.isFirst ? '（初回）' : `（前回から +${r.added} / −${r.removed}）`}：${r.filename}`, 'ok');
      if (r.warning) line(`注意：${r.warning}`, 'warn');
    }
  }
  await refresh();
}

$('#file').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('#drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

// ダウンロードフォルダの自動取り込みの状態を出す（サーバーが --watch で動いているときだけ）
async function renderAutoImport() {
  const el = $('#autoimport');
  const s = await api('/api/autoimport').catch(() => null);
  if (!s?.enabled) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('err', !!s.error);
  const last = s.last
    ? `最後の自動取り込み：${fmtDate(s.last.at)} ${s.last.filename}（${s.last.error ?? (s.last.duplicate ? '取り込み済みだった' : `${s.last.count}人`)}）`
    : 'まだ自動で取り込んだファイルはありません。';
  el.textContent = s.error
    ? s.error
    : `「${s.dir}」を見張っています。xporter で JSON を出力すると、ここにドラッグしなくても自動で取り込み、取り込んだファイルは消します。${last}`;
}

async function renderImport() {
  renderAutoImport();
  const snaps = await guard(() => api('/api/snapshots'));
  if (!snaps) return;
  const table = $('#snapshots');
  table.replaceChildren();
  if (snaps.length === 0) {
    table.append(Object.assign(document.createElement('caption'), { textContent: 'まだありません', className: 'muted' }));
    return;
  }
  const head = table.insertRow();
  for (const h of ['取得日時', '種類', '人数', 'ファイル', '']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
  // 溜まると見づらいので、ふだんは新しい分（フォロー・フォロワー3回分）だけ出す
  const shown = state.showAllSnapshots ? snaps : snaps.slice(0, SNAPSHOTS_SHOWN);
  for (const s of shown) {
    const tr = table.insertRow();
    tr.insertCell().textContent = fmtDate(s.taken_at);
    tr.insertCell().textContent = s.kind === 'following' ? 'フォロー' : 'フォロワー';
    tr.insertCell().textContent = s.count;
    tr.insertCell().textContent = s.source_file;
    const b = Object.assign(document.createElement('button'), { textContent: '削除', className: 'danger', type: 'button' });
    b.addEventListener('click', () => {
      if (!confirm(`${fmtDate(s.taken_at)} の${s.kind === 'following' ? 'フォロー' : 'フォロワー'}の取り込みを削除しますか？\n取り込みの記録は、フォローを始めた日・外した日・相互が外れたことを判断する履歴です。間違えて取り込んだもの以外は消さないでください。\nどの取り込みにも出てこなくなった人は、タグ・メモごと消えます。`)) return;
      guard(async () => { await api('/api/snapshots/delete', { id: s.id }); await refresh(); toast('削除しました'); });
    });
    tr.insertCell().append(b);
  }
  if (snaps.length > SNAPSHOTS_SHOWN) {
    const cell = table.insertRow().insertCell();
    cell.colSpan = 5;
    const more = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: state.showAllSnapshots ? '新しい分だけ表示' : `古い取り込みも表示（あと${snaps.length - SNAPSHOTS_SHOWN}件）`,
    });
    more.addEventListener('click', () => { state.showAllSnapshots = !state.showAllSnapshots; renderImport(); });
    cell.append(more);
  }
}

// ---------- 設定 ----------
// ---------- 設定のタグの木 ----------
// 名前の列を樹形図ふうにする：親子・兄弟をつなぎの線（│ ├ └）で見せ、下の段があるタグは ▼／▶ でたたむ。
// たたんだタグはこの端末のブラウザに覚える
const COLLAPSE_KEY = 'xff-tag-collapsed';
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]')); } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch {}
}
// 表に出す順の行。guides は祖先の段ごとに縦線を引くか（その段の祖先のあとに兄弟が続くか）
function tagTreeRows(collapsed) {
  const kids = new Map();
  for (const t of state.tags) {
    const k = t.parent_id ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t);
  }
  const countDesc = (id) => (kids.get(id) ?? []).reduce((n, c) => n + 1 + countDesc(c.id), 0);
  const rows = [];
  const walk = (parentId, depth, guides) => {
    const list = kids.get(parentId) ?? [];
    list.forEach((t, i) => {
      const isLast = i === list.length - 1;
      const hasKids = kids.has(t.id);
      rows.push({ t, depth, isLast, guides, hasKids, desc: hasKids ? countDesc(t.id) : 0 });
      if (hasKids && !collapsed.has(t.id)) walk(t.id, depth + 1, depth > 0 ? [...guides, !isLast] : []);
    });
  };
  walk(null, 0, []);
  return rows;
}
function treeNameCell({ t, depth, isLast, guides, hasKids, desc }, collapsed, input) {
  const box = Object.assign(document.createElement('div'), { className: 'tree-name' });
  const guide = (cls) => Object.assign(document.createElement('span'), { className: `tg ${cls}` });
  for (const pipe of guides) box.append(guide(pipe ? 'pipe' : 'blank'));
  if (depth > 0) box.append(guide(isLast ? 'elbow' : 'tee'));
  if (hasKids) {
    const open = !collapsed.has(t.id);
    const b = Object.assign(document.createElement('button'), {
      type: 'button', className: 'tree-toggle', textContent: open ? '▼' : '▶',
      title: open ? '下の段をたたむ' : '下の段を開く',
    });
    b.setAttribute('aria-expanded', String(open));
    b.addEventListener('click', () => {
      if (open) collapsed.add(t.id);
      else collapsed.delete(t.id);
      saveCollapsed(collapsed);
      renderSettings();
    });
    // 開いているときは、▼ の下から次の行（下の段）へ縦線をつなぐ
    const wrap = guide(open ? 'toggle open' : 'toggle');
    wrap.append(b);
    box.append(wrap);
  } else {
    box.append(guide('leaf'));
  }
  box.append(input);
  if (hasKids && collapsed.has(t.id)) {
    box.append(Object.assign(document.createElement('span'), { className: 'tree-hidden muted', textContent: `（${desc}）`, title: `たたんでいる下の段のタグ：${desc}個` }));
  }
  return box;
}

function renderSettings() {
  $('#theme').value = document.documentElement.dataset.theme ?? '';
  $('#owner-icon-form').url.value = state.summary.ownerIcon ?? '';
  renderLanUrls();
  const f = $('#settings-form');
  f.grace_days.value = state.summary.settings.grace_days;
  f.review_days.value = state.summary.settings.review_days;
  f.ff_low.value = state.summary.settings.ff_low;
  f.ff_high.value = state.summary.settings.ff_high;
  // 新しいタグを作る欄の「上の分類」（木の順に、全部の段をつないだ名前で並べる）
  const parentPick = $('#tag-create-form').parent;
  const pickCur = parentPick.value;
  parentPick.replaceChildren(
    Object.assign(document.createElement('option'), { value: '', textContent: '上の分類：なし（いちばん上）' }),
    ...tagsInOrder().map((p) => Object.assign(document.createElement('option'), { value: String(p.id), textContent: `上の分類：${tagLabel(p.name)}` })),
  );
  parentPick.value = [...parentPick.options].some((o) => o.value === pickCur) ? pickCur : '';
  const table = $('#tags');
  table.replaceChildren();
  if (state.tags.length === 0) {
    table.append(Object.assign(document.createElement('caption'), { textContent: 'まだタグはありません。上の欄か、一覧の「+タグ」から作れます。', className: 'muted' }));
    return;
  }
  const head = table.insertRow();
  for (const h of ['名前', '上の分類', '人数', '']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
  const ordered = tagsInOrder();
  const collapsed = loadCollapsed();
  for (const row of tagTreeRows(collapsed)) {
    const { t } = row;
    const tr = table.insertRow();
    tr.className = 'tree-row';
    const input = Object.assign(document.createElement('input'), { value: t.name });
    input.addEventListener('change', () => guard(async () => {
      const r = await api('/api/tags/rename', { id: t.id, name: input.value });
      await refresh();
      toast(r.merged ? 'タグをまとめました' : 'タグ名を変えました');
    }));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) input.blur(); });
    tr.insertCell().append(treeNameCell(row, collapsed, input));
    // 上の分類の選択。自分自身と、自分の下の段にあるタグは選べない
    const parentSel = document.createElement('select');
    parentSel.append(Object.assign(document.createElement('option'), { value: '', textContent: 'なし（いちばん上）' }));
    for (const p of ordered) {
      if (p.id === t.id || ancestorNames(p.name).includes(t.name)) continue;
      parentSel.append(Object.assign(document.createElement('option'), { value: String(p.id), textContent: tagLabel(p.name) }));
    }
    parentSel.value = t.parent_id ? String(t.parent_id) : '';
    const { hasKids } = row;
    parentSel.addEventListener('change', () => guard(async () => {
      await api('/api/tags/parent', { id: t.id, parent_id: parentSel.value ? Number(parentSel.value) : null });
      await refresh();
      toast(parentSel.value ? `「${t.name}」を「${parentSel.selectedOptions[0].textContent}」の下に入れました` : `「${t.name}」をいちばん上の分類にしました`);
      return true;
    }).then((ok) => { if (!ok) parentSel.value = t.parent_id ? String(t.parent_id) : ''; }));
    tr.insertCell().append(parentSel);
    // 人数（下の段を含む）。下の段があるタグは、直接付いている人数も添える（スマホでは隠す）
    const cnt = tr.insertCell();
    cnt.className = 'tag-count';
    cnt.append(String(hasKids ? t.total : t.count));
    if (hasKids) cnt.append(Object.assign(document.createElement('span'), { className: 'direct', textContent: `（直接 ${t.count}）` }));
    const b = Object.assign(document.createElement('button'), { textContent: '削除', className: 'danger', type: 'button' });
    b.addEventListener('click', () => {
      const note = hasKids ? '\n下の段のタグは残り、1つ上の段につながり直します。' : '';
      if (!confirm(`タグ「${t.name}」を削除しますか？（${t.count}人から外れます）${note}`)) return;
      guard(async () => { await api('/api/tags/delete', { id: t.id }); await refresh(); toast('タグを削除しました'); });
    });
    tr.insertCell().append(b);
  }
}

// スマホから使う：合言葉付きのアドレスを出す（この Mac で開いているときだけサーバーが教えてくれる）
async function renderLanUrls() {
  const box = $('#lan-urls');
  const r = await fetch('/api/lan-url').catch(() => null);
  if (!r || r.status === 403) { $('#lan-section').hidden = true; return; } // スマホなど、ほかの端末から開いているとき
  $('#lan-section').hidden = false;
  $('#lan-help').hidden = !r.ok;
  if (!r.ok) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'help', textContent: '今はこの Mac からだけ使えます。npm start -- --lan（または ./serve.sh）で起動すると、同じ Wi-Fi のスマホからも使えるようになります。',
    }));
    return;
  }
  const { urls } = await r.json();
  box.replaceChildren(...urls.map((u) => {
    const row = Object.assign(document.createElement('div'), { className: 'lan-url' });
    const code = Object.assign(document.createElement('code'), { textContent: u });
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: 'コピー' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(u); toast('アドレスをコピーしました'); } catch { toast('コピーできませんでした', true); }
    });
    row.append(code, b);
    return row;
  }));
}

// 新しいタグを作る（誰にも付けずに、分類だけを先に用意できる）。作ったタグが見えるよう、上の段のたたみを開く
$('#tag-create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const parentId = f.parent.value ? Number(f.parent.value) : null;
  guard(async () => {
    const r = await api('/api/tags/create', { name: f.tagname.value, parent_id: parentId });
    const collapsed = loadCollapsed();
    for (let t = state.tags.find((x) => x.id === parentId); t; t = state.tags.find((x) => x.id === t.parent_id)) collapsed.delete(t.id);
    saveCollapsed(collapsed);
    f.tagname.value = '';
    await refresh();
    const note = r.parentDirect ? `。「${r.parent}」に直接付いている人が${r.parentDirect}人います（下の段に移してください）` : '';
    toast(`タグ「${r.name}」を作りました${note}`);
  });
});

// タグの木：全部開く・全部たたむ
$('#tags-expand').addEventListener('click', () => { saveCollapsed(new Set()); renderSettings(); });
$('#tags-collapse').addEventListener('click', () => {
  saveCollapsed(new Set(state.tags.filter((t) => state.tags.some((c) => c.parent_id === t.id)).map((t) => t.id)));
  renderSettings();
});

$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  guard(async () => {
    await api('/api/settings', {
      grace_days: f.grace_days.value, review_days: f.review_days.value, ff_low: f.ff_low.value, ff_high: f.ff_high.value,
    });
    await refresh();
    toast('設定を保存しました');
  });
});

$('#owner-icon-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = e.target.url.value.trim();
  guard(async () => {
    await api('/api/owner-icon', { url });
    await refresh();
    toast(url ? '自分のアイコンを保存しました' : '自分のアイコンを消しました');
  });
});

$('#cleanup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const days = e.target.days.value;
  if (!confirm(`フォローもフォロワーも外れてから ${days} 日以上たった人の記録を削除します。元に戻せません。よろしいですか？`)) return;
  guard(async () => {
    const r = await api('/api/cleanup', { days: Number(days) });
    await refresh();
    toast(`${r.deleted}人の記録を削除しました`);
  });
});

// 表示テーマ（空は Mac の設定に合わせる）。この端末のブラウザにだけ覚える
$('#theme').addEventListener('change', (e) => {
  const t = e.target.value;
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { t ? localStorage.setItem('xff-theme', t) : localStorage.removeItem('xff-theme'); } catch {}
});

// ---------- 起動 ----------
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (v && v !== state.view && $(`#tabs [data-view="${v}"]`)) setView(v);
});

// ダウンロードフォルダから自動で取り込まれたら、開いている画面も更新する。
// 画面が見えている間だけ、最新の取り込み日時を15秒ごとに確かめる
const latestKey = (s) => `${s?.latest?.following ?? ''}|${s?.latest?.followers ?? ''}`;
setInterval(async () => {
  if (document.hidden || !state.summary) return;
  const s = await api('/api/summary').catch(() => null);
  if (!s || latestKey(s) === latestKey(state.summary)) return;
  await refresh();
  toast('新しいエクスポートを自動で取り込みました');
}, 15000);

(async () => {
  await guard(loadAll);
  if (!state.summary) return;
  const fromHash = location.hash.slice(1);
  const initial = $(`#tabs [data-view="${fromHash}"]`) ? fromHash
    : (state.summary?.owner ? (state.summary.counts.unsorted ? 'unsorted' : 'candidates') : 'import');
  setView(initial);
})();
