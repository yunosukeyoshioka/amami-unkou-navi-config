import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as cheerio from 'cheerio';

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

// tol: 同じ行とみなすy座標の許容差。事業者によっては停留所名と時刻が
// 完全に同じyではなく数pt程度ずれて描画されることがあるため、行の間隔
// （通常10pt以上）よりは十分小さい範囲でやや広めに取る。
function groupRows(items, tol = 4) {
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

// ページ内の全「行先」（または事業者ごとの見出し文字）アンカーから
// ブロック（1つの停留所×便テーブル）を機械的に切り出す。
function extractBlocks(items, anchorText = '行先') {
  const rows = groupRows(items);
  const headerAnchorItems = [];
  for (const row of rows) {
    for (const it of row.items) {
      if (it.text === anchorText) headerAnchorItems.push({ x: it.x, y: row.y });
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

  const firstDataRowIdx = block.rows.findIndex((r) => r.items.some((it) => isTimeText(it.text)));
  if (firstDataRowIdx === -1) return null;

  const headerRows = block.rows.slice(0, firstDataRowIdx);
  const dataRows = block.rows.slice(firstDataRowIdx);

  // 列アンカー: 全データ行の「時刻そのもの」のx座標だけからクラスタリングして求める
  // （停留所名が複数文字に分割されて描画されている事業者もあり、それらの断片が
  // 誤って独立した列だと判定されるのを防ぐため、通過記号ではなく時刻限定で求める）。
  const timeCandidates = [];
  for (const r of dataRows) {
    for (const it of r.items) {
      if (isTimeText(it.text)) timeCandidates.push(it.x);
    }
  }
  timeCandidates.sort((a, b) => a - b);
  const colAnchors = [];
  for (const x of timeCandidates) {
    if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 15) colAnchors.push(x);
  }
  if (colAnchors.length === 0) return null;

  // ラベル列（停留所名・行先名等）の右端 = 最初の実データ列よりやや手前。
  // 停留所名が複数文字に分割されていても、実データ列より手前にあれば
  // すべてラベルとして扱う（固定半径ではなく、実際の列位置から動的に決める）。
  const labelZoneMaxX = colAnchors[0] - 10;

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
      if (it.x < labelZoneMaxX) continue;
      if (HEADER_NOISE.has(it.text.trim())) continue;
      const ci = nearestCol(it.x);
      if (ci >= 0) colHeaderText[ci].push(it.text);
    }
  }

  const stopRows = [];
  for (const r of dataRows) {
    const labelItems = r.items.filter((it) => it.x < labelZoneMaxX).sort((a, b) => a.x - b.x);
    const stopName = labelItems.length ? labelItems.map((it) => it.text).join('') : null;
    if (!stopName) continue;
    if (stopName.includes('乗換') || stopName.includes('行先') || stopName.includes('主な') || stopName.includes('主要')) continue;
    const cells = colAnchors.map(() => null);
    for (const it of r.items) {
      if (it.x < labelZoneMaxX) continue;
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
      // 行先の見出しが取れない列は、その便の最終停留所を行先の代わりに使う
      // （捏造ではなく、実データから素直に導ける最も妥当な表示名のため）。
      const destination = parsed.columnHeaders[ci] || stops[stops.length - 1]?.name || null;
      trips.push({ destination, groupId: parsed.dayType, stops });
    }
  }
  return trips;
}

async function parsePdfToTrips(url, { anchorText = '行先', pages: onlyPages = null } = {}) {
  const allPages = await fetchPdfPages(url);
  const pages = onlyPages ? onlyPages.map((p) => allPages[p - 1]).filter(Boolean) : allPages;
  const trips = [];
  for (const items of pages) {
    const blocks = extractBlocks(items, anchorText);
    for (const block of blocks) {
      const parsed = parseBlock(block);
      trips.push(...tripsFromParsedBlock(parsed));
    }
  }
  return sortTrips(trips);
}

// 表示順: weekday→holiday→north→south→unknown、その中では始発時刻順
// （未知のgroupIdは末尾に回す）。
const GROUP_ORDER = { weekday: 0, holiday: 1, north: 2, south: 3, unknown: 9 };

