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
  block.columnAnchors = colAnchors;

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

// 同じ停留所が表の上段と下段に二度印刷されている（＝乗り継ぎの区切り）路線では、
// 同名・同時刻の項目が連続して並ぶ。片方は表組みの都合による重複なので畳み込む。
function dropRepeatedStops(stops) {
  return stops.filter((s, i) => {
    const prev = stops[i - 1];
    return !prev || prev.name !== s.name || prev.time !== s.time;
  });
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
    const stops = dropRepeatedStops(dropNonMonotonicStops(rawStops));
    if (stops.length > 0) {
      // 行先の見出しが取れない列は、その便の最終停留所を行先の代わりに使う
      // （捏造ではなく、実データから素直に導ける最も妥当な表示名のため）。
      const destination = parsed.columnHeaders[ci] || stops[stops.length - 1]?.name || null;
      trips.push({ destination, groupId: parsed.dayType, stops, columnIndex: ci });
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
  // cheerio 1.2 が参照する File は Node 18 には無いため、HTML路線を
  // 実際に解析するときだけ読み込み、最低限のWeb APIを補う。
  if (!globalThis.File) globalThis.File = class File {};
  const cheerio = await import('cheerio');
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

function trip(destination, stops) {
  return { destination, stops: stops.map(([name, time]) => ({ name, time })) };
}

function matrixTrips(stopNames, timeColumns) {
  return timeColumns.map((times) => {
    const stops = stopNames
      .map((name, index) => (times[index] ? { name, time: times[index] } : null))
      .filter(Boolean);
    return { destination: stops.at(-1)?.name ?? null, stops };
  });
}

const AIRPORT_TO_STOPS = [
  '平田町奥又', '県立大島病院前', '奄美小学校前', '大島高等学校前', '永田橋',
  'こしゅく第1公園', '平松町', '浜里町', '朝仁', '朝仁入口', '朝仁トンネル前',
  '長浜', '奄美中央病院前', '名瀬合同庁舎前', '塩浜入口', '朝日通り',
  'しまバス本社前', '末広通り', '奄美市役所前', '名瀬郵便局前',
  'ウエストコート前', '和光園前', '佐大熊(県道沿い)', '山羊島ホテル前',
  'だいわ大熊店前', '浦上農業試験場前', 'ビッグII前', '龍郷町役場前',
  '屋入ひさ倉前', '大島紬村入口', '赤尾木郵便局前', 'ばしゃ山', '土浜',
  '奄美パーク', '奄美空港', '大島北高前', '奄美市笠利総合支所前',
  '赤木名外金久', '佐仁',
];

const AIRPORT_FROM_STOPS = [
  '佐仁', '屋仁', '宇宿郵便局前', '赤木名外金久', '奄美市笠利総合支所前',
  '奄美空港', '奄美パーク', '土浜', 'ばしゃ山', '赤尾木郵便局前',
  '大島紬村入口', '屋入ひさ倉前', '龍郷町役場前', 'ビッグII前',
  '浦上農業試験場前', 'だいわ大熊店前', '山羊島ホテル前',
  '佐大熊(県道沿い)', '朝日通り', 'しまバス本社前', '末広通り',
  '奄美市役所前', '名瀬郵便局前', 'ウエストコート前', '塩浜入口',
  '名瀬合同庁舎前', '奄美中央病院前', '長浜', '朝仁トンネル前',
  '朝仁入口', '朝仁', '浜里町', '平松町', 'こしゅく第1公園', '永田橋',
  '大島高等学校前', '奄美小学校前', '県立大島病院前', '真名津町',
  '平田町奥又',
];

function airportTimes(csv) {
  return csv.split(',').map((value) => value.trim() || null);
}

// 公式画像PDF（令和7年4月1日改正）の全列を左から順に転記。
// II（他経路）、空欄、↓、×印は null。days はフッターの規則どおり、
// 注記なし=daily、平日のみ/平日運行=weekday、土日祝のみ=holiday。
const AIRPORT_TO_COLUMNS = [
  { days: 'weekday', times: airportTimes('6:30,6:32,6:34,6:35,6:36,,,,,,,,,,,6:41,,6:37,6:38,6:39,,,6:45,,6:51,6:52,7:04,,7:15,7:17,7:19,,,,7:47,7:33,7:37,7:36,') },
  { days: 'daily', times: airportTimes(',,,,,6:39,6:40,6:42,6:45,6:47,6:48,6:50,6:51,6:53,6:54,6:58,7:00,7:01,7:02,7:03,7:05,,7:11,7:15,7:20,7:21,7:30,7:36,7:39,7:41,7:43,7:46,7:50,,7:57,,,,') },
  {
    days: 'daily',
    times: [
      '7:03', '7:05', '7:07', '7:08', '7:09',
      null, null, null, null, null, null, null, null, null, null,
      '7:14', null, '7:10', '7:11', '7:12', null, null, '7:18', null,
      '7:24', '7:25', '7:37', '7:45', '7:48', '7:50', '7:52',
      null, null, null, '8:20', '8:06', '8:10', '8:09', null,
    ],
  },
  { days: 'weekday', times: airportTimes(',,,,,,,,,,,,,,,,,,,,,,,,,,7:37,7:45,7:48,7:50,7:52,,,,,8:06,,,') },
  { days: 'daily', times: airportTimes(',,,,,7:46,7:47,7:49,7:52,7:54,7:55,7:57,7:58,8:00,8:01,8:05,8:07,8:08,8:09,8:10,8:12,,8:18,8:22,8:27,8:28,8:37,8:43,8:46,8:48,8:50,8:53,8:57,,9:04,,9:15,9:16,') },
  { days: 'daily', times: airportTimes(',,,,,8:16,8:17,8:19,8:22,8:24,8:25,8:27,8:28,8:30,8:31,8:35,8:37,8:38,8:39,8:40,8:42,,8:48,8:52,8:57,8:58,9:07,9:13,9:16,9:18,9:20,9:23,,9:31,9:36,,,,') },
  { days: 'daily', times: airportTimes(',,,,,8:46,8:47,8:49,8:52,8:54,8:55,8:57,8:58,9:00,9:01,9:05,9:07,9:08,9:09,9:10,9:12,,9:18,9:22,9:27,9:28,9:37,9:43,9:46,9:48,9:50,9:53,9:57,10:01,10:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,9:16,9:17,9:19,9:22,9:24,9:25,9:27,9:28,9:30,9:31,9:35,9:37,9:38,9:39,9:40,9:42,,9:48,9:52,9:57,9:58,10:07,10:13,10:16,10:18,10:20,10:23,10:27,10:31,10:36,,10:47,10:48,') },
  { days: 'daily', times: airportTimes(',,,,,9:46,9:47,9:49,9:52,9:54,9:55,9:57,9:58,10:00,10:01,10:05,10:07,10:08,10:09,10:10,10:12,,10:18,10:22,10:27,10:28,10:37,10:43,10:46,10:48,10:50,10:53,10:57,11:01,11:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,10:16,10:17,10:19,10:22,10:24,10:25,10:27,10:28,10:30,10:31,10:35,10:37,10:38,10:39,10:40,10:42,,10:48,10:52,10:57,10:58,11:07,11:13,11:16,11:18,11:20,11:23,11:27,11:31,11:36,,,,') },
  { days: 'daily', times: airportTimes(',,,,,10:46,10:47,10:49,10:52,10:54,10:55,10:57,10:58,11:00,11:01,11:05,11:07,11:08,11:09,11:10,11:12,,11:18,11:22,11:27,11:28,11:37,11:43,11:46,11:48,11:50,11:53,11:57,12:01,12:06,,12:17,12:18,') },
  { days: 'daily', times: airportTimes(',,,,,11:16,11:17,11:19,11:22,11:24,11:25,11:27,11:28,11:30,11:31,11:35,11:37,11:38,11:39,11:40,11:42,,11:48,11:52,11:57,11:58,12:07,12:13,12:16,12:18,12:20,12:23,12:27,12:31,12:36,,,,') },
  { days: 'daily', times: airportTimes(',,,,,11:46,11:47,11:49,11:52,11:54,11:55,11:57,11:58,12:00,12:01,12:05,12:07,12:08,12:09,12:10,12:12,,12:18,12:22,12:27,12:28,12:37,12:43,12:46,12:48,12:50,12:53,12:57,13:01,13:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,12:16,12:17,12:19,12:22,12:24,12:25,12:27,12:28,12:30,12:31,12:35,12:37,12:38,12:39,12:40,12:42,,12:48,12:52,12:57,12:58,13:07,13:13,13:16,13:18,13:20,13:23,13:27,13:31,13:36,,13:47,13:48,') },
  { days: 'daily', times: airportTimes(',,,,,12:46,12:47,12:49,12:52,12:54,12:55,12:57,12:58,13:00,13:01,13:05,13:07,13:08,13:09,13:10,13:12,,13:18,13:22,13:27,13:28,13:37,13:43,13:46,13:48,13:50,13:53,13:57,14:01,14:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,13:16,13:17,13:19,13:22,13:24,13:25,13:27,13:28,13:30,13:31,13:35,13:37,13:38,13:39,13:40,13:42,,13:48,13:52,13:57,13:58,14:07,14:13,14:16,14:18,14:20,14:23,14:27,14:31,14:36,,,,') },
  { days: 'daily', times: airportTimes(',,,,,13:46,13:47,13:49,13:52,13:54,13:55,13:57,13:58,14:00,14:01,14:05,14:07,14:08,14:09,14:10,14:12,,14:18,14:22,14:27,14:28,14:37,14:43,14:46,14:48,14:50,14:53,14:57,15:01,15:06,,15:17,15:18,') },
  { days: 'daily', times: airportTimes(',,,,,14:16,14:17,14:19,14:22,14:24,14:25,14:27,14:28,14:30,14:31,14:35,14:37,14:38,14:39,14:40,14:42,,14:48,14:52,14:57,14:58,15:07,15:13,15:16,15:18,15:20,15:23,15:27,15:31,15:36,,,,') },
  { days: 'daily', times: airportTimes(',,,,,14:46,14:47,14:49,14:52,14:54,14:55,14:57,14:58,15:00,15:01,15:05,15:07,15:08,15:09,15:10,15:12,,15:18,15:22,15:27,15:28,15:37,15:43,15:46,15:48,15:50,15:53,15:57,16:01,16:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,15:16,15:17,15:19,15:22,15:24,15:25,15:27,15:28,15:30,15:31,15:35,15:37,15:38,15:39,15:40,15:42,,15:48,15:52,15:57,15:58,16:07,16:13,16:16,16:18,16:20,16:23,16:27,16:31,16:36,,16:47,16:48,') },
  { days: 'daily', times: airportTimes(',,,,,15:46,15:47,15:49,15:52,15:54,15:55,15:57,15:58,16:00,16:01,16:05,16:07,16:08,16:09,16:10,16:12,,16:18,16:22,16:27,16:28,16:37,16:43,16:46,16:48,16:50,16:53,16:57,17:01,17:06,,,,') },
  { days: 'daily', times: airportTimes(',,,,,16:16,16:17,16:19,16:22,16:24,16:25,16:27,16:28,16:30,16:31,16:35,16:37,16:38,16:39,16:40,16:42,,16:48,16:52,16:57,16:58,17:07,17:13,17:16,17:18,17:20,17:23,17:27,17:31,17:36,,,,') },
  { days: 'daily', times: airportTimes('16:50,16:52,16:54,16:55,16:56,,,,,,,,,,,17:04,17:06,16:57,16:58,16:59,17:01,17:10,,,,17:14,17:24,17:29,17:32,17:34,17:36,17:39,17:43,17:46,17:52,,18:03,18:04,') },
  { days: 'daily', times: airportTimes('18:00,18:02,18:04,18:05,18:06,,,,,,,,,,,18:11,,18:07,18:08,18:09,,,18:15,,18:21,,18:34,18:42,18:45,18:47,18:49,,,,19:17,19:03,,19:06,19:44') },
  { days: 'holiday', times: airportTimes('18:37,18:39,18:41,18:42,18:43,,,,,,,,,,,18:48,,18:44,18:45,18:46,,,18:52,,18:58,18:59,19:11,19:19,19:22,,19:26,,,,19:54,19:40,,19:43,') },
  { days: 'weekday', times: airportTimes('18:50,18:52,18:54,18:55,18:56,,,,,,,,,,,19:01,,18:57,18:58,18:59,,,19:05,,19:11,19:12,19:24,19:32,19:35,,19:39,,,,20:07,19:53,19:57,19:56,20:34') },
];

const AIRPORT_FROM_COLUMNS = [
  { days: 'weekday', times: airportTimes('6:19,6:24,,6:35,6:36,,,,,6:52,6:54,6:56,6:59,7:07,7:16,7:17,,7:23,7:27,7:28,,,,,,,,,,,,,,,7:29,7:30,7:31,7:33,7:34,') },
  {
    days: 'daily',
    times: [
      '6:23', null, '6:47', '7:02', '7:03', '6:50', null, null, null,
      '7:19', '7:21', '7:23', '7:26', '7:33', '7:42', '7:43', null,
      '7:49', '7:53', null, '7:57', '7:56', '7:55',
      null, null, null, null, null, null, null, null, null, null, null,
      '7:59', '8:00', '8:01', '8:03', '8:04', '8:05',
    ],
  },
  {
    days: 'daily',
    times: [
      null, null, null, '8:42', '8:43', '8:30', null, null, null,
      '8:59', '9:01', '9:03', '9:06', '9:13', '9:22', '9:23', null,
      '9:29', '9:33', null, '9:37', '9:36', '9:35',
      null, null, null, null, null, null, null, null, null, null, null,
      '9:39', '9:40', '9:41', '9:43', '9:44', '9:45',
    ],
  },
  { days: 'daily', times: airportTimes(',,,,,8:52,,8:59,9:03,9:06,9:08,9:10,9:13,9:19,9:28,9:29,,9:35,9:39,9:41,9:42,9:43,9:44,9:46,9:48,9:49,9:51,9:52,9:54,9:55,9:57,10:00,10:02,10:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,9:20,9:25,9:29,9:33,9:36,9:38,9:40,9:43,9:49,9:58,9:59,,10:05,10:09,10:11,10:12,10:13,10:14,10:16,10:18,10:19,10:21,10:22,10:24,10:25,10:27,10:30,10:32,10:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,9:33,9:34,9:50,9:55,9:59,10:03,10:06,10:08,10:10,10:13,10:19,10:28,10:29,,10:35,10:39,10:41,10:42,10:43,10:44,10:46,10:48,10:49,10:51,10:52,10:54,10:55,10:57,11:00,11:02,11:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,10:20,10:25,10:29,10:33,10:36,10:38,10:40,10:43,10:49,10:58,10:59,,11:05,11:09,11:11,11:12,11:13,11:14,11:16,11:18,11:19,11:21,11:22,11:24,11:25,11:27,11:30,11:32,11:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,10:50,10:55,10:59,11:03,11:06,11:08,11:10,11:13,11:19,11:28,11:29,,11:35,11:39,11:41,11:42,11:43,11:44,11:46,11:48,11:49,11:51,11:52,11:54,11:55,11:57,12:00,12:02,12:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,11:03,11:04,11:20,11:25,11:29,11:33,11:36,11:38,11:40,11:43,11:49,11:58,11:59,,12:05,12:09,12:11,12:12,12:13,12:14,,12:18,12:19,12:21,12:22,12:24,12:25,12:27,12:30,12:32,12:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,11:50,11:55,11:59,12:03,12:06,12:08,12:10,12:13,12:19,12:28,12:29,,12:35,12:39,12:41,12:42,12:43,12:44,12:46,12:48,12:49,12:51,12:52,12:54,12:55,12:57,13:00,13:02,13:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,12:20,12:25,12:29,12:33,12:36,12:38,12:40,12:43,12:49,12:58,12:59,,13:05,13:09,13:11,13:12,13:13,13:14,13:16,13:18,13:19,13:21,13:22,13:24,13:25,13:27,13:30,13:32,13:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,12:33,12:34,12:50,12:55,12:59,13:03,13:06,13:08,13:10,13:13,13:19,13:28,13:29,,13:35,13:39,13:41,13:42,13:43,13:44,13:46,13:48,13:49,13:51,13:52,13:54,13:55,13:57,14:00,14:02,14:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,13:20,13:25,13:29,13:33,13:36,13:38,13:40,13:43,13:49,13:58,13:59,,14:05,14:09,14:11,14:12,14:13,14:14,14:16,14:18,14:19,14:21,14:22,14:24,14:25,14:27,14:30,14:32,14:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,13:50,13:55,13:59,14:03,14:06,14:08,14:10,14:13,14:19,14:28,14:29,,14:35,14:39,14:41,14:42,14:43,14:44,14:46,14:48,14:49,14:51,14:52,14:54,14:55,14:57,15:00,15:02,15:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,14:03,14:04,14:20,14:25,14:29,14:33,14:36,14:38,14:40,14:43,14:49,14:58,14:59,,15:05,15:09,15:11,15:12,15:13,15:14,15:16,15:18,15:19,15:21,15:22,15:24,15:25,15:27,15:30,15:32,15:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,14:50,14:55,14:59,15:03,15:06,15:08,15:10,15:13,15:19,15:28,15:29,,15:35,15:39,15:41,15:42,15:43,15:44,15:46,15:48,15:49,15:51,15:52,15:54,15:55,15:57,16:00,16:02,16:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,15:20,15:25,15:29,15:33,15:36,15:38,15:40,15:43,15:49,15:58,15:59,,16:05,16:09,16:11,16:12,16:13,16:14,16:16,16:18,16:19,16:21,16:22,16:24,16:25,16:27,16:30,16:32,16:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,15:33,15:34,15:50,15:55,15:59,16:03,16:06,16:08,16:10,16:13,16:19,16:28,16:29,,16:35,16:39,16:41,16:42,16:43,16:44,16:46,16:48,16:49,16:51,16:52,16:54,16:55,16:57,17:00,17:02,17:03,,,,,,') },
  {
    days: 'daily',
    times: [
      null, null, null, '16:27', '16:28', '16:15', null, null, null,
      '16:44', '16:46', '16:48', '16:51', '16:58', '17:07', '17:08', null,
      '17:14', '17:18', null, '17:22', '17:21', '17:20',
      null, null, null, null, null, null, null, null, null, null, null,
      '17:24', '17:25', '17:26', '17:28', '17:29', '17:30',
    ],
  },
  { days: 'daily', times: airportTimes(',,,,,16:50,16:55,16:59,17:03,17:06,17:08,17:10,17:13,17:19,17:28,17:29,,17:35,17:39,17:41,17:42,17:43,17:44,17:46,17:48,17:49,17:51,17:52,17:54,17:55,17:57,18:00,18:02,18:03,,,,,,') },
  { days: 'daily', times: airportTimes(',,,17:03,17:04,17:20,17:25,17:29,17:33,17:36,17:38,17:40,17:43,17:49,17:58,17:59,,18:05,18:09,18:11,18:12,18:13,18:14,18:16,18:18,18:19,18:21,18:22,18:24,18:25,18:27,18:30,18:32,18:33,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,17:50,17:55,17:59,18:03,18:06,18:08,18:10,18:13,18:19,18:28,18:29,,18:35,18:39,18:41,18:42,18:43,18:44,18:46,18:48,18:49,18:51,18:52,18:54,18:55,18:57,19:00,19:02,19:03,,,,,,') },
  {
    days: 'weekday',
    times: [
      null, null, null, '18:22', '18:23', null, null, null, null,
      '18:39', '18:41', '18:43', '18:46', '18:53', '19:02', '19:03', null,
      '19:09', '19:13', null, '19:17', '19:16', '19:15',
      null, null, null, null, null, null, null, null, null, null, null,
      '19:19', '19:20', '19:21', null, '19:24', '19:25',
    ],
  },
  { days: 'daily', times: airportTimes(',,,18:00,18:01,18:17,,18:25,18:28,18:31,18:33,18:35,18:38,18:44,18:53,18:54,,19:00,19:04,19:06,19:07,19:08,19:09,,19:13,,19:16,19:17,19:19,19:20,,19:25,,,,,,,,') },
  { days: 'daily', times: airportTimes(',,,,,18:47,,18:54,18:58,19:01,19:03,19:05,19:08,19:14,19:23,19:24,,19:30,19:34,19:36,19:37,19:38,19:39,19:41,19:43,19:44,19:46,19:47,19:49,19:50,19:52,19:55,19:57,19:58,,,,,,') },
];

function fixedAirportTrips() {
  const trips = [];
  for (const [direction, stops, columns] of [
    ['to', AIRPORT_TO_STOPS, AIRPORT_TO_COLUMNS],
    ['from', AIRPORT_FROM_STOPS, AIRPORT_FROM_COLUMNS],
  ]) {
    for (const [columnIndex, column] of columns.entries()) {
      if (column.times.length !== stops.length) {
        throw new Error(
          `airport ${direction} column ${columnIndex} length mismatch: ${column.times.length} != ${stops.length}`,
        );
      }
      const [rawTrip] = matrixTrips(stops, [column.times]);
      // 分岐経路を1つの表に掲載した列では、表の行順に対して時刻が逆行する
      // セルがある。原本の指示どおり推測で並べ替えず、そのセルのみ収録しない。
      const cleanedStops = dropNonMonotonicStops(rawTrip.stops);
      if (cleanedStops.length === 0) continue;
      for (const groupId of DAYS_TO_GROUP_IDS[column.days]) {
        trips.push({
          groupId,
          destination: cleanedStops.at(-1)?.name ?? null,
          stops: cleanedStops,
        });
      }
    }
  }
  return sortTrips(trips);
}

const KONIYA_PDF_URL = 'https://shimabus.co.jp/wp-content/uploads/2025/03/2_koniya_time.pdf';
const KONIYA_OUTBOUND_STOPS = [
  'こしゅく第1公園',
  '奄美中央病院前',
  '名瀬合同庁舎前',
  '塩浜入口',
  '入舟町',
  'しまバス本社前',
  '大島高校前',
  '奄美小学校前',
  '県立大島病院前',
  '三太郎の里',
  '奄美市住用総合支所前',
  'マングローブパーク',
  '新村',
  '阿木名',
  'せとうち海の駅',
];
const KONIYA_OUTBOUND_TIMES = [
  // 1便目のマングローブパークは原本が「－」（停車なし）。
  ['6:10', '6:22', '6:24', '6:25', '6:28', '6:31', '6:33', '6:34', '6:36', '6:56', '7:04', null, '7:14', '7:31', '7:44'],
  ['7:34', '7:46', '7:48', '7:49', '7:52', '7:59', '8:01', '8:02', '8:04', '8:24', '8:32', '8:34', '8:44', '9:01', '9:14'],
  ['10:29', '10:41', '10:43', '10:44', '10:47', '10:54', '10:56', '10:57', '10:59', '11:19', '11:27', '11:29', '11:39', '11:56', '12:09'],
  ['11:59', '12:11', '12:13', '12:14', '12:17', '12:24', '12:26', '12:27', '12:29', '12:49', '12:57', '12:59', '13:09', '13:26', '13:39'],
  ['13:29', '13:41', '13:43', '13:44', '13:47', '13:54', '13:56', '13:57', '13:59', '14:19', '14:27', '14:29', '14:39', '14:56', '15:09'],
  ['14:59', '15:11', '15:13', '15:14', '15:17', '15:24', '15:26', '15:27', '15:29', '15:49', '15:57', '15:59', '16:09', '16:26', '16:39'],
  ['16:29', '16:41', '16:43', '16:44', '16:47', '16:54', '16:56', '16:57', '16:59', '17:19', '17:27', '17:29', '17:39', '17:56', '18:09'],
  ['18:29', '18:41', '18:43', '18:44', '18:47', '18:54', '18:56', '18:57', '18:59', '19:19', '19:27', '19:29', '19:39', '19:56', '20:09'],
];
const KONIYA_RETURN_STOPS = [...KONIYA_OUTBOUND_STOPS].reverse();
const KONIYA_RETURN_TIMES = [
  ['6:40', '6:53', '7:16', '7:26', '7:27', '7:38', '7:56', '7:58', '7:59', '8:04', '8:08', '8:10', '8:12', '8:14', '8:26'],
  ['8:12', '8:25', '8:43', '8:53', '8:54', '9:05', '9:23', '9:25', '9:26', '9:31', '9:35', '9:37', '9:39', '9:41', '9:53'],
  ['9:42', '9:55', '10:13', '10:23', '10:24', '10:35', '10:53', '10:55', '10:56', '11:01', '11:05', '11:07', '11:09', '11:11', '11:23'],
  ['12:42', '12:55', '13:13', '13:23', '13:24', '13:35', '13:53', '13:55', '13:56', '14:01', '14:05', '14:07', '14:09', '14:11', '14:23'],
  ['14:12', '14:25', '14:43', '14:53', '14:54', '15:05', '15:23', '15:25', '15:26', '15:31', '15:35', '15:37', '15:39', '15:41', '15:53'],
  ['15:42', '15:55', '16:13', '16:23', '16:24', '16:35', '16:53', '16:55', '16:56', '17:01', '17:05', '17:07', '17:09', '17:11', '17:23'],
  ['17:12', '17:25', '17:43', '17:53', '17:54', '18:05', '18:23', '18:25', '18:26', '18:31', '18:35', '18:37', '18:39', '18:41', '18:53'],
  ['18:42', '18:55', '19:13', '19:23', '19:24', '19:35', '19:53', '19:55', '19:56', null, '20:01', '20:03', '20:05', '20:07', '20:19'],
];

function fixedKoniyaTrips() {
  const daily = [
    ...matrixTrips(KONIYA_OUTBOUND_STOPS, KONIYA_OUTBOUND_TIMES),
    ...matrixTrips(KONIYA_RETURN_STOPS, KONIYA_RETURN_TIMES),
  ];
  // 住用町市線（平日のみ運行）。復路の奄美市役所前は、原本で
  // しまバス本社前7:33の後に7:29と印刷され時系列が矛盾するため、
  // 正しい時刻を推測せず、この1コマだけ収録しない。
  const weekdayOnly = [
    trip('住用町市', [
      ['浦上奥万田', '18:00'],
      ['奄美市役所前', '18:16'],
      ['しまバス本社前', '18:20'],
      ['大島高等学校前', '18:22'],
      ['奄美小学校前', '18:23'],
      ['平田町奥又', '18:27'],
      ['三太郎の里', '18:44'],
      ['住用町川内', '18:50'],
      ['東仲間', '18:54'],
      ['奄美体験交流館前', '18:55'],
      ['奄美市住用総合支所前', '19:03'],
      ['マングローブパーク入口', '19:04'],
      ['奄美アイランド', '19:08'],
      ['山間', '19:10'],
      ['住用町市', '19:24'],
    ]),
    trip('浦上奥万田', [
      ['住用町市', '6:25'],
      ['山間', '6:39'],
      ['奄美アイランド', '6:41'],
      ['マングローブパーク入口', '6:45'],
      ['奄美市住用総合支所前', '6:46'],
      ['奄美体験交流館前', '6:53'],
      ['東仲間', '6:54'],
      ['住用町川内', '6:58'],
      ['三太郎の里', '7:05'],
      ['平田町奥又', '7:21'],
      ['奄美小学校前', '7:25'],
      ['大島高等学校前', '7:26'],
      ['しまバス本社前', '7:33'],
      ['浦上奥万田', '7:50'],
    ]),
  ];
  return [
    ...daily.flatMap((t) => [
      { ...t, groupId: 'weekday' },
      { ...t, groupId: 'holiday' },
    ]),
    ...weekdayOnly.map((t) => ({ ...t, groupId: 'weekday' })),
  ];
}

const UKEN_PDF_URL = 'https://shimabus.co.jp/wp-content/uploads/2026/02/uken_20251001jikokuhyou_20260218.pdf';

// 宇検村方面の4つの表を、原本の停留所順・運行日区分のまま転記する。
// 各列（＝1便）は表の停留所並びの連続した区間なので、開始停留所と
// そこから下に並ぶ時刻列で表す（空欄・通過は null）。
// 乗換で行先が変わる列は結合せず、原本どおり別の便として持つ。
const UKEN_TABLES = [
  {
    // 宇検 → 名瀬市街地・奄美空港方面行き
    stops: [
      '宇検', '久志', '生勝', '芦検住宅前', '芦検', '田検', '湯湾', 'ケンムンの館', '石良', '新村',
      'マングローブパーク', '県立大島病院前', '奄美小学校前', '大島高等学校前', 'しまバス本社前',
      'ウエストコート前', '名瀬合同庁舎前', '奄美中央病院前', 'こしゅく第1公園', '奄美空港',
    ],
    columns: [
      // ケンムンの館は「※2↓」（経由しない旨の注記）のため時刻なし。
      { days: 'daily', from: '宇検', times: ['6:15', '6:19', '6:22', '6:32', '6:33', '6:39', '6:41', null, '6:46', '7:11'] },
      { days: 'daily', from: '新村', times: ['7:16', '7:26', '7:56', '7:58', '7:59', '8:04', '8:09', '8:12', '8:14', '8:26'] },
      { days: 'daily', from: 'しまバス本社前', times: ['8:37', null, null, null, null, '9:34'] },
      { days: 'daily', from: '宇検', times: ['9:10', '9:14', '9:17', '9:27', '9:28', '9:34', '9:36', '9:41', '9:43', '10:08'] },
      { days: 'daily', from: '新村', times: ['10:13', '10:23', '10:53', '10:55', '10:56', '11:01', '11:06', '11:09', '11:11', '11:23'] },
      { days: 'daily', from: 'しまバス本社前', times: ['11:07', null, null, null, null, '12:06'] },
      { days: 'daily', from: '宇検', times: ['13:35', '13:39', '13:42', '13:52', '13:53', '13:59', '14:01', '14:06', '14:08', '14:33'] },
      // 奄美中央病院前は原本の印字が「14:41」で前後（15:39→15:53）と矛盾する。
      // 推測で直さず、確実でない1コマだけを空欄として扱う。
      { days: 'daily', from: '新村', times: ['14:43', '14:53', '15:23', '15:25', '15:26', '15:31', '15:36', '15:39', null, '15:53'] },
      { days: 'daily', from: 'しまバス本社前', times: ['15:37', null, null, null, null, '16:36'] },
      { days: 'weekday', from: '湯湾', times: ['17:01', '17:06', '17:08', '17:33'] },
      { days: 'weekday', from: '新村', times: ['17:43', '17:53', '18:23', '18:25', '18:26', '18:31', '18:36', '18:39', '18:41', '18:53'] },
    ],
  },
  {
    // 奄美空港・名瀬市街地 → 宇検行き
    stops: [
      '奄美空港', 'こしゅく第1公園', '奄美中央病院前', '名瀬合同庁舎前', 'ウエストコート前',
      'しまバス本社前', '大島高等学校前', '奄美小学校前', '県立大島病院前', 'マングローブパーク',
      '新村', '石良', 'ケンムンの館', '湯湾', '田検', '芦検', '芦検住宅前', '生勝', '久志', '宇検',
    ],
    columns: [
      // マングローブパークは原本が「－」（停車なし）。
      { days: 'daily', from: 'こしゅく第1公園', times: ['6:10', '6:22', '6:24', '6:27', '6:31', '6:33', '6:34', '6:36', null, '7:14'] },
      { days: 'daily', from: '新村', times: ['7:21', '7:46', '7:50', '7:53', '7:55', '8:01', '8:02', '8:12', '8:15', '8:19'] },
      { days: 'daily', from: '奄美空港', times: ['9:50', null, null, null, null, '10:41'] },
      { days: 'daily', from: 'こしゅく第1公園', times: ['10:29', '10:41', '10:43', '10:46', '10:54', '10:56', '10:57', '10:59', '11:29', '11:39'] },
      { days: 'daily', from: '新村', times: ['11:45', '12:10', '12:14', '12:17', '12:19', '12:25', '12:26', '12:36', '12:39', '12:43'] },
      { days: 'weekday', from: '奄美空港', times: ['12:50', null, null, null, null, '13:41'] },
      { days: 'weekday', from: 'こしゅく第1公園', times: ['13:29', '13:41', '13:43', '13:46', '13:54', '13:56', '13:57', '13:59', '14:29', '14:39'] },
      { days: 'weekday', from: '新村', times: ['14:50', '15:15', '15:19', '15:22'] },
      { days: 'holiday', from: '奄美空港', times: ['14:20', null, null, null, null, '15:11'] },
      { days: 'holiday', from: 'こしゅく第1公園', times: ['14:59', '15:11', '15:13', '15:16', '15:24', '15:26', '15:27', '15:29', '15:59', '16:09'] },
      { days: 'holiday', from: '新村', times: ['16:20', '16:45', '16:49', '16:52', '16:54', '17:00', '17:01', '17:11', '17:14', '17:18'] },
      { days: 'weekday', from: '奄美空港', times: ['15:50', null, null, null, null, '16:41'] },
      { days: 'weekday', from: 'こしゅく第1公園', times: ['16:29', '16:41', '16:43', '16:46', '16:54', '16:56', '16:57', '16:59', '17:29', '17:39'] },
      { days: 'weekday', from: '新村', times: ['17:50', '18:15', '18:19', '18:22', '18:24', '18:30', '18:31', '18:41', '18:44', '18:48'] },
    ],
  },
  {
    // 宇検 → 瀬戸内町古仁屋行き
    stops: [
      '宇検', '久志', '生勝', '芦検住宅前', '芦検', '田検', '湯湾', 'ケンムンの館', '石良', '新村',
      '勝浦', '阿木名', 'ひかり幼稚園前', '古仁屋港前', '瀬戸内合同庁舎前', '古仁屋郵便局前', 'せとうち海の駅',
    ],
    columns: [
      { days: 'daily', from: '宇検', times: ['6:15', '6:19', '6:22', '6:32', '6:33', '6:39', '6:41', null, '6:46', '7:11'] },
      { days: 'daily', from: '新村', times: ['7:14', '7:28', '7:31', '7:37', '7:39', '7:41', '7:42', '7:44'] },
      { days: 'daily', from: '宇検', times: ['13:35', '13:39', '13:42', '13:52', '13:53', '13:59', '14:01', '14:06', '14:08', '14:33'] },
      { days: 'daily', from: '新村', times: ['14:39', '14:53', '14:56', '15:02', '15:04', '15:06', '15:07', '15:09'] },
      { days: 'weekday', from: '湯湾', times: ['17:01', '17:06', '17:08', '17:33'] },
      { days: 'weekday', from: '新村', times: ['17:39', '17:53', '17:56', '18:02', '18:04', '18:06', '18:07', '18:09'] },
    ],
  },
  {
    // 瀬戸内町古仁屋 → 宇検行き
    stops: [
      'せとうち海の駅', '古仁屋郵便局前', '瀬戸内合同庁舎前', '古仁屋港前', 'ひかり幼稚園前',
      '阿木名', '勝浦', '新村', '石良', 'ケンムンの館', '湯湾', '田検', '芦検', '芦検住宅前',
      '生勝', '久志', '宇検',
    ],
    columns: [
      { days: 'daily', from: 'せとうち海の駅', times: ['6:40', '6:42', '6:43', '6:45', '6:47', '6:53', '6:57', '7:11'] },
      { days: 'daily', from: '新村', times: ['7:21', '7:46', '7:50', '7:53', '7:55', '8:01', '8:02', '8:12', '8:15', '8:19'] },
      { days: 'weekday', from: 'せとうち海の駅', times: ['14:12', '14:14', '14:15', '14:17', '14:19', '14:25', '14:29', '14:43'] },
      { days: 'weekday', from: '新村', times: ['14:50', '15:15', '15:19', '15:22'] },
      { days: 'holiday', from: 'せとうち海の駅', times: ['15:42', '15:44', '15:45', '15:47', '15:49', '15:55', '15:59', '16:13'] },
      { days: 'holiday', from: '新村', times: ['16:20', '16:45', '16:49', '16:52', '16:54', '17:00', '17:01', '17:11', '17:14', '17:18'] },
      { days: 'weekday', from: 'せとうち海の駅', times: ['17:12', '17:14', '17:15', '17:17', '17:19', '17:25', '17:29', '17:43'] },
      { days: 'weekday', from: '新村', times: ['17:50', '18:15', '18:19', '18:22', '18:24', '18:30', '18:31', '18:41', '18:44', '18:48'] },
    ],
  },
];

const DAYS_TO_GROUP_IDS = { daily: ['weekday', 'holiday'], weekday: ['weekday'], holiday: ['holiday'] };

function fixedUkenTrips() {
  const byKey = new Map();
  for (const table of UKEN_TABLES) {
    for (const column of table.columns) {
      const start = table.stops.indexOf(column.from);
      if (start === -1) throw new Error(`unknown uken stop: ${column.from}`);
      if (start + column.times.length > table.stops.length) {
        throw new Error(`uken column overflows stop list: ${column.from}`);
      }
      const stops = column.times
        .map((time, i) => (time ? { name: table.stops[start + i], time } : null))
        .filter(Boolean);
      // 同じ便が2つの表に載っている（例：宇検→新村の区間）ため、
      // 停留所・時刻・運行日が完全に一致する便は1件だけ残す。
      for (const groupId of DAYS_TO_GROUP_IDS[column.days]) {
        const key = `${groupId}|${JSON.stringify(stops)}`;
        if (byKey.has(key)) continue;
        byKey.set(key, { groupId, destination: stops.at(-1)?.name ?? null, stops });
      }
    }
  }
  return sortTrips([...byKey.values()]);
}

const SANI_PDF_URL = 'https://shimabus.sakura.ne.jp/file.shimabus.co.jp/r7_1001sani_line.pdf';

// 佐仁線は「平日運行」「土日祝運行」が列ごとの見出しとして印字されており、
// 見出しセルは複数列にまたがることがある（＝右隣の列にも効く）。
// 各列の運行日は「その列の位置以下で最も右にある見出し」から決める。
// 決められない列があれば、誤った日区分で案内するより解析失敗として扱う。
function dayTypesForColumns(page, block, columnAnchors) {
  const labels = [];
  for (const row of groupRows(page)) {
    if (row.y <= block.yTop || row.y > block.yTop + 120) continue;
    for (const it of row.items) {
      if (it.x < block.xLow || it.x >= block.xHigh) continue;
      const dayType = detectDayType(it.text);
      if (dayType !== 'unknown') labels.push({ x: it.x, dayType });
    }
  }
  labels.sort((a, b) => a.x - b.x);
  return columnAnchors.map((x) => {
    const applicable = labels.filter((l) => l.x <= x + 12);
    if (applicable.length === 0) throw new Error(`no day type label for column at x=${x.toFixed(1)}`);
    return applicable[applicable.length - 1].dayType;
  });
}

async function parseSaniTrips(url) {
  const [page] = await fetchPdfPages(url);
  if (!page) return [];
  const trips = [];
  for (const block of extractBlocks(page)) {
    const parsed = parseBlock(block);
    if (!parsed) continue;
    const dayTypes = dayTypesForColumns(page, block, block.columnAnchors);
    for (const parsedTrip of tripsFromParsedBlock(parsed)) {
      trips.push({ ...parsedTrip, groupId: dayTypes[parsedTrip.columnIndex] });
    }
  }
  return sortTrips(trips);
}

const KIKAI_PDF_URL = 'https://www.town.kikai.lg.jp/kankou/kanko-iju/kotsuannai/documents/basujikoku.pdf';

function parseKikaiTable(rows, { id, labelMinX, labelMaxX, columnXs, minY }) {
  const columns = columnXs.map(() => []);
  for (const row of rows) {
    if (row.y < minY) continue;
    const name = row.items
      .filter((item) => item.x >= labelMinX && item.x <= labelMaxX)
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join('')
      .trim();
    if (!name) continue;
    for (let ci = 0; ci < columnXs.length; ci++) {
      const center = columnXs[ci];
      const rawTime = row.items
        .filter((item) => Math.abs(item.x - center) <= 11)
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join('')
        .replace('：', ':');
      if (isTimeText(rawTime)) columns[ci].push({ name, time: rawTime });
    }
  }
  return columns
    .filter((stops) => stops.length > 0)
    .map((stops) => ({
      groupId: id,
      destination: stops.at(-1)?.name ?? null,
      stops,
    }));
}

async function parseKikaiTrips(url) {
  const [page] = await fetchPdfPages(url);
  if (!page) return [];
  const rows = groupRows(page, 2);
  const south = parseKikaiTable(rows, {
    id: 'south',
    labelMinX: 40,
    labelMaxX: 102,
    columnXs: [120, 151, 182, 213, 245, 276],
    minY: 140,
  });
  const north = parseKikaiTable(rows, {
    id: 'north',
    labelMinX: 315,
    labelMaxX: 377,
    columnXs: [396, 427, 458, 490, 521, 552],
    minY: 100,
  });
  // PDF冒頭の注記「北中央線 18:00発を除いて再開」に基づき明示的に除外。
  return sortTrips([...south, ...north.filter((t) => t.stops[0]?.time !== '18:00')]);
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
    pdfUrl: 'https://shimabus.co.jp/wp-content/uploads/2025/03/1_to_kuko_time.pdf',
    revisionDate: '2025-04-01',
    fetchTrips: () => fixedAirportTrips(),
  },
  {
    id: 'koniya_sumiyo_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: 'せとうち海の駅（古仁屋）・住用線',
    area: '瀬戸内町・住用町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    pdfUrl: KONIYA_PDF_URL,
    revisionDate: '2025-04-01',
    fetchTrips: () => fixedKoniyaTrips(),
  },
  {
    id: 'sani_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '佐仁線（笠利町佐仁⇔市街地）',
    area: '笠利町',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    pdfUrl: SANI_PDF_URL,
    revisionDate: '2025-10-01',
    fetchTrips: (url) => parseSaniTrips(url),
  },
  {
    id: 'toguchi_uken_line',
    island: '奄美大島',
    operatorName: 'しまバス',
    operatorUrl: 'https://shimabus.co.jp/',
    name: '新村・石良・湯湾・宇検線',
    area: '宇検村',
    officialUrl: 'https://shimabus.co.jp/rosen/suburban-line-new/',
    pdfUrl: UKEN_PDF_URL,
    revisionDate: '2025-10-01',
    fetchTrips: () => fixedUkenTrips(),
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
    pdfUrl: KIKAI_PDF_URL,
    revisionDate: '2026-06-01',
    fetchTrips: (url) => parseKikaiTrips(url),
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

export async function buildBusRoute(routeId) {
  const r = ROUTES.find((route) => route.id === routeId);
  if (!r) throw new Error(`unknown bus route: ${routeId}`);
  const base = {
    id: r.id,
    island: r.island,
    operatorName: r.operatorName,
    operatorUrl: r.operatorUrl,
    name: r.name,
    area: r.area,
    officialUrl: r.officialUrl,
  };
  if (!r.fetchTrips) {
    return { ...base, parsed: false, note: r.note };
  }
  const trips = await r.fetchTrips(r.pdfUrl);
  const labels = r.id === 'kikai_bus' ? { south: '南中央線', north: '北中央線' } : DEFAULT_GROUP_LABELS;
  let groups = groupTripsByGroupId(trips, labels);
  if (r.id === 'kikai_bus') {
    groups = ['south', 'north'].map((id) => groups.find((group) => group.id === id)).filter(Boolean);
  }
  if (groups.length === 0) throw new Error('no trips parsed');
  return {
    ...base,
    pdfUrl: r.pdfUrl,
    revisionDate: r.revisionDate ?? null,
    parsed: true,
    groups,
  };
}

export async function scrapeBusTimetable() {
  const routes = [];
  for (const r of ROUTES) {
    try {
      routes.push(await buildBusRoute(r.id));
    } catch (err) {
      console.error(`bus timetable parse failed for ${r.id}: ${err}`);
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
