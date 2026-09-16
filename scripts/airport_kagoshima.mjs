import { load } from 'cheerio';

const UA =
  'amami-unkou-navi-bot/1.0 (+https://github.com/yunosukeyoshioka/amami-unkou-navi-config)';

export const KOJ_URL_DEP = 'https://www.koj-ab.co.jp/flight/today-dom-departure.html';
export const KOJ_URL_ARR = 'https://www.koj-ab.co.jp/flight/today-dom-arrival.html';

// 鹿児島空港サイトの「行先」/「出発地」欄の表記 → 奄美群島の島名・空港名。
// 奄美大島・その他都市は既存の奄美空港エントリと重複する、または対象外のため含めない。
const KOJ_DEST_ISLAND_MAP = {
  喜界島: '喜界島',
  徳之島: '徳之島',
  沖永良部: '沖永良部島',
  与論: '与論島',
};
const KOJ_DEST_AIRPORT_MAP = {
  喜界島: '喜界空港',
  徳之島: '徳之島空港',
  沖永良部: '沖永良部空港',
  与論: '与論空港',
};

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function classifyKojFlightStatus(bikoText, changedText) {
  if (bikoText.includes('欠航')) return 'cancelled';
  if (bikoText.includes('見合わせ')) return 'suspended';
  if (bikoText.includes('遅延')) return 'delayed';
  if (changedText) return 'delayed'; // 変更列に時刻があれば定刻から変更されている
  return 'normal';
}

// direction: 'departure'（today-dom-departure.html、行先=目的地）
//          | 'arrival'  （today-dom-arrival.html、行先=出発地）
export function parseKagoshimaAirportHtml(html, direction) {
  const $ = load(html);
  const table = $('table#flightList_dep');
  if (table.length === 0) {
    throw new Error('kagoshima airport: flight table not found (page structure may have changed)');
  }

  const rows = table
    .find('tbody tr')
    .toArray()
    .map((row) => {
      const tds = $(row).find('td');
      return {
        flightNo: collapse($(tds[1]).text()),
        place: collapse($(tds[2]).text()),
        scheduled: collapse($(tds[3]).text()),
        changed: collapse($(tds[4]).text()),
        biko: collapse($(tds[5]).text()),
      };
    })
    .filter((f) => f.flightNo && f.scheduled);

  const entries = [];
  for (const row of rows) {
    const island = KOJ_DEST_ISLAND_MAP[row.place];
    if (!island) continue;
    const airportName = KOJ_DEST_AIRPORT_MAP[row.place];
    const status = classifyKojFlightStatus(row.biko, row.changed);
    const actualTime = row.changed || row.scheduled;

    if (direction === 'departure') {
      entries.push({
        label: `${row.flightNo}便 ${row.place}行き`,
        time: row.scheduled,
        actualTime,
        status,
        note: row.biko || null,
        direction: 'departure',
        islands: [island],
        departureLocation: '鹿児島空港',
        arrivalLocation: airportName,
      });
    } else {
      entries.push({
        label: `${row.flightNo}便 ${row.place}発`,
        time: row.scheduled,
        actualTime,
        status,
        note: row.biko || null,
        direction: 'arrival',
        islands: [island],
        departureLocation: airportName,
        arrivalLocation: '鹿児島空港',
      });
    }
  }
  return entries;
}

export async function fetchKagoshimaAirportHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}
