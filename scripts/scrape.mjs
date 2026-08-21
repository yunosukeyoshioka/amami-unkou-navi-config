// フェリー各社の公式運航状況ページから、対象航路（鹿児島〜奄美〜沖縄）に
// 関係する部分だけを狙って取得し、「通常運行 / 条件付き運行 / 運行見合わせ /
// 欠航 / 不明」に分類する。ページ全体のキーワード検索だと無関係な航路や
// FAQ文言まで拾ってしまうため、cheerioでDOM構造を絞り込んでから判定する。
import { writeFileSync } from 'fs';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const UA = 'amami-unkou-navi-bot/1.0 (+https://github.com/yunosukeyoshioka/amami-unkou-navi-config)';

// JALはブラウザらしいUser-Agentでないとページ自体は返すが、
// 内部的にはAkamaiのbot対策の影響を受けるため、実ブラウザ相当の
// User-Agentをheadless Chromiumに使わせる。
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    status,
    note: worstItem.replace('もっと詳しく', '').trim(),
    officialUrl: 'https://marixline.com/',
  };
}

// JAL/JAC: 奄美発鹿児島行きの本日の便を、実ブラウザ（Playwright）で取得する。
// 通常のfetchだとAkamaiのbot対策に阻まれる（IPレピュテーションによるブロックの
// 可能性が高く、ヘッドレスブラウザでも回避できないことがある）。
const JAL_URL =
  'https://www.jal.co.jp/jp/ja/flight-status/dom/?FsBtn=route&DATEFLG=&DPORT=ASJ&APORT=KOJ';

function classifyFlightNote(note) {
  if (!note) return 'normal';
  if (note.includes('欠航')) return 'cancelled';
  if (note.includes('見合わせ')) return 'suspended';
  return 'conditional'; // 遅延・時刻変更など
}

async function scrapeJal() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: BROWSER_UA });
    const res = await page.goto(JAL_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!res || !res.ok()) {
      throw new Error(`jal: HTTP ${res?.status()}`);
    }
    await page
      .waitForSelector('div.hdg_inner_box, .xf-content-height', { timeout: 15000 })
      .catch(() => {});

    const rawFlights = await page.$$eval('div.hdg_inner_box', (nodes) =>
      nodes.map((el) => ({
        flightNo: el.querySelector('.box_flight_number')?.textContent?.trim() ?? '',
        departureTime: el.querySelector('.departure-time')?.textContent?.trim() ?? '',
        arrivalTime: el.querySelector('.arrival-time')?.textContent?.trim() ?? '',
        note: el.querySelector('.attention-txt-hdr')?.textContent?.trim() || null,
      }))
    );

    if (rawFlights.length === 0) {
      // 曜日運航等で本日は便が無い可能性もあるため「不明」ではなく通常運行として扱わず、
      // 便一覧が空の状態として返す（アプリ側で「本日の便はありません」と表示できる）。
      return {
        id: 'jal_jac',
        operatorName: 'JAL / JAC',
        routeName: '奄美⇔鹿児島',
        status: 'unknown',
        note: '本日の便情報を取得できませんでした（運航が無い曜日の可能性があります）。',
        officialUrl: JAL_URL,
        flights: [],
      };
    }

    const flights = rawFlights.map((f) => ({
      flightNo: f.flightNo,
      departureTime: f.departureTime,
      arrivalTime: f.arrivalTime,
      status: classifyFlightNote(f.note),
      note: f.note,
    }));

    const status = worstStatus(flights.map((f) => f.status));
    const troubled = flights.filter((f) => f.status !== 'normal');
    const note =
      troubled.length === 0
        ? `本日${flights.length}便すべて通常運航です。`
        : `本日${flights.length}便中${troubled.length}便に運航状況の変化があります。`;

    return {
      id: 'jal_jac',
      operatorName: 'JAL / JAC',
      routeName: '奄美⇔鹿児島',
      status,
      note,
      officialUrl: JAL_URL,
      flights,
    };
  } finally {
    await browser.close();
  }
}

async function safe(fn, fallbackFactory) {
  try {
    return await fn();
  } catch (err) {
    console.error(`scrape failed: ${err}`);
    return fallbackFactory();
  }
}

const [aline, marix, jal] = await Promise.all([
  safe(scrapeAline, () => ({
    id: 'aline_ferry',
    operatorName: 'マルエーフェリー',
    routeName: '鹿児島〜奄美〜沖縄',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: 'https://aline-ferry.com/status/',
  })),
  safe(scrapeMarix, () => ({
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: 'https://marixline.com/',
  })),
  safe(scrapeJal, () => ({
    id: 'jal_jac',
    operatorName: 'JAL / JAC',
    routeName: '奄美⇔鹿児島',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: JAL_URL,
    flights: [],
  })),
]);

const output = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  operators: [aline, marix, jal],
};

writeFileSync('transport_status.json', `${JSON.stringify(output, null, 2)}\n`);
console.log('wrote transport_status.json');
console.log(JSON.stringify(output, null, 2));
