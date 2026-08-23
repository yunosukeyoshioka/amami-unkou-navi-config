// フェリー各社・奄美空港の公式ページから、鹿児島〜奄美〜沖縄航路に関係する
// 部分だけを狙って取得し、「通常運行 / 条件付き運行 / 運行見合わせ /
// 欠航 / 不明」に分類する。ページ全体のキーワード検索だと無関係な航路や
// FAQ文言まで拾ってしまうため、cheerioでDOM構造を絞り込んでから判定する。
import { writeFileSync } from 'fs';
import * as cheerio from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

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

// GitHub Actionsのランナーは UTC で動くため、日本時間（UTC+9）に補正した
// Dateを作る（時刻を+9時間ずらして UTC メソッドで読むことで、日本の暦日を
// 取り出せるようにする簡易的な手法）。
function jstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const JST_NOW = jstNow();
const TODAY_ISO = isoDate(JST_NOW);

// 「月」「日」の数字から、直近の暦日（YYYY-MM-DD）を組み立てる。取得元は
// 常に本日・翌日程度の近い将来しか案内しないため、算出した日付が今日より
// 大幅に過去（60日以上前）なら年をまたいだとみなして翌年の日付にする。
function dateFromMD(month, day) {
  const year = JST_NOW.getUTCFullYear();
  const todayOnly = Date.UTC(JST_NOW.getUTCFullYear(), JST_NOW.getUTCMonth(), JST_NOW.getUTCDate());
  let candidate = Date.UTC(year, month - 1, day);
  if (candidate < todayOnly - 60 * 24 * 60 * 60 * 1000) {
    candidate = Date.UTC(year + 1, month - 1, day);
  }
  return isoDate(new Date(candidate));
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

// 今日を含む/含まない先の暦日を [{iso, year, month, day}] の配列で作る
// （時刻表PDFベースの「予定」データをどの日まで作るかに使う）。
function datesAhead(startOffsetDays, count) {
  const base = Date.UTC(JST_NOW.getUTCFullYear(), JST_NOW.getUTCMonth(), JST_NOW.getUTCDate());
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const d = new Date(base + (startOffsetDays + i) * 24 * 60 * 60 * 1000);
    return { iso: isoDate(d), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  });
}

// ============================================================
// 時刻表PDFから「予定（本日ライブ運航状況の対象外の日）」を組み立てる。
// 各社サイトが実際に公開しているのは直近（当日・翌日程度）の運航状況
// のみで、その先の日は時刻表PDF（航空会社の実運航状況とは別の、通常時の
// 運航パターン）を参照するしかない。そのため、ここで作る便は
// status: 'unknown' / isScheduled: true として明確に区別し、
// 「確定した運航状況」とは混同しない。PDFの座標情報（x, y）から
// 表の列・行を機械的に復元する（キーワード検索ではなく構造的な抽出）。
// ============================================================

async function fetchPdfTextItems(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (it.str.trim() === '') continue;
      items.push({ text: it.str, x: it.transform[4], y: it.transform[5] });
    }
  }
  return items;
}

// --- 奄美空港「月間時刻表」PDF（出発時刻・到着時刻・便名・航空会社・備考の
// 5列×2表＝奄美着/奄美発が左右に並ぶレイアウト）を解析する ---
const AIRPORT_DEST_HEADERS = [
  'Kagoshima', 'Kikaijima', 'Tokunoshima', 'Yoron', 'Haneda', 'Narita', 'Itami', 'Kansai', 'Fukuoka', 'Naha',
];
const AIRPORT_DEST_JA_NAME = {
  Kagoshima: '鹿児島', Kikaijima: '喜界島', Tokunoshima: '徳之島', Yoron: '与論',
  Haneda: '東京(羽田)', Narita: '成田', Itami: '大阪(伊丹)', Kansai: '大阪(関西)', Fukuoka: '福岡', Naha: '沖縄(那覇)',
};

function airportFieldOf(x, side) {
  const offset = side === 'arr' ? 0 : 242;
  const ranges = [
    ['time1', 45 + offset, 85 + offset],
    ['time2', 85 + offset, 120 + offset],
    ['flight', 120 + offset, 163 + offset],
    ['airline', 163 + offset, 198 + offset],
    ['remark', 198 + offset, 292 + offset],
  ];
  for (const [name, lo, hi] of ranges) {
    if (x >= lo && x < hi) return name;
  }
  return null;
}

