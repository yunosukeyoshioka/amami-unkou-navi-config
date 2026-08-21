// フェリー各社の公式運航状況ページから、対象航路（鹿児島〜奄美〜沖縄）に
// 関係する部分だけを狙って取得し、「通常運行 / 条件付き運行 / 運行見合わせ /
// 欠航 / 不明」に分類する。ページ全体のキーワード検索だと無関係な航路や
// FAQ文言まで拾ってしまうため、cheerioでDOM構造を絞り込んでから判定する。
import { writeFileSync } from 'fs';
import * as cheerio from 'cheerio';

const UA = 'amami-unkou-navi-bot/1.0 (+https://github.com/yunosukeyoshioka/amami-unkou-navi-config)';

// 優先度の高いキーワードから順に判定（欠航が一番強いシグナル）
const KEYWORD_PRIORITY = [
  { keyword: '欠航', status: 'cancelled' },
  { keyword: '運休', status: 'cancelled' },
  { keyword: '見合わせ', status: 'suspended' },
  { keyword: '条件付', status: 'conditional' },
  { keyword: 'スケジュール変更', status: 'conditional' },
  { keyword: '運航遅延', status: 'conditional' },
  { keyword: '遅延', status: 'conditional' },
  { keyword: '通常運航', status: 'normal' },
  { keyword: '通常どおり', status: 'normal' },
];

// 深刻度の順序（不明を除く）。複数区間・複数便がある場合はこの順で
// 「一番悪いステータス」を代表値として採用する（安全側に倒すため）。
const SEVERITY = ['normal', 'conditional', 'suspended', 'cancelled'];

function classify(text) {
  for (const { keyword, status } of KEYWORD_PRIORITY) {
    if (text.includes(keyword)) return status;
  }
  return 'unknown';
}

function worstStatus(statuses) {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.reduce((worst, s) =>
    SEVERITY.indexOf(s) > SEVERITY.indexOf(worst) ? s : worst
  );
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// マルエーフェリー: 鹿児島〜奄美〜沖縄航路を担当する「あけぼの」「波之上」
// の2隻分のブロック（div.status-archive）だけを見る。
async function scrapeAline() {
  const html = await fetchHtml('https://aline-ferry.com/status/');
  const $ = cheerio.load(html);

  const blocks = $('div.status-archive')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const heading = collapse($el.find('h3').first().text());
      // h4はその船の直近のお知らせ見出し（例: 「8/20(木)鹿児島発下り便…条件付き運航」）
      const headline = collapse($el.find('h4').first().text()) || heading;
      const text = collapse($el.text());
      return { heading, headline, text };
    })
    .filter((b) => b.heading.includes('あけぼの') || b.heading.includes('波之上'));

  if (blocks.length === 0) {
    throw new Error('aline: target vessel blocks not found (page structure may have changed)');
  }

  const statuses = blocks.map((b) => classify(b.text));
  const status = worstStatus(statuses);
  // 一番状態の悪い船の見出し文（お知らせタイトル）を代表テキストとして使う
  const worstBlock =
    blocks.find((b) => classify(b.text) === status) ?? blocks[0];

  return {
    id: 'aline_ferry',
    operatorName: 'マルエーフェリー',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note: worstBlock.headline,
    officialUrl: 'https://aline-ferry.com/status/',
  };
}

// マリックスライン: トップページの運航状況バナー（下り便・上り便）のみを見る。
// FAQセクション等の無関係なテキストは対象外。
async function scrapeMarix() {
  const html = await fetchHtml('https://marixline.com/');
  const $ = cheerio.load(html);

  const items = $('div.service_status_banner a.status_single')
    .toArray()
    .map((el) => collapse($(el).text()));

  if (items.length === 0) {
    throw new Error('marix: status banner not found (page structure may have changed)');
  }

  const statuses = items.map((t) => classify(t));
  const status = worstStatus(statuses);
  const worstItem = items[statuses.findIndex((s) => s === status)] ?? items[0];

  return {
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note: worstItem.replace('もっと詳しく', '').trim(),
    officialUrl: 'https://marixline.com/',
  };
}

