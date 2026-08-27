import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ============================================================
// しまバス（奄美大島）の路線バス時刻表を取得する。
//
// 公式サイトが公開している時刻表PDFのうち、文字情報が埋め込まれている
// もの（画像化されていないもの）のみを機械的に解析して構造化する。
// 画像化されたPDF（自動解析不可）の系統は、時刻を捏造せず、
// 公式PDFへのリンクのみを案内する。
//
// テーブルは「行＝停留所（ルート順）」「列＝1本の便」というグリッド
// なので、実データ（時刻・通過記号）のx座標のクラスタリングから
// 列（＝便）の境界を機械的に復元する。見出し文字（行先・平日／土日祝等）
// の位置は実データ列とずれることがあるため、あくまで補助情報として
// 使い、境界の決定には使わない。
// ============================================================

const UA = 'Mozilla/5.0 (compatible; AmamiUnkouNaviBot/1.0; +https://yunosukeyoshioka.github.io/amami-unkou-navi-config/)';

async function fetchPdfPages(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocument({ data, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = [];
    for (const it of content.items) {
      if (it.str.trim() === '') continue;
      items.push({ text: it.str, x: it.transform[4], y: it.transform[5] });
    }
    pages.push(items);
  }
  return pages;
}

function groupRows(items, tol = 2.5) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= tol) {
      row.items.push(it);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

const TIME_RE = /^(\d{1,2})[:：](\d{2})$/;
const SKIP_TEXT = new Set(['‖', '||', 'I', 'II', '↓', 'ↇ', '-', '−', 'ー', '－']);
const HEADER_NOISE = new Set(['行先', '主要停留所', '主なバス停', '', 'ー', '−', '-', '(乗換)']);

function isTimeText(t) {
  return TIME_RE.test(t.trim());
}

function timeToMinutes(t) {
  const m = TIME_RE.exec(t.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 隣接する値の間隔（ギャップ）が大きい箇所で並びをN個のグループに分割する。
// テーブルが横に複数並ぶ場合、列同士の間隔よりも表と表の間の余白の方が
// 明確に広いことを利用して、機械的に「表（ブロック）」の境界を見つける。
function splitByLargestGaps(sortedXs, nGroups) {
  if (nGroups <= 1 || sortedXs.length <= 1) return [sortedXs];
  const gaps = [];
  for (let i = 1; i < sortedXs.length; i++) gaps.push({ idx: i, size: sortedXs[i] - sortedXs[i - 1] });
  gaps.sort((a, b) => b.size - a.size);
  const cutIdxs = gaps.slice(0, nGroups - 1).map((g) => g.idx).sort((a, b) => a - b);
  const groups = [];
  let start = 0;
  for (const idx of cutIdxs) {
    groups.push(sortedXs.slice(start, idx));
    start = idx;
  }
  groups.push(sortedXs.slice(start));
  return groups;
}

// 「平日」「土日祝」の判定は誤ると利用者に実害があるため（平日ダイヤを
// 日曜日の時刻として案内してしまう等）、確信が持てる場合のみ判定し、
// 曖昧なら 'unknown' として日区分なしで表示する。
function detectDayType(rawLabel) {
  const hasWeekend = rawLabel.includes('土') || rawLabel.includes('祝');
  const hasWeekday = rawLabel.includes('平日');
  if (hasWeekend && !hasWeekday) return 'holiday';
  if (hasWeekday && !hasWeekend) return 'weekday';
  return 'unknown';
}

// ページ内の全「行先」アンカーからブロック（1つの停留所×便テーブル）を機械的に切り出す。
function extractBlocks(items) {
  const rows = groupRows(items);
  const headerAnchorItems = [];
  for (const row of rows) {
    for (const it of row.items) {
      if (it.text === '行先') headerAnchorItems.push({ x: it.x, y: row.y });
    }
  }
  const headerRows = [];
  for (const a of headerAnchorItems) {
    let hr = headerRows.find((h) => Math.abs(h.y - a.y) <= 2.5);
    if (!hr) {
      hr = { y: a.y, anchors: [] };
      headerRows.push(hr);
    }
    hr.anchors.push(a);
  }
  headerRows.sort((a, b) => b.y - a.y);
  for (const hr of headerRows) hr.anchors.sort((a, b) => a.x - b.x);

  const blocks = [];
  for (let hi = 0; hi < headerRows.length; hi++) {
    const hr = headerRows[hi];
    const yTop = hr.y;
    const yBottom = hi + 1 < headerRows.length ? headerRows[hi + 1].y : -Infinity;

    // このY帯にある「時刻または通過記号」らしき項目のxを集めて、行先アンカーの
    // 個数分にグループ分割する（通過記号のグリフは時刻の数字よりも心持ち
    // 位置がずれることがあるため、時刻だけでなく通過記号のxも含めて
    // 各ブロックの実際の占有範囲を漏れなく捉える）。
    const timeXs = [];
    for (const row of rows) {
      if (row.y > yTop + 1.5 || row.y <= yBottom) continue;
      for (const it of row.items) {
        const t = it.text.trim();
        if (isTimeText(t) || SKIP_TEXT.has(t)) timeXs.push(it.x);
      }
    }
    timeXs.sort((a, b) => a - b);
    let groups = splitByLargestGaps(timeXs, hr.anchors.length);
    if (groups.length !== hr.anchors.length) {
      groups = hr.anchors.map(() => []);
    }

    for (let ai = 0; ai < hr.anchors.length; ai++) {
      const g = groups[ai];
      const prevG = ai > 0 ? groups[ai - 1] : null;
      const xLow = prevG && prevG.length ? Math.max(...prevG) + 8 : -Infinity;
      const xHigh = g.length ? Math.max(...g) + 8 : Infinity;
      blocks.push({ yTop, yBottom, xLow, xHigh, ai, rows: [], dayTypeLabel: '' });
    }
  }

  for (const row of rows) {
    for (const block of blocks) {
      if (row.y <= block.yTop + 1.5 && row.y > block.yBottom) {
        const rowItemsInBlock = row.items.filter((it) => it.x >= block.xLow && it.x < block.xHigh);
        if (rowItemsInBlock.length) block.rows.push({ y: row.y, items: rowItemsInBlock });
      }
    }
  }
  // 各ブロックの直上（前のブロック群の下端〜このブロックの開始行の間）にある文字を
  // 「平日」「土日祝」等の見出しとして拾う。
  for (const block of blocks) {
    const aboveRows = rows.filter((r) => r.y > block.yTop && r.y <= block.yTop + 45);
    const texts = [];
    for (const r of aboveRows) {
      for (const it of r.items) {
        if (it.x >= block.xLow && it.x < block.xHigh) texts.push(it.text);
      }
    }
    block.dayTypeLabel = texts.join('');
  }
  for (const block of blocks) block.rows.sort((a, b) => b.y - a.y);

  // 乗り継ぎ後の続き（下段）のブロックには「平日」「土日祝」の見出しが
  // 付いていないことがある。同じ列位置（ai）の直前のブロックから
  // 区分を引き継ぐ（左右の列位置は平日・土日祝で一貫しているため）。
  const lastDayTypeByAi = new Map();
  for (const block of blocks) {
    const detected = detectDayType(block.dayTypeLabel);
    if (detected !== 'unknown') {
      lastDayTypeByAi.set(block.ai, detected);
      block.resolvedDayType = detected;
    } else {
      block.resolvedDayType = lastDayTypeByAi.get(block.ai) ?? 'unknown';
    }
  }
  return blocks;
}

// ブロック内を「見出し行（列＝行先・目的地名）」と「データ行（列＝時刻）」に分け、
// 列アンカーはデータ行の実座標から決定する（見出しはあくまで補助情報）。
function parseBlock(block) {
  if (block.rows.length === 0) return null;
  const labelX = Math.min(...block.rows.map((r) => r.items[0].x));

  const firstDataRowIdx = block.rows.findIndex((r) => r.items.some((it) => isTimeText(it.text)));
  if (firstDataRowIdx === -1) return null;

  const headerRows = block.rows.slice(0, firstDataRowIdx);
  const dataRows = block.rows.slice(firstDataRowIdx);

  // 列アンカー: 全データ行から集めたx座標をクラスタリングして求める。
  // （特定の1行だけでは、その便がその停留所を通過しない＝セルが空、
  // というケースを取りこぼすため、全データ行から集める）
  const colCandidates = [];
  for (const r of dataRows) {
    for (const it of r.items) {
      if (Math.abs(it.x - labelX) < 8) continue;
      colCandidates.push(it.x);
    }
  }
  colCandidates.sort((a, b) => a - b);
  const colAnchors = [];
  for (const x of colCandidates) {
    if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 15) colAnchors.push(x);
  }

  function nearestCol(x) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < colAnchors.length; i++) {
      const d = Math.abs(colAnchors[i] - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return bestDist <= 25 ? best : -1;
  }

  const colHeaderText = colAnchors.map(() => []);
  for (const r of headerRows) {
    for (const it of r.items) {
      if (Math.abs(it.x - labelX) < 8) continue;
      if (HEADER_NOISE.has(it.text.trim())) continue;
      const ci = nearestCol(it.x);
      if (ci >= 0) colHeaderText[ci].push(it.text);
    }
  }

  const stopRows = [];
  for (const r of dataRows) {
    const labelItem = r.items.find((it) => Math.abs(it.x - labelX) < 8);
    const stopName = labelItem ? labelItem.text : null;
    if (!stopName) continue;
    if (stopName.includes('乗換') || stopName.includes('行先') || stopName.includes('主な') || stopName.includes('主要')) continue;
    const cells = colAnchors.map(() => null);
    for (const it of r.items) {
      if (Math.abs(it.x - labelX) < 8) continue;
      const ci = nearestCol(it.x);
      if (ci >= 0) cells[ci] = (cells[ci] ?? '') + it.text;
    }
    stopRows.push({ stopName, cells });
  }

  return {
    dayType: block.resolvedDayType,
    columnHeaders: colHeaderText.map((arr) => arr.join(' ')),
    stops: stopRows,
  };
}

// 列位置のジッター（座標のわずかなズレ）により、稀に隣の便の時刻が
// 誤って紐付くことがある。1便が停留所を巡る時刻は物理的に単調非減少のはずなので、
// 直前に採用した時刻より早い（＝あり得ない）時刻が来たら、その1件だけを
// 「誤って紐付いた値」とみなして落とす（捏造防止のための安全弁）。
function dropNonMonotonicStops(stops) {
  const kept = [];
  let lastMinutes = -Infinity;
  for (const s of stops) {
    const mins = timeToMinutes(s.time);
    if (mins === null) continue;
    if (mins < lastMinutes) continue;
    kept.push(s);
    lastMinutes = mins;
  }
  return kept;
}

function tripsFromParsedBlock(parsed) {
  if (!parsed) return [];
  const trips = [];
  for (let ci = 0; ci < parsed.columnHeaders.length; ci++) {
    const rawStops = [];
    for (const row of parsed.stops) {
      const v = (row.cells[ci] ?? '').trim();
      if (isTimeText(v)) rawStops.push({ name: row.stopName, time: v.replace('：', ':') });
    }
    const stops = dropNonMonotonicStops(rawStops);
    if (stops.length > 0) {
      trips.push({ destination: parsed.columnHeaders[ci] || null, dayType: parsed.dayType, stops });
    }
  }
  return trips;
}

async function parsePdfToTrips(url) {
  const pages = await fetchPdfPages(url);
  const trips = [];
  for (const items of pages) {
    const blocks = extractBlocks(items);
    for (const block of blocks) {
      const parsed = parseBlock(block);
      trips.push(...tripsFromParsedBlock(parsed));
    }
  }
  // 表示順: 平日→土日祝→不明、その中では始発時刻順。
  const dayOrder = { weekday: 0, holiday: 1, unknown: 2 };
  trips.sort((a, b) => {
    const d = (dayOrder[a.dayType] ?? 9) - (dayOrder[b.dayType] ?? 9);
    if (d !== 0) return d;
    const at = a.stops[0] ? timeToMinutes(a.stops[0].time) ?? 0 : 0;
    const bt = b.stops[0] ? timeToMinutes(b.stops[0].time) ?? 0 : 0;
    return at - bt;
  });
  return trips;
}

function groupTripsByDayType(trips) {
  const labels = { weekday: '平日', holiday: '土日祝', unknown: '' };
  const order = ['weekday', 'holiday', 'unknown'];
  const groups = [];
  for (const id of order) {
    const groupTrips = trips.filter((t) => t.dayType === id);
    if (groupTrips.length === 0) continue;
    groups.push({
      id,
      label: labels[id],
      trips: groupTrips.map(({ destination, stops }) => ({ destination, stops })),
    });
  }
  return groups;
}

// 文字情報が取得できる（＝機械的に構造化できる）系統。
const PARSEABLE_ROUTES = [
  {
    id: 'tatsugo_loop',
    name: '龍郷町周遊線（東まわり・龍郷役場まわり）',
    area: '龍郷町',
    pdfUrl: 'https://shimabus.co.jp/wp-content/uploads/2025/04/20250401tatsugo.pdf',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
  },
  {
    id: 'toguchi_line',
    name: '戸口線（戸口⇔名瀬）',
    area: '龍郷町',
    pdfUrl: 'https://shimabus.co.jp/wp-content/uploads/2023/09/20231001_toguchisen.pdf',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
  },
];

// 最新の時刻表PDFが画像（スキャン）化されており文字情報を取得できない、
// または表の構造が複雑で確実な自動解析ができない系統。捏造を避けるため
// 時刻データは持たず、公式PDFへのリンクのみを案内する。
const LINK_ONLY_ROUTES = [
  {
    id: 'airport_line',
    name: '空港線（こしゅく第１公園⇔奄美空港）',
    area: '奄美市・笠利町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },
  {
    id: 'koniya_sumiyo_line',
    name: 'せとうち海の駅（古仁屋）・住用線',
    area: '瀬戸内町・住用町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },
  {
    id: 'sani_line',
    name: '佐仁線（笠利町佐仁⇔市街地）',
    area: '笠利町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表の構造が複雑で確実な自動表示ができないため、公式PDFをご案内しています。',
  },
  {
    id: 'toguchi_uken_line',
    name: '新村・石良・湯湾・宇検線',
    area: '宇検村',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },
];

export async function scrapeBusTimetable() {
  const routes = [];
  for (const r of PARSEABLE_ROUTES) {
    try {
      const trips = await parsePdfToTrips(r.pdfUrl);
      const dayTypes = groupTripsByDayType(trips);
      if (dayTypes.length === 0) throw new Error('no trips parsed');
      routes.push({
        id: r.id,
        name: r.name,
        area: r.area,
        officialUrl: r.officialUrl,
        pdfUrl: r.pdfUrl,
        parsed: true,
        dayTypes,
      });
    } catch (err) {
      console.error(`bus timetable parse failed for ${r.id}: ${err}`);
      // 解析に失敗した場合は捏造せず、リンク案内にフォールバックする。
      routes.push({
        id: r.id,
        name: r.name,
        area: r.area,
        officialUrl: r.officialUrl,
        parsed: false,
        note: '時刻表の自動取得に失敗しました。下のボタンから公式PDFをご確認ください。',
      });
    }
  }
  for (const r of LINK_ONLY_ROUTES) {
    routes.push({
      id: r.id,
      name: r.name,
      area: r.area,
      officialUrl: r.officialUrl,
      parsed: false,
      note: r.note,
    });
  }

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    routes,
  };
}
