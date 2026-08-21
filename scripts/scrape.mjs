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

// "8/22 05:50" のような表示用文字列から、時系列に並べ替えるためのキーを作る。
// 日付が無い（例: "08:45" だけ、または "本日"）場合は本日扱いにする。
// 時刻自体が無い（"本日"のみ等）場合は一番最後に回す。
function timeSortKey(timeText) {
  const m = timeText.match(/(?:(\d{1,2})\/(\d{1,2})\s+)?(\d{1,2}):(\d{2})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const [, month, day, hh, mm] = m;
  const dayRank = month && day ? Number(month) * 100 + Number(day) : 0;
  return dayRank * 10000 + Number(hh) * 100 + Number(mm);
}

function sortByTime(departures) {
  return [...departures].sort((a, b) => timeSortKey(a.time) - timeSortKey(b.time));
}

// 奄美群島の主要有人島。アプリ側の地区（島）絞り込みに使う。
// マルエーフェリー・マリックスラインの鹿児島〜奄美〜沖縄航路が寄港する島。
const ROUTE_ISLANDS = ['奄美大島', '徳之島', '沖永良部島', '与論島'];

// マリックスラインは寄港地ごとに構造化データが取れるため、港名から
// 島を一意に特定できる（鹿児島新港・本部港・那覇港は奄美群島の島ではない）。
const PORT_ISLAND_MAP = {
  名瀬港: '奄美大島',
  古仁屋港: '奄美大島',
  亀徳港: '徳之島',
  平土野港: '徳之島',
  和泊港: '沖永良部島',
  与論港: '与論島',
};

// 奄美空港の出発便table「目的地」・到着便table「出発地」に現れる地名のうち、
// 奄美群島内の島であるもの（出発・到着どちらの向きでも同じ地名→島の対応）。
const FLIGHT_DEST_ISLAND_MAP = {
  喜界島: '喜界島',
  徳之島: '徳之島',
  与論: '与論島',
};

// 奄美空港の発着案内table「目的地」「出発地」欄に現れる地名を、実際の
// 空港名に変換する（一般的な略称・通称を使用）。未収録の地名は
// 「◯◯空港」を機械的に付与する（推測ではなく命名規則の適用）。
const PLACE_AIRPORT_NAME_MAP = {
  '大阪(伊丹)': '伊丹空港',
  '大阪(関西)': '関西空港',
  '東京(羽田)': '羽田空港',
  '沖縄(那覇)': '那覇空港',
  喜界島: '喜界空港',
  与論: '与論空港',
};

function airportNameFor(place) {
  return PLACE_AIRPORT_NAME_MAP[place] ?? `${place}空港`;
}

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
      direction: 'departure',
      // 寄港地別の構造化データが無いため、この航路が寄港する4島すべてに
      // タグ付けする（実際にどの島で問題が起きているかまでは区別できない）。
      islands: ROUTE_ISLANDS,
      departureLocation: '鹿児島新港',
      // 到着地（島側の港）は1件の告知が4島分を指すため、この時点では
      // 特定できない（アプリ側で選択島の文脈に応じて補う）。
      arrivalLocation: null,
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
    departures: sortByTime(departures),
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

  const singles = $('div.service > div.single').toArray();
  // ページ掲載順＝この航海の寄港順（鹿児島新港 → 各島の港 → 本部港/那覇港、
  // または上り便はその逆）なので、前後の要素から隣接港名を実データとして
  // 求められる（推測ではなく、同じページの実際の並び順から取得）。
  const portNames = singles.map((el) => collapse($(el).find('.port .port_name').text()));

  const departures = [];
  singles.forEach((el, index) => {
    const $el = $(el);
    const portName = portNames[index];
    if (!portName) return;
    const statusText = collapse($el.find('.status.sub').text());
    const status = classifyByClassList($el.attr('class'), statusText);

    const island = PORT_ISLAND_MAP[portName];
    const islands = island ? [island] : [];
    const prevPort = index > 0 ? portNames[index - 1] : null;
    const nextPort = index < portNames.length - 1 ? portNames[index + 1] : null;

    const entryDate = collapse($el.find('div.entry .date').text());
    const entryTime = collapse($el.find('div.entry .time').text());
    if (entryTime) {
      departures.push({
        label: `${directionLabel} ${portName} 入港`,
        time: formatMarixDateTime(entryDate, entryTime),
        status,
        note: statusText || null,
        direction: 'arrival',
        islands,
        departureLocation: prevPort,
        arrivalLocation: portName,
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
        direction: 'departure',
        islands,
        departureLocation: portName,
        arrivalLocation: nextPort,
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
    departures: sortByTime(departures),
  };
}

// 航空便: 徳之島・沖永良部・与論・喜界の各空港は鹿児島県が管理する第三種空港で、
// 奄美空港のような独自のリアルタイム発着案内サイトを持たない（鹿児島県の
// ページは施設概要のみの静的ページ）。JALの発着案内はAkamaiのbot対策で
// GitHub Actionsからもブロックされる（ヘッドレスブラウザでも回避できず、
// IPレピュテーションによるブロックとみられる）。
// そのため、奄美空港自体の公式サイト（航空会社ではなく空港ターミナルビル
// 運営者が掲載）の「出発便」表（奄美発＝各島行き）と「到着便」表
// （各島発＝奄美着）の両方を使い、奄美空港を経由する範囲で各島の発着情報を
// 組み立てる。沖永良部島は本日奄美空港との直行便が無いため、他社サイトが
// 存在しない以上、この方式では情報を取得できない（一覧からは自然に外れる）。
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

function findAirportTable($, headerKeyword) {
  let table = null;
  $('table').each((_, el) => {
    if (table) return;
    const headerText = collapse($(el).find('th').text());
    if (headerText.includes(headerKeyword)) table = el;
  });
  return table;
}

function parseAirportRows($, table) {
  return $(table)
    .find('tr')
    .toArray()
    .slice(1) // 先頭はヘッダ行
    .map((row) => {
      const tds = $(row).find('td');
      return {
        scheduled: collapse($(tds[0]).text()),
        changed: collapse($(tds[1]).text()),
        place: collapse($(tds[2]).text()), // 出発便=目的地 / 到着便=出発地
        flightNo: collapse($(tds[4]).text()),
        statusText: collapse($(tds[5]).text()),
      };
    })
    .filter((f) => f.flightNo && f.scheduled);
}

async function scrapeAirportDepartures() {
  const html = await fetchHtml(AIRPORT_URL);
  const $ = cheerio.load(html);

  // ページはレスポンシブ対応で同じ表が複製されていることがあるため、
  // 「目的地」ヘッダ＝出発便、「出発地」ヘッダ＝到着便として最初に
  // 見つかったものだけを使う。
  const depTable = findAirportTable($, '目的地');
  const arrTable = findAirportTable($, '出発地');
  if (!depTable && !arrTable) {
    throw new Error('airport: neither departures nor arrivals table found (page structure may have changed)');
  }

  const rawDepartures = depTable ? parseAirportRows($, depTable) : [];
  const rawArrivals = arrTable ? parseAirportRows($, arrTable) : [];
  if (rawDepartures.length === 0 && rawArrivals.length === 0) {
    throw new Error('airport: no flight rows parsed (page structure may have changed)');
  }

  const departureEntries = rawDepartures.map((f) => {
    // 奄美空港発なので必ず「奄美大島」を含め、目的地が群島内の島なら追加する。
    const destIsland = FLIGHT_DEST_ISLAND_MAP[f.place];
    const islands = destIsland ? ['奄美大島', destIsland] : ['奄美大島'];
    return {
      label: `${f.flightNo}便 ${f.place}行き`,
      time: f.scheduled,
      actualTime: f.changed || f.scheduled,
      status: classifyFlightStatus(f.statusText, f.scheduled, f.changed),
      note: f.statusText || null,
      direction: 'departure',
      islands,
      departureLocation: '奄美空港',
      arrivalLocation: airportNameFor(f.place),
    };
  });

  const arrivalEntries = rawArrivals.map((f) => {
    // 奄美空港着なので必ず「奄美大島」を含め、出発地が群島内の島なら追加する
    // （＝その島発の便として、島側の絞り込みでも表示されるようにする）。
    const originIsland = FLIGHT_DEST_ISLAND_MAP[f.place];
    const islands = originIsland ? ['奄美大島', originIsland] : ['奄美大島'];
    return {
      label: `${f.flightNo}便 ${f.place}発`,
      time: f.scheduled,
      actualTime: f.changed || f.scheduled,
      status: classifyFlightStatus(f.statusText, f.scheduled, f.changed),
      note: f.statusText || null,
      direction: 'arrival',
      islands,
      departureLocation: airportNameFor(f.place),
      arrivalLocation: '奄美空港',
    };
  });

  const departures = sortByTime([...departureEntries, ...arrivalEntries]);
  const status = worstStatus(departures.map((d) => d.status));
  const troubled = departures.filter((d) => d.status !== 'normal');
  const note =
    troubled.length === 0
      ? `本日${departures.length}便中、欠航はありません。`
      : `本日${departures.length}便中${troubled.length}便に遅延・欠航等があります。`;

  return {
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発着（JAL・Peach・スカイマーク他）',
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