function parseAirportMonthlyPdf(items) {
  const headers = items
    .filter((it) => AIRPORT_DEST_HEADERS.includes(it.text))
    .map((it) => ({ y: it.y, side: it.x < 250 ? 'arr' : 'dep', dest: it.text }))
    .sort((a, b) => b.y - a.y);
  if (headers.length === 0) return { arr: [], dep: [] };

  const topmostHeaderY = headers[0].y;
  const body = items.filter((it) => it.y <= topmostHeaderY);

  const results = { arr: [], dep: [] };
  for (const side of ['arr', 'dep']) {
    const sideHeaders = headers.filter((h) => h.side === side);
    const sideWords = body
      .filter((it) => (side === 'arr' ? it.x < 250 : it.x >= 250))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    for (let i = 0; i < sideHeaders.length; i++) {
      const yStart = sideHeaders[i].y;
      const yEnd = i + 1 < sideHeaders.length ? sideHeaders[i + 1].y : -Infinity;
      const sectionWords = sideWords.filter((w) => w.y < yStart && w.y > yEnd);

      const rows = [];
      let curY = null;
      let cur = [];
      for (const w of sectionWords) {
        if (curY === null || Math.abs(w.y - curY) < 3) {
          cur.push(w);
          curY = curY === null ? w.y : curY;
        } else {
          rows.push(cur);
          cur = [w];
          curY = w.y;
        }
      }
      if (cur.length) rows.push(cur);

      const entries = [];
      let current = null;
      for (const row of rows) {
        const fields = {};
        for (const w of row) {
          const f = airportFieldOf(w.x, side);
          if (!f) continue;
          (fields[f] ??= []).push(w.text);
        }
        const hasTime = fields.time1 && fields.time2;
        const hasFlight = !!fields.flight;
        if (hasTime) {
          if (current && current.dep === null) {
            current.dep = fields.time1[0];
            current.arr = fields.time2[0];
            if (hasFlight) {
              current.flights.push(...fields.flight);
              current.airlines.push(...(fields.airline ?? []));
            }
            if (fields.remark) current.remarks.push(...fields.remark);
          } else {
            if (current && current.dep !== null) entries.push(current);
            current = {
              dest: sideHeaders[i].dest,
              dep: fields.time1[0],
              arr: fields.time2[0],
              flights: [...(fields.flight ?? [])],
              airlines: [...(fields.airline ?? [])],
              remarks: [...(fields.remark ?? [])],
            };
          }
        } else if (hasFlight) {
          if (current && current.dep === null) {
            current.flights.push(...fields.flight);
            current.airlines.push(...(fields.airline ?? []));
            if (fields.remark) current.remarks.push(...fields.remark);
          } else {
            if (current && current.dep !== null) entries.push(current);
            current = {
              dest: sideHeaders[i].dest,
              dep: null,
              arr: null,
              flights: [...fields.flight],
              airlines: [...(fields.airline ?? [])],
              remarks: [...(fields.remark ?? [])],
            };
          }
        } else if (current && fields.remark) {
          current.remarks.push(...fields.remark);
        }
      }
      if (current && current.dep !== null) entries.push(current);
      results[side].push(...entries.filter((e) => e.flights.length > 0));
    }
  }
  return results;
}

// 備考に "8/3〜25" のような有効日範囲があれば、対象日がその範囲内かを判定する
// （範囲外の日にその便を予定として出さないため）。範囲の記載が無い備考は
// 判定に使わない（＝毎日運航の前提で無条件に許可）。
function remarkAllowsDate(remarks, targetYear, targetMonth, targetDay) {
  for (const r of remarks) {
    const m = r.match(/^(\d{1,2})\/(\d{1,2})[〜~](?:(\d{1,2})\/)?(\d{1,2})$/);
    if (!m) continue;
    const startMonth = Number(m[1]);
    const startDay = Number(m[2]);
    const endMonth = m[3] ? Number(m[3]) : startMonth;
    const endDay = Number(m[4]);
    const target = Date.UTC(targetYear, targetMonth - 1, targetDay);
    const start = Date.UTC(targetYear, startMonth - 1, startDay);
    const end = Date.UTC(targetYear, endMonth - 1, endDay);
    if (target < start || target > end) return false;
  }
  return true;
}