function sortTrips(trips) {
  return [...trips].sort((a, b) => {
    const d = (GROUP_ORDER[a.groupId] ?? 5) - (GROUP_ORDER[b.groupId] ?? 5);
    if (d !== 0) return d;
    const at = a.stops[0] ? timeToMinutes(a.stops[0].time) ?? 0 : 0;
    const bt = b.stops[0] ? timeToMinutes(b.stops[0].time) ?? 0 : 0;
    return at - bt;
  });
}

const CIRCLED_NUM_RE = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]$/;

// 「行＝1便、列＝停留所」という、しまバスとは縦横が逆のグリッド形式
// （南陸運＝与論島バスなど、循環路線に多い形式）を解析する。
// ページ内の丸数字（出発順）を行の目印として使い、その左側にある
// 方向ラベル（例：北回り／南回り）の位置で表全体を方向ごとに分割する。
function parseTransposedPdf(items, directionLabels) {
  const rows = groupRows(items);

  // 丸数字が現れる行を「データ行」の目印とする。
  const numRows = rows.filter((r) => r.items.some((it) => CIRCLED_NUM_RE.test(it.text.trim())));
  if (numRows.length === 0) return [];
  const labelX = Math.min(
    ...numRows.map((r) => r.items.find((it) => CIRCLED_NUM_RE.test(it.text.trim())).x),
  );

  // 表全体を、方向ラベル（例：北回り／南回り）の文字が現れるy位置を境に分割する。
  // ラベル自体は表の高さいっぱいに1文字ずつ縦書きで並ぶため、
  // 最初の文字（最大y）だけを各表の開始位置として使う。
  const dirStarts = [];
  for (const [label, id] of Object.entries(directionLabels)) {
    const occurrences = rows
      .flatMap((r) => r.items.filter((it) => it.text === label && it.x < labelX - 10))
      .map((it) => it.y);
    if (occurrences.length > 0) dirStarts.push({ id, y: Math.max(...occurrences) });
  }
  dirStarts.sort((a, b) => b.y - a.y);
  if (dirStarts.length === 0) return [];

  const allTrips = [];
  for (let i = 0; i < dirStarts.length; i++) {
    const yTop = dirStarts[i].y + 40; // ラベルの上にある見出し行も含める
    const yBottom = i + 1 < dirStarts.length ? dirStarts[i + 1].y + 40 : -Infinity;
    const blockRows = rows.filter((r) => r.y <= yTop && r.y > yBottom).sort((a, b) => b.y - a.y);

    const firstDataIdx = blockRows.findIndex((r) => r.items.some((it) => CIRCLED_NUM_RE.test(it.text.trim())));
    if (firstDataIdx === -1) continue;
    const headerRows = blockRows.slice(0, firstDataIdx);
    const dataRows = blockRows.slice(firstDataIdx);

    // 列アンカー（＝各停留所の位置）はデータ行の時刻から求める。
    const colCandidates = [];
    for (const r of dataRows) {
      for (const it of r.items) {
        if (isTimeText(it.text)) colCandidates.push(it.x);
      }
    }
    colCandidates.sort((a, b) => a - b);
    const colAnchors = [];
    for (const x of colCandidates) {
      if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 12) colAnchors.push(x);
    }
    function nearestCol(x) {
      let best = -1;
      let bestDist = Infinity;
      for (let ci = 0; ci < colAnchors.length; ci++) {
        const d = Math.abs(colAnchors[ci] - x);
        if (d < bestDist) {
          bestDist = d;
          best = ci;
        }
      }
      return bestDist <= 20 ? best : -1;
    }

    // 見出し行から停留所名を列ごとに集める（複数行に分かれた縦書きを連結）。
    const colHeaderChars = colAnchors.map(() => []);
    for (const r of headerRows) {
      for (const it of r.items) {
        if (it.x < labelX) continue;
        const ci = nearestCol(it.x);
        if (ci >= 0) colHeaderChars[ci].push(it);
      }
    }
    const colHeaderText = colHeaderChars.map((chars) =>
      chars
        .sort((a, b) => b.y - a.y || a.x - b.x)
        .map((c) => c.text)
        .join(''),
    );

    // データ行＝1便。列＝停留所。列（＝停留所の通過順）でソートしてから単調性チェックする。
    for (const r of dataRows) {
      const rawStops = [];
      for (const it of r.items) {
        if (!isTimeText(it.text)) continue;
        const ci = nearestCol(it.x);
        if (ci < 0) continue;
        rawStops.push({ ci, name: colHeaderText[ci] || null, time: it.text.trim().replace('：', ':') });
      }
      rawStops.sort((a, b) => a.ci - b.ci);
      const stops = dropNonMonotonicStops(rawStops)
        .filter((s) => s.name)
        .map(({ name, time }) => ({ name, time }));
      if (stops.length > 0) {
        allTrips.push({ groupId: dirStarts[i].id, destination: stops[stops.length - 1]?.name ?? null, stops });
      }
    }
  }
  return allTrips;
}

