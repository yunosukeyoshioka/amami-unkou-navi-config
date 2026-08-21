// フェリー各社・奄美空港の公式ページから、鹿児島〜奄美〜沖縄航路に関係する
// 部分だけを狙って取得し、「通常運行 / 条件付き運行 / 運行見合わせ /
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
// の2隻分のブロック（div.status-archive）だけを見る。各船のお知らせ本文から
// 「◯月◯日(木)鹿児島新港18:00発」のような出港時刻を正規表現で拾う
// （公式サイトに寄港地別の構造化データが無いため、これが取得できる限界）。
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

  const departures = blocks.map((b) => {
    const vesselName = b.heading.includes('あけぼの') ? 'フェリーあけぼの' : 'フェリー波之上';
    // 本文（text）には「遅延」等を含む定型の注意書きが全船共通で入っており、
    // それを拾うと正常運航の船まで誤って条件付き扱いになってしまう。
    // その船固有のお知らせ見出し（headline）だけで判定する。
    const status = classify(b.headline);
    const m = b.text.match(/(\d{1,2})月(\d{1,2})日[^0-9]{0,12}(\d{1,2}:\d{2})発/);
    const time = m ? `${m[1]}/${m[2]} ${m[3]}` : '本日';
    return {
      label: `${vesselName} 鹿児島発`,
      time,
      status,
      note: b.headline,
    };
  });

  const status = worstStatus(departures.map((d) => d.status));
  const worst = departures.find((d) => d.status === status) ?? departures[0];

  return {
    id: 'aline_ferry',
    operatorName: 'マルエーフェリー',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note: worst.note,
    officialUrl: 'https://aline-ferry.com/status/',
    departures,
  };
}

// マリックスライン: トップページの運航状況バナー（下り便・上り便）から
// 詳細ページ（/service/downstreamYYYYMMDD/ 等）のリンクを取得し、
// 寄港地ごとの入港・出港時刻とステータスを構造化データとして取得する。
function formatMarixDateTime(dateText, timeText) {
  // "08月22日" -> "8/22"
  const m = dateText.match(/(\d{1,2})月(\d{1,2})日/);
  const date = m ? `${Number(m[1])}/${Number(m[2])}` : dateText;
  return `${date} ${timeText}`;
}

function classifyByClassList(classAttr, fallbackText) {
  const classes = (classAttr || '').split(/\s+/);
  if (classes.includes('cancelled') || classes.includes('cancel')) return 'cancelled';
  if (classes.includes('suspended')) return 'suspended';
  if (classes.includes('conditional')) return 'conditional';
  if (classes.includes('normal')) return 'normal';
  return classify(fallbackText);
}

async function scrapeMarixDetail(url, directionLabel) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const departures = [];
  $('div.service > div.single').each((_, el) => {
    const $el = $(el);
    const portName = collapse($el.find('.port .port_name').text());
    if (!portName) return;
    const statusText = collapse($el.find('.status.sub').text());
    const status = classifyByClassList($el.attr('class'), statusText);

    const entryDate = collapse($el.find('div.entry .date').text());
    const entryTime = collapse($el.find('div.entry .time').text());
    if (entryTime) {
      departures.push({
        label: `${directionLabel} ${portName} 入港`,
        time: formatMarixDateTime(entryDate, entryTime),
        status,
        note: statusText || null,
      });
    }

    const depDate = collapse($el.find('div.departure .date').text());
    const depTime = collapse($el.find('div.departure .time').text());
    if (depTime) {
      departures.push({
        label: `${directionLabel} ${portName} 出港`,
        time: formatMarixDateTime(depDate, depTime),
        status,
        note: statusText || null,
      });
    }
  });

  return departures;
}

async function scrapeMarix() {
  const html = await fetchHtml('https://marixline.com/');
  const $ = cheerio.load(html);

  const hrefs = $('div.service_status_banner a.status_single')
    .toArray()
    .map((el) => $(el).attr('href'))
    .filter(Boolean);

  if (hrefs.length === 0) {
    throw new Error('marix: status banner links not found (page structure may have changed)');
  }

  const perDirection = await Promise.all(
    hrefs.map((href) => {
      const directionLabel = href.includes('downstream')
        ? '下り便'
        : href.includes('upstream')
          ? '上り便'
          : '便';
      return scrapeMarixDetail(href, directionLabel);
    })
  );

  const departures = perDirection.flat();
  if (departures.length === 0) {
    throw new Error('marix: no port schedule parsed (page structure may have changed)');
  }

  const status = worstStatus(departures.map((d) => d.status));
  const troubled = departures.filter((d) => d.status !== 'normal' && d.status !== 'unknown');
  const note =
    troubled.length === 0
      ? '本日・明日の寄港地はすべて通常運航です。'
      : `${troubled.length}件の寄港地で条件付運航等があります。`;

  return {
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note,
    officialUrl: 'https://marixline.com/',
    departures,
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
  const rawFlights = rows
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

  if (rawFlights.length === 0) {
    throw new Error('airport: no departure rows parsed (page structure may have changed)');
  }

  const departures = rawFlights.map((f) => ({
    label: `${f.flightNo}便 ${f.destination}行き`,
    time: f.scheduled,
    actualTime: f.changed || f.scheduled,
    status: classifyFlightStatus(f.statusText, f.scheduled, f.changed),
    note: f.statusText || null,
  }));

  const status = worstStatus(departures.map((d) => d.status));
  const troubled = departures.filter((d) => d.status !== 'normal');
  const note =
    troubled.length === 0
      ? `本日${departures.length}便中、欠航はありません。`
      : `本日${departures.length}便中${troubled.length}便に遅延・欠航等があります。`;

  return {
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発（JAL・Peach・スカイマーク他）',
    mode: 'air',
    status,
    note,
    officialUrl: AIRPORT_URL,
    departures,
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
    departures: [],
  })),
  safe(scrapeMarix, () => ({
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: 'https://marixline.com/',
    departures: [],
  })),
  safe(scrapeAirportDepartures, () => ({
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発（JAL・Peach・スカイマーク他）',
    mode: 'air',
    status: 'unknown',
    note: '取得に失敗しました。公式サイトでご確認ください。',
    officialUrl: AIRPORT_URL,
    departures: [],
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