// 航空便: JALの公式発着案内はAkamaiのbot対策でGitHub Actionsからも
// ブロックされる（IPレピュテーションによるブロックとみられ、ヘッドレス
// ブラウザでも回避できなかった）。代わりに奄美空港自体の公式サイト
// （航空会社ではなく空港ターミナルビル運営者が掲載）を使う。
// bot対策はなく、JAL/JAC・Peach・スカイマークなど就航する全社の
// 本日の出発便が1つの表に載っている。
const AIRPORT_URL = 'https://amami-airport.co.jp/flight/today';

function classifyFlightStatus(statusText, scheduled, changed) {
  if (statusText.includes('欠航')) return 'cancelled';
  if (statusText.includes('見合わせ')) return 'suspended';
  if (statusText.includes('遅延')) return 'conditional';
  // ステータス文言に出ない遅延（「出発済み」のまま定刻から変更された等）も
  // 時刻変更の有無で拾う。
  if (changed && changed !== scheduled) return 'conditional';
  return 'normal';
}

async function scrapeAirportDepartures() {
  const html = await fetchHtml(AIRPORT_URL);
  const $ = cheerio.load(html);

  // 「目的地」ヘッダを持つtableが出発便（到着便は「出発地」ヘッダ）。
  // ページはレスポンシブ対応で同じ表が複製されていることがあるため、
  // 最初に見つかったものだけを使う。
  let depTable = null;
  $('table').each((_, el) => {
    if (depTable) return;
    const headerText = collapse($(el).find('th').text());
    if (headerText.includes('目的地')) depTable = el;
  });
  if (!depTable) {
    throw new Error('airport: departures table not found (page structure may have changed)');
  }

  const rows = $(depTable).find('tr').toArray().slice(1); // 先頭はヘッダ行
  const flights = rows
    .map((row) => {
      const tds = $(row).find('td');
      return {
        scheduled: collapse($(tds[0]).text()),
        changed: collapse($(tds[1]).text()),
        destination: collapse($(tds[2]).text()),
        flightNo: collapse($(tds[4]).text()),
        statusText: collapse($(tds[5]).text()),
      };
    })
    .filter((f) => f.flightNo && f.scheduled);

  if (flights.length === 0) {
    throw new Error('airport: no departure rows parsed (page structure may have changed)');
  }

  const classified = flights.map((f) => ({
    flightNo: f.flightNo,
    destination: f.destination,
    scheduledTime: f.scheduled,
    actualTime: f.changed || f.scheduled,
    status: classifyFlightStatus(f.statusText, f.scheduled, f.changed),
    note: f.statusText || null,
  }));

  const status = worstStatus(classified.map((f) => f.status));
  const troubled = classified.filter((f) => f.status !== 'normal');
  const note =
    troubled.length === 0
      ? `本日${classified.length}便中、欠航はありません。`
      : `本日${classified.length}便中${troubled.length}便に遅延・欠航等があります。`;

  return {
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発（JAL・Peach・スカイマーク他）',
    mode: 'air',
    status,
    note,
    officialUrl: AIRPORT_URL,
    flights: classified,
  };
}

async function safe(fn, fallbackFactory) {
  try {
    return await fn();
  } catch (err) {
    console.error(`scrape failed: ${err}`);
    return fallbackFactory();
  }
}

const [aline, marix, airport] = await Promise.all([
  safe(scrapeAline, () => ({
    id: 'aline_ferry',
    operatorName: 'マルエーフェリー',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: 'https://aline-ferry.com/status/',
  })),
  safe(scrapeMarix, () => ({
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: 'https://marixline.com/',
  })),
  safe(scrapeAirportDepartures, () => ({
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発（JAL・Peach・スカイマーク他）',
    mode: 'air',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: AIRPORT_URL,
    flights: [],
  })),
]);

const output = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  operators: [aline, marix, airport],
};

writeFileSync('transport_status.json', `${JSON.stringify(output, null, 2)}\n`);
console.log('wrote transport_status.json');
console.log(JSON.stringify(output, null, 2));