const HTML_UA = 'Mozilla/5.0 (compatible; AmamiUnkouNaviBot/1.0; +https://yunosukeyoshioka.github.io/amami-unkou-navi-config/)';

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': HTML_UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

function normalizeCellText(text) {
  return text.replace(/ /g, '').replace(/\s+/g, '').trim();
}

// 「行＝1便、列＝停留所」のHTML表（徳之島総合陸運など）を解析する。
// 1つの<table>に、往路・復路の2つの表が空欄セルを区切りとして
// 横並びに入っていることがあるため、見出し行の空欄位置で表を分割する。
// 行のCSSクラスで「平日のみ運行（土日祝運休）」「特定期間運休」を判定できる
// 事業者では、それを日区分として素直に使う（捏造せず、原本の印に従う）。
function parseHtmlTimetableTable($, table, { weekdayOnlyClass, skipClasses = [] } = {}) {
  const rows = $(table).find('tr').toArray();
  if (rows.length < 2) return [];

  // 見出し行（停留所名の行）を探す。先頭行が結合セル（colspan）のタイトル行の
  // ことがあるため、「colspanを持つセルが無い最初の行」を見出し行とみなす
  // （タイトル行はcolspanで1〜数個のセルにまとまるが、見出し行は停留所数だけ
  // 独立したセルが並ぶ）。
  let headerIdx = rows.findIndex((r) => {
    const cells = $(r).find('th,td').toArray();
    return cells.length >= 2 && cells.every((c) => Number($(c).attr('colspan') || 1) === 1);
  });
  if (headerIdx === -1) return [];
  const headerCells = $(rows[headerIdx])
    .find('th,td')
    .toArray()
    .map((c) => normalizeCellText($(c).text()));

  // 空欄セルの位置で列を「区間（往路／復路等）」に分割する。
  const segments = [];
  let seg = [];
  for (let i = 0; i < headerCells.length; i++) {
    if (headerCells[i] === '') {
      if (seg.length) segments.push(seg);
      seg = [];
    } else {
      seg.push(i);
    }
  }
  if (seg.length) segments.push(seg);
  if (segments.length === 0) return [];

  const trips = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const cls = ($(row).attr('class') || '').trim();
    if (skipClasses.includes(cls)) continue; // 特定期間運休など、常設ダイヤとして出すには不確実な便
    const groupIdsForRow = cls === weekdayOnlyClass ? ['weekday'] : ['weekday', 'holiday'];

    const cells = $(row)
      .find('th,td')
      .toArray()
      .map((c) => normalizeCellText($(c).text()));
    if (cells.every((c) => c === '')) continue;

    for (const colIdxs of segments) {
      const rawStops = colIdxs
        .filter((ci) => ci < cells.length && isTimeText(cells[ci]))
        .map((ci) => ({ name: headerCells[ci], time: cells[ci].replace('：', ':') }));
      const stops = dropNonMonotonicStops(rawStops);
      if (stops.length === 0) continue;
      const destination = stops[stops.length - 1]?.name ?? null;
      for (const groupId of groupIdsForRow) {
        trips.push({ groupId, destination, stops });
      }
    }
  }
  return trips;
}

async function parseHtmlTimetable(url, tableIndexes, opts) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const tables = $('table').toArray();
  const trips = [];
  for (const idx of tableIndexes) {
    if (!tables[idx]) continue;
    trips.push(...parseHtmlTimetableTable($, tables[idx], opts));
  }
  return sortTrips(trips);
}

const DEFAULT_GROUP_LABELS = { weekday: '平日', holiday: '土日祝', north: '北回り', south: '南回り', unknown: '' };