async function fetchAirportScheduleEntries(targetDates) {
  const monthlyHtml = await fetchHtml('https://amami-airport.co.jp/flight/monthly');
  const $ = cheerio.load(monthlyHtml);

  const neededYm = new Set(targetDates.map((d) => `${d.year}${String(d.month).padStart(2, '0')}`));
  const pdfUrlByYm = new Map();
  $('a[href$=".pdf"]').each((_, el) => {
    const href = $(el).attr('href');
    const m = href && href.match(/Monthly_(\d{6})_ja\.pdf/);
    if (m && neededYm.has(m[1])) pdfUrlByYm.set(m[1], href);
  });

  const parsedByYm = new Map();
  for (const [ym, url] of pdfUrlByYm) {
    const items = await fetchPdfTextItems(url);
    parsedByYm.set(ym, parseAirportMonthlyPdf(items));
  }

  const entries = [];
  for (const d of targetDates) {
    const ym = `${d.year}${String(d.month).padStart(2, '0')}`;
    const parsed = parsedByYm.get(ym);
    if (!parsed) continue; // その月の時刻表PDFが見つからなければ何も足さない（情報なし表示のまま）

    for (const e of parsed.dep) {
      if (!remarkAllowsDate(e.remarks, d.year, d.month, d.day)) continue;
      const destJa = AIRPORT_DEST_JA_NAME[e.dest];
      const destIsland = FLIGHT_DEST_ISLAND_MAP[destJa];
      entries.push({
        label: `${e.flights[0]}便 ${destJa}行き（予定）`,
        time: e.dep,
        date: d.iso,
        status: 'unknown',
        note: '時刻表に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
        direction: 'departure',
        islands: destIsland ? ['奄美大島', destIsland] : ['奄美大島'],
        isScheduled: true,
        departureLocation: '奄美空港',
        arrivalLocation: airportNameFor(destJa),
      });
    }
    for (const e of parsed.arr) {
      if (!remarkAllowsDate(e.remarks, d.year, d.month, d.day)) continue;
      const destJa = AIRPORT_DEST_JA_NAME[e.dest];
      const originIsland = FLIGHT_DEST_ISLAND_MAP[destJa];
      entries.push({
        label: `${e.flights[0]}便 ${destJa}発（予定）`,
        time: e.arr,
        date: d.iso,
        status: 'unknown',
        note: '時刻表に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
        direction: 'arrival',
        islands: originIsland ? ['奄美大島', originIsland] : ['奄美大島'],
        isScheduled: true,
        departureLocation: airportNameFor(destJa),
        arrivalLocation: '奄美空港',
      });
    }
  }
  return entries;
}