// 解析済みの便一覧を、groupId（平日／土日祝／方向 等）ごとにまとめる。
// ラベルの無い区分（unknown）しか無ければ、実質1グループのみになる
// （＝アプリ側は区分タブを出さず、単純な便一覧として表示する）。
function groupTripsByGroupId(trips, labels = DEFAULT_GROUP_LABELS) {
  const ids = [...new Set(trips.map((t) => t.groupId ?? 'unknown'))].sort(
    (a, b) => (GROUP_ORDER[a] ?? 5) - (GROUP_ORDER[b] ?? 5),
  );
  const groups = [];
  for (const id of ids) {
    const groupTrips = trips.filter((t) => (t.groupId ?? 'unknown') === id);
    if (groupTrips.length === 0) continue;
    groups.push({
      id,
      label: labels[id] ?? '',
      trips: groupTrips.map(({ destination, stops }) => ({ destination, stops })),
    });
  }
  return groups;
}

// 島ごとの路線バス事業者・路線一覧。
// fetchTrips が無いものは「文字情報を確実に取得できない、または表構造が
// 複雑で確実な自動解析ができない」系統で、時刻を捏造せず公式PDF等への
// リンクのみを案内する。
const ROUTES = [
  // --- 奄美大島：しまバス ---
  {
    id: 'tatsugo_loop',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '龍郷町周遊線（東まわり・龍郷役場まわり）',
    area: '龍郷町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    pdfUrl: 'https://shimabus.co.jp/wp-content/uploads/2025/04/20250401tatsugo.pdf',
    fetchTrips: (url) => parsePdfToTrips(url),
  },
  {
    id: 'toguchi_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '戸口線（戸口⇔名瀬）',
    area: '龍郷町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    pdfUrl: 'https://shimabus.co.jp/wp-content/uploads/2023/09/20231001_toguchisen.pdf',
    fetchTrips: (url) => parsePdfToTrips(url),
  },
  {
    id: 'airport_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '空港線（こしゅく第１公園⇔奄美空港）',
    area: '奄美市・笠利町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },
  {
    id: 'koniya_sumiyo_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: 'せとうち海の駅（古仁屋）・住用線',
    area: '瀬戸内町・住用町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },
  {
    id: 'sani_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '佐仁線（笠利町佐仁⇔市街地）',
    area: '笠利町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表の構造が複雑で確実な自動表示ができないため、公式PDFをご案内しています。',
  },
  {
    id: 'toguchi_uken_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '新村・石良・湯湾・宇検線',
    area: '宇検村',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    note: '時刻表PDFが画像形式のため、便ごとの時刻を自動表示できません。下のボタンから公式PDFをご確認ください。',
  },

  // --- 喜界島：喜界町地域公共交通活性化協議会（公共ライドシェアバス） ---
  {
    id: 'kikai_bus',
    island: '喜界島',
    operatorName: '喜界町公共ライドシェアバス',
    operatorUrl: 'https://www.town.kikai.lg.jp/kankou/kanko-iju/kotsuannai/chonai.html',
    name: '南中央線・北中央線',
    area: '喜界町',
    officialUrl: 'https://www.town.kikai.lg.jp/kankou/kanko-iju/kotsuannai/chonai.html',
    note: '時刻表PDF内に、運休便を示す線が図として引かれており、文字情報だけでは運休の有無を確実に判定できないため、公式PDFをご案内しています。',
  },

  // --- 徳之島：徳之島総合陸運 ---
  {
    id: 'tokunoshima_kuko_line',
    island: '徳之島',
    operatorName: '徳之島総合陸運',
    operatorUrl: 'https://www.sogorikuun.com/',
    name: '亀津～平土野～空港線',
    area: '徳之島町・天城町',
    officialUrl: 'https://www.sogorikuun.com/bus_time/',
    fetchTrips: () =>
      parseHtmlTimetable('https://www.sogorikuun.com/bus_time/', [0], {
        weekdayOnlyClass: 'blue_text',
        skipClasses: ['red_text'],
      }),
  },
  {
    id: 'tokunoshima_kuko_line_return',
    island: '徳之島',
    operatorName: '徳之島総合陸運',
    operatorUrl: 'https://www.sogorikuun.com/',
    name: '空港～平土野～亀津線',
    area: '天城町・徳之島町',
    officialUrl: 'https://www.sogorikuun.com/bus_time/',
    fetchTrips: () =>
      parseHtmlTimetable('https://www.sogorikuun.com/bus_time/', [1], {
        weekdayOnlyClass: 'blue_text',
        skipClasses: ['red_text'],
      }),
  },
  {
    id: 'tokunoshima_inutabu_line',
    island: '徳之島',
    operatorName: '徳之島総合陸運',
    operatorUrl: 'https://www.sogorikuun.com/',
    name: '亀津～犬田布～平土野線（往復）',
    area: '徳之島町・伊仙町・天城町',
    officialUrl: 'https://www.sogorikuun.com/bus_time/',
    fetchTrips: () =>
      parseHtmlTimetable('https://www.sogorikuun.com/bus_time/', [2], {
        weekdayOnlyClass: 'blue_text',
        skipClasses: ['red_text'],
      }),
  },

  // --- 沖永良部島：沖永良部バス企業団 ---
  {
    id: 'okinoerabu_kuko_line',
    island: '沖永良部島',
    operatorName: '沖永良部バス企業団',
    operatorUrl: 'https://okinoerabubus.org/',
    name: '空港線・知名国頭線',
    area: '和泊町・知名町',
    officialUrl: 'https://okinoerabubus.org/scheduled/timetable/',
    pdfUrl: 'https://okinoerabubus.org/wp-content/uploads/2026/04/schedule_202604.pdf',
    fetchTrips: (url) => parsePdfToTrips(url, { anchorText: '停留所', pages: [3] }),
  },
  {
    id: 'okinoerabu_nagamine_line',
    island: '沖永良部島',
    operatorName: '沖永良部バス企業団',
    operatorUrl: 'https://okinoerabubus.org/',
    name: '永嶺線・後蘭線・ガジマル線',
    area: '知名町・和泊町',
    officialUrl: 'https://okinoerabubus.org/scheduled/timetable/',
    pdfUrl: 'https://okinoerabubus.org/wp-content/uploads/2026/04/schedule_202604.pdf',
    fetchTrips: (url) => parsePdfToTrips(url, { anchorText: '停留所', pages: [4, 5] }),
  },

  // --- 与論島：南陸運 ---
  {
    id: 'yoron_loop',
    island: '与論島',
    operatorName: '南陸運',
    operatorUrl: 'https://www.yoron.jp/kiji0037625/index.html',
    name: '島内循環線（北回り・南回り）',
    area: '与論町',
    officialUrl: 'https://www.yoron.jp/kiji0037625/index.html',
    pdfUrl: 'https://www.yoron.jp/kiji0037625/3_7625_2376_up_jgmeba6o.pdf',
    fetchTrips: async (url) => {
      const pages = await fetchPdfPages(url);
      return sortTrips(parseTransposedPdf(pages[0], { 北: 'north', 南: 'south' }));
    },
  },
];

export async function scrapeBusTimetable() {
  const routes = [];
  for (const r of ROUTES) {
    if (!r.fetchTrips) {
      // 自動解析の対象外（画像PDF・構造が複雑等）。捏造を避け、リンク案内のみ。
      routes.push({
        id: r.id,
        island: r.island,
        operatorName: r.operatorName,
        operatorUrl: r.operatorUrl,
        name: r.name,
        area: r.area,
        officialUrl: r.officialUrl,
        parsed: false,
        note: r.note,
      });
      continue;
    }
    try {
      const trips = await r.fetchTrips(r.pdfUrl);
      const groups = groupTripsByGroupId(trips);
      if (groups.length === 0) throw new Error('no trips parsed');
      routes.push({
        id: r.id,
        island: r.island,
        operatorName: r.operatorName,
        operatorUrl: r.operatorUrl,
        name: r.name,
        area: r.area,
        officialUrl: r.officialUrl,
        pdfUrl: r.pdfUrl,
        parsed: true,
        groups,
      });
    } catch (err) {
      console.error(`bus timetable parse failed for ${r.id}: ${err}`);
      // 解析に失敗した場合は捏造せず、リンク案内にフォールバックする。
      routes.push({
        id: r.id,
        island: r.island,
        operatorName: r.operatorName,
        operatorUrl: r.operatorUrl,
        name: r.name,
        area: r.area,
        officialUrl: r.officialUrl,
        parsed: false,
        note: '時刻表の自動取得に失敗しました。下のボタンから公式サイトをご確認ください。',
      });
    }
  }

  return {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    routes,
  };
}

// テスト・デバッグ用に内部関数もエクスポートしておく（本体の動作には影響しない）。
export {
  fetchPdfPages,
  parseTransposedPdf,
  parsePdfToTrips,
  groupTripsByGroupId,
  sortTrips,
  extractBlocks,
  parseBlock,
  tripsFromParsedBlock,
  parseHtmlTimetable,
};