// --- マルエーフェリー「年間スケジュール（鹿児島航路）」PDF（月ごとの
// カレンダーに、あけぼの/波之上それぞれが●＝鹿児島発、○＝那覇発、
// 入＝鹿児島入港の日を配置したもの）を解析する。●の日だけを
// 「鹿児島新港発（予定）」として使う（既存のライブ取得と同じ形）。---
// 公式サイトの「乗船検索」（Web予約と同じ検索機能）に日付・区間を指定して
// POSTし、実際の乗船日時・下船日時（＝寄港地ごとの到着・出発時刻）を取得
// する。この路線はマルエーフェリーとマリックスラインが共同運航しており、
// 相手会社の日は「※下記参照」と表示されるため、その場合はnullを返す
// （その日はA'LINE側の便を作らない＝マリックスライン側の実データに委ねる）。
async function fetchAlineSearchResult(dateObj, startPortId, endPortId) {
  const dateStr = `${dateObj.year}年${String(dateObj.month).padStart(2, '0')}月${String(dateObj.day).padStart(2, '0')}日`;
  const res = await fetch('https://www.aline-ferry.com/search/result.php', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ startDate: dateStr, startPort: String(startPortId), endPort: String(endPortId) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`aline search -> HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());

  const row = $('table.s-result tbody tr').first();
  const tds = row.find('td');
  const vesselName = collapse($(tds[1]).text());
  if (!vesselName || vesselName.includes('下記参照') || vesselName.includes('出港船なし')) return null;

  const parse = (text) => {
    const m = collapse(text).match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:\d{2})/);
    return m ? { date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, time: m[4] } : null;
  };
  const board = parse($(tds[2]).text());
  const alight = parse($(tds[3]).text());
  if (!board || !alight) return null;

  return { vessel: vesselName, board, alight };
}

const ALINE_PORT_ID = { 鹿児島新港: 50, 名瀬港: 70, 亀徳港: 78, 和泊港: 80, 与論港: 82 };
const ALINE_ISLAND_PORTS = ['名瀬港', '亀徳港', '和泊港', '与論港'];

async function fetchAlineScheduleEntries(targetDates, coveredDates) {
  if (targetDates.length === 0) return [];

  const entries = [];
  for (const d of targetDates) {
    if (coveredDates.has(d.iso)) continue; // 既にライブ取得済みの日は重複させない

    for (const isDownstream of [true, false]) {
      // まず代表として名瀬港との組で運航の有無を確認する。この路線は
      // マルエーフェリーとマリックスラインの共同運航で、相手会社の日は
      // 「※下記参照」と返るため、その日はA'LINE側の便を作らない
      // （年間スケジュールPDFのマーカーはサイト更新で意味が変わることが
      // あり信用できないため、日付ごとに実際の検索結果で判定する）。
      const [checkStart, checkEnd] = isDownstream
        ? [ALINE_PORT_ID['鹿児島新港'], ALINE_PORT_ID['名瀬港']]
        : [ALINE_PORT_ID['名瀬港'], ALINE_PORT_ID['鹿児島新港']];
      const checkResult = await safe(() => fetchAlineSearchResult(d, checkStart, checkEnd), () => null);
      if (!checkResult) continue;

      const directionLabel = isDownstream ? '下り便' : '上り便';

      for (const portName of ALINE_ISLAND_PORTS) {
        const result =
          portName === '名瀬港'
            ? checkResult
            : await safe(
                () =>
                  fetchAlineSearchResult(
                    d,
                    isDownstream ? ALINE_PORT_ID['鹿児島新港'] : ALINE_PORT_ID[portName],
                    isDownstream ? ALINE_PORT_ID[portName] : ALINE_PORT_ID['鹿児島新港'],
                  ),
                () => null,
              );
        if (!result) continue;

        const island = PORT_ISLAND_MAP[portName];
        const islands = island ? [island] : [];
        const [boardLoc, alightLoc] = isDownstream ? ['鹿児島新港', portName] : [portName, '鹿児島新港'];

        // 鹿児島新港側のイベント（出港＝下り便の起点／入港＝上り便の終点）は
        // 複数の島へ向かう・複数の島から来る便を1件で表しているため、
        // 到着地・出発地を単一の島に断定しない（不明としてnullにする）。
        entries.push({
          label: `${directionLabel} ${boardLoc} 出港（予定）`,
          time: result.board.time,
          date: result.board.date,
          status: 'unknown',
          note: '公式サイトの乗船検索に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
          direction: 'departure',
          islands: isDownstream ? ROUTE_ISLANDS : islands,
          isScheduled: true,
          departureLocation: boardLoc,
          arrivalLocation: isDownstream ? null : alightLoc,
        });
        entries.push({
          label: `${directionLabel} ${alightLoc} 入港（予定）`,
          time: result.alight.time,
          date: result.alight.date,
          status: 'unknown',
          note: '公式サイトの乗船検索に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
          direction: 'arrival',
          islands: isDownstream ? islands : ROUTE_ISLANDS,
          isScheduled: true,
          departureLocation: isDownstream ? boardLoc : null,
          arrivalLocation: alightLoc,
        });
      }
    }
  }

  // 同じ乗船・下船の組が複数の島問い合わせで重複しうる（鹿児島側の出港情報など）ため、
  // label＋time＋dateの組で重複排除する。
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.label}|${e.time}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- マリックスライン「年間運航スケジュール」PDF（鹿児島⇄沖縄の寄港地別
// 入港・出港"時刻"が１日目/２日目の相対日で固定されており、月ごとの
// 「鹿児島発日」「沖縄・奄美群島発日」カレンダーと組み合わせれば、任意の
// 未来日の寄港スケジュールを実データから機械的に再現できる。マルエー
// フェリーと違い寄港地ごとの時刻まで公開されているため、ライブ取得と
// 同じ粒度（入港/出港ペア）で「予定」を作れる。---
const MARIX_DOWNSTREAM_TEMPLATE = [
  { port: '鹿児島新港', dayOffset: 1, dep: '18:00' },
  { port: '名瀬港', dayOffset: 2, arr: '5:00', dep: '5:50' },
  { port: '亀徳港', dayOffset: 2, arr: '9:10', dep: '9:40' },
  { port: '和泊港', dayOffset: 2, arr: '11:30', dep: '12:00' },
  { port: '与論港', dayOffset: 2, arr: '13:40', dep: '14:10' },
  { port: '本部港', dayOffset: 2, arr: '16:40', dep: '17:10' },
  { port: '那覇港', dayOffset: 2, arr: '19:00' },
];
const MARIX_UPSTREAM_TEMPLATE = [
  { port: '那覇港', dayOffset: 1, dep: '7:00' },
  { port: '本部港', dayOffset: 1, arr: '9:00', dep: '9:20' },
  { port: '与論港', dayOffset: 1, arr: '11:50', dep: '12:10' },
  { port: '和泊港', dayOffset: 1, arr: '14:10', dep: '14:40' },
  { port: '亀徳港', dayOffset: 1, arr: '16:30', dep: '17:00' },
  { port: '名瀬港', dayOffset: 1, arr: '20:30', dep: '21:20' },
  { port: '鹿児島新港', dayOffset: 2, arr: '8:30' },
];

// 「YYYY年M月」の見出しごとに、クイーンコーラルプラス／クロスの出港日
// （日にちの数字だけの並び）を抜き出す。見出し文言のうしろにPDFレンダリング
// 順の都合で無関係なタイトル文言が紛れ込むことがあるため、両船とも実際に
// 日付が取れた月だけを採用し、実在する12か月（年度）分に絞る。
function extractMarixMonthDayLists(pageText) {
  const monthPositions = [...pageText.matchAll(/(\d{4})年(\d{1,2})月/g)];
  const results = [];
  for (let i = 0; i < monthPositions.length; i++) {
    const m = monthPositions[i];
    const start = m.index + m[0].length;
    const end = i + 1 < monthPositions.length ? monthPositions[i + 1].index : pageText.length;
    const block = pageText.slice(start, end);
    const plusIdx = block.indexOf('クイーンコーラルプラス');
    const crossIdx = block.indexOf('クイーンコーラルクロス');
    if (plusIdx === -1 || crossIdx === -1) continue;
    const plusDays = (block.slice(plusIdx + 'クイーンコーラルプラス'.length, crossIdx).match(/\d+/g) ?? []).map(Number);
    const crossDays = (block.slice(crossIdx + 'クイーンコーラルクロス'.length).match(/\d+/g) ?? []).map(Number);
    if (plusDays.length === 0 || crossDays.length === 0) continue;
    results.push({ year: Number(m[1]), month: Number(m[2]), plus: plusDays, cross: crossDays });
  }
  return results.slice(0, 12); // 年度分（12か月）のみ
}

// 「※10/28鹿児島発下り便運航なし」等、カレンダー上は出港日でも実際には
// 運航しない例外日を拾う（カレンダーの数字だけでは表現できないため）。
function extractMarixExceptions(pageText, marker) {
  const re = new RegExp(`※(\\d{1,2})/(\\d{1,2})${marker}運航なし`, 'g');
  return [...pageText.matchAll(re)].map((m) => ({ month: Number(m[1]), day: Number(m[2]) }));
}

function isMarixDepartureDay(calendar, exceptions, vessel, year, month, day) {
  const monthEntry = calendar.find((c) => c.year === year && c.month === month);
  if (!monthEntry) return false;
  if (!monthEntry[vessel].includes(day)) return false;
  return !exceptions.some((e) => e.month === month && e.day === day);
}

async function fetchMarixScheduleEntries(targetDates, coveredDates) {
  if (targetDates.length === 0) return [];
  const guideHtml = await fetchHtml('https://marixline.com/price_schedule/');
  const $ = cheerio.load(guideHtml);
  let scheduleUrl = null;
  $('a[href$=".pdf"]').each((_, el) => {
    const text = collapse($(el).text());
    if (text.includes('年間運航スケジュール')) scheduleUrl = $(el).attr('href');
  });
  if (!scheduleUrl) throw new Error('marix: annual schedule pdf link not found (page structure may have changed)');

  const data = await fetch(scheduleUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!data.ok) throw new Error(`${scheduleUrl} -> HTTP ${data.status}`);
  const buf = new Uint8Array(await data.arrayBuffer());
  const doc = await getDocument({ data: buf, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const pageTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pageTexts.push(content.items.map((it) => it.str).join(''));
  }
  if (pageTexts.length < 2) throw new Error('marix: expected 2 pages in annual schedule pdf (page structure may have changed)');

  const downstreamCalendar = extractMarixMonthDayLists(pageTexts[0]);
  const upstreamCalendar = extractMarixMonthDayLists(pageTexts[1]);
  const downstreamExceptions = extractMarixExceptions(pageTexts[0], '鹿児島発下り便');
  const upstreamExceptions = extractMarixExceptions(pageTexts[1], '那覇発上り便');

  const targetIsoSet = new Set(targetDates.map((d) => d.iso));
  // 出港日（day1）は対象期間の前日まで遡って走査する必要がある
  // （day2＝翌日にまたがる寄港がある場合、出港日自体は対象期間の外にありうるため）。
  const scanStart = targetDates[0];
  const scanBase = Date.UTC(scanStart.year, scanStart.month - 1, scanStart.day - 1);
  const candidateDates = Array.from({ length: targetDates.length + 1 }, (_, i) => {
    const d = new Date(scanBase + i * 24 * 60 * 60 * 1000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  });

  const entries = [];
  for (const vessel of ['plus', 'cross']) {
    for (const direction of ['downstream', 'upstream']) {
      const calendar = direction === 'downstream' ? downstreamCalendar : upstreamCalendar;
      const exceptions = direction === 'downstream' ? downstreamExceptions : upstreamExceptions;
      const template = direction === 'downstream' ? MARIX_DOWNSTREAM_TEMPLATE : MARIX_UPSTREAM_TEMPLATE;
      const directionLabel = direction === 'downstream' ? '下り便' : '上り便';

      for (const cd of candidateDates) {
        if (!isMarixDepartureDay(calendar, exceptions, vessel, cd.year, cd.month, cd.day)) continue;
        const depBase = Date.UTC(cd.year, cd.month - 1, cd.day);

        template.forEach((portTpl, index) => {
          const portDate = new Date(depBase + (portTpl.dayOffset - 1) * 24 * 60 * 60 * 1000);
          const iso = isoDate(portDate);
          if (!targetIsoSet.has(iso) || coveredDates.has(iso)) return;

          const island = PORT_ISLAND_MAP[portTpl.port];
          const islands = island ? [island] : [];
          const prevPort = index > 0 ? template[index - 1].port : null;
          const nextPort = index < template.length - 1 ? template[index + 1].port : null;

          if (portTpl.arr) {
            entries.push({
              label: `${directionLabel} ${portTpl.port} 入港（予定）`,
              time: portTpl.arr,
              date: iso,
              status: 'unknown',
              note: '時刻表に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
              direction: 'arrival',
              islands,
              isScheduled: true,
              departureLocation: prevPort,
              arrivalLocation: portTpl.port,
            });
          }
          if (portTpl.dep) {
            entries.push({
              label: `${directionLabel} ${portTpl.port} 出港（予定）`,
              time: portTpl.dep,
              date: iso,
              status: 'unknown',
              note: '時刻表に基づく予定です。実際の運航状況は前日以降、公式サイトでご確認ください。',
              direction: 'departure',
              islands,
              isScheduled: true,
              departureLocation: portTpl.port,
              arrivalLocation: nextPort,
            });
          }
        });
      }
    }
  }
  return entries;
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
    const date = m ? dateFromMD(Number(m[1]), Number(m[2])) : TODAY_ISO;
    return {
      label: `${vesselName} 鹿児島発`,
      time,
      date,
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

  // 集計（本日時点のステータス表示）はライブ取得した便のみで行う。
  // 時刻表PDFの「予定」を混ぜると、常にunknownな予定便のせいで
  // 本日のステータス判定がぼやけてしまうため。
  const status = worstStatus(departures.map((d) => d.status));
  const worst = departures.find((d) => d.status === status) ?? departures[0];

  // ライブ取得できた日以降〜7日先までを、年間スケジュールPDFの「予定」で補う
  // （取得に失敗しても本体のスクレイピングは止めない）。
  const coveredDates = new Set(departures.map((d) => d.date));
  const maxCoveredOffset = Math.max(
    0,
    ...[...coveredDates].map((iso) => Math.round((new Date(iso) - new Date(TODAY_ISO)) / 86400000)),
  );
  const scheduleTargets = datesAhead(maxCoveredOffset + 1, 6 - maxCoveredOffset);
  const scheduleEntries = await safe(
    () => fetchAlineScheduleEntries(scheduleTargets, coveredDates),
    () => [],
  );

  return {
    id: 'aline_ferry',
    operatorName: 'マルエーフェリー',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note: worst.note,
    officialUrl: 'https://aline-ferry.com/status/',
    departures: sortByTime([...departures, ...scheduleEntries]),
  };
}

// マルエーフェリー系列の貨物専用便「琉球エキスプレス」シリーズ（2/3/5号）は、
// 鹿児島発着の「あけぼの」「波之上」（旅客船）とは別に、大阪・神戸・東京・
// 北九州など鹿児島県外を起点に運航している。3隻は航路間（阪神・東京・北九州）
// で配船が入れ替わることがあるため、航路名では絞り込まず、運航状況ページの
// 寄港地一覧に「名瀬」を含むブロック（＝現在、実際に奄美大島に寄港している便）
// だけを対象にする。同じ物流ブランド名でも旅客を乗せない貨物専用便であるため
// mode: 'cargo' として別項目にする。
async function scrapeAlineCargo() {
  const html = await fetchHtml('https://aline-ferry.com/status/');
  const $ = cheerio.load(html);

  const blocks = $('div.status-archive')
    .toArray()
    .map((el) => {
      const $el = $(el);
      const heading = collapse($el.find('h3').first().text());
      const headline = collapse($el.find('h4').first().text()) || heading;
      const text = collapse($el.text());
      return { heading, headline, text };
    })
    .filter((b) => b.heading.includes('琉球エキスプレス') && b.heading.includes('名瀬'));

  return blocks.map((b) => {
    const vesselMatch = b.heading.match(/琉球エキスプレス[０-９0-9]+/);
    const vesselName = vesselMatch ? vesselMatch[0] : '琉球エキスプレス';
    const routeName = b.heading.replace(vesselName, '').trim();
    const status = classify(b.headline);

    const departures = [];
    const arr = b.text.match(/(\d{1,2})月(\d{1,2})日[^0-9]{0,12}(\d{1,2})[時:](\d{2})分?\s*名瀬港\s*入港/);
    if (arr) {
      departures.push({
        label: `${vesselName} 名瀬港 入港`,
        time: `${arr[1]}/${arr[2]} ${arr[3]}:${arr[4]}`,
        date: dateFromMD(Number(arr[1]), Number(arr[2])),
        status,
        note: b.headline,
        direction: 'arrival',
        islands: ['奄美大島'],
        arrivalLocation: '名瀬港',
      });
    }
    const dep = b.text.match(/(\d{1,2})月(\d{1,2})日[^0-9]{0,12}(\d{1,2})[時:](\d{2})分?\s*名瀬港\s*出港/);
    if (dep) {
      departures.push({
        label: `${vesselName} 名瀬港 出港`,
        time: `${dep[1]}/${dep[2]} ${dep[3]}:${dep[4]}`,
        date: dateFromMD(Number(dep[1]), Number(dep[2])),
        status,
        note: b.headline,
        direction: 'departure',
        islands: ['奄美大島'],
        departureLocation: '名瀬港',
      });
    }
    if (departures.length === 0) {
      // 本文から具体的な日時を拾えない場合も、状況だけは伝える
      // （「通常運航」時は名瀬入出港時刻に触れない見出しのことが多いため）。
      departures.push({
        label: `${vesselName} 名瀬港`,
        time: '本日',
        date: TODAY_ISO,
        status,
        note: b.headline,
        islands: ['奄美大島'],
      });
    }

    return {
      id: `aline_cargo_${vesselName}`,
      operatorName: `マルエーフェリー（貨物専用便）`,
      routeName: `${vesselName}／${routeName}`,
      mode: 'cargo',
      status,
      note: b.headline,
      officialUrl: 'https://aline-ferry.com/status/',
      departures: sortByTime(departures),
    };
  });
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

// "08月22日" のような表示から、暦日（YYYY-MM-DD）を求める。
function isoDateFromJapaneseDate(dateText) {
  const m = dateText.match(/(\d{1,2})月(\d{1,2})日/);
  return m ? dateFromMD(Number(m[1]), Number(m[2])) : TODAY_ISO;
}

function classifyByClassList(classAttr, fallbackText) {
  const classes = (classAttr || '').split(/\s+/);
  if (classes.includes('cancelled') || classes.includes('cancel')) return 'cancelled';
  if (classes.includes('suspended')) return 'suspended';
  if (classes.includes('conditional')) return 'conditional';
  if (classes.includes('normal')) return 'normal';
  return classify(fallbackText);
}

async function scrapeMarixDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // URLの命名規則（downstream/upstream）はページ側の実際の運航に対して
  // 常に正しいとは限らない（臨時便が別URL形式で案内されることがある）ため、
  // ページ自身のタイトルに含まれる「上り便」「下り便」から判定する。
  const pageTitle = collapse($('title').text());
  const directionLabel = pageTitle.includes('上り便') ? '上り便' : pageTitle.includes('下り便') ? '下り便' : '便';

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
        date: isoDateFromJapaneseDate(entryDate),
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
        date: isoDateFromJapaneseDate(depDate),
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

  // トップページのバナーには、通常の下り便・上り便に加えて、同じ寄港を
  // 指す臨時便の別URLが同時に載ることがある（寄港地・時刻が重複するため、
  // 完全に同一の便として下記で重複排除する）。
  const perDirection = await Promise.all([...new Set(hrefs)].map((href) => scrapeMarixDetail(href)));

  const seen = new Set();
  const departures = perDirection.flat().filter((d) => {
    const key = `${d.label}|${d.time}|${d.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (departures.length === 0) {
    throw new Error('marix: no port schedule parsed (page structure may have changed)');
  }

  const status = worstStatus(departures.map((d) => d.status));
  const troubled = departures.filter((d) => d.status !== 'normal' && d.status !== 'unknown');
  const note =
    troubled.length === 0
      ? '本日・明日の寄港地はすべて通常運航です。'
      : `${troubled.length}件の寄港地で条件付運航等があります。`;

  // ライブ取得できた日（本日・翌日）より先〜7日先までを、年間運航スケジュール
  // PDFの「予定」で補う（取得に失敗しても本体のスクレイピングは止めない）。
  const coveredDates = new Set(departures.map((d) => d.date));
  const maxCoveredOffset = Math.max(
    0,
    ...[...coveredDates].map((iso) => Math.round((new Date(iso) - new Date(TODAY_ISO)) / 86400000)),
  );
  const scheduleEntries = await safe(
    () => fetchMarixScheduleEntries(datesAhead(maxCoveredOffset + 1, 6 - maxCoveredOffset), coveredDates),
    () => [],
  );

  return {
    id: 'marix_line',
    operatorName: 'マリックスライン',
    routeName: '鹿児島〜奄美〜沖縄',
    mode: 'ferry',
    status,
    note,
    officialUrl: 'https://marixline.com/',
    departures: sortByTime([...departures, ...scheduleEntries]),
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
      date: TODAY_ISO,
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
      date: TODAY_ISO,
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

  // 本日の発着案内は当日分しか公開されていないため、翌日〜6日先までを
  // 月間時刻表PDFの「予定」で補う（取得に失敗しても本体は止めない）。
  const scheduleEntries = await safe(
    () => fetchAirportScheduleEntries(datesAhead(1, 6)),
    () => [],
  );

  return {
    id: 'amami_airport_departures',
    operatorName: '航空便',
    routeName: '奄美空港発着（JAL・Peach・スカイマーク他）',
    mode: 'air',
    status,
    note,
    officialUrl: AIRPORT_URL,
    departures: sortByTime([...departures, ...scheduleEntries]),
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

const [aline, marix, airport, alineCargo] = await Promise.all([
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
  // 貨物専用便は現在名瀬に寄港している便が無ければ0件が正常であるため、
  // 失敗時のフォールバックも「取得できず」のダミー1件ではなく空配列にする
  // （存在しないことと取得失敗を区別できないが、常設の航路ではないため）。
  safe(scrapeAlineCargo, () => []),
]);

const output = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  operators: [aline, marix, airport, ...alineCargo],
};

writeFileSync('transport_status.json', `${JSON.stringify(output, null, 2)}\n`);
console.log('wrote transport_status.json');
console.log(JSON.stringify(output, null, 2));
