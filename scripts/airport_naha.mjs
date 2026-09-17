const UA =
  'amami-unkou-navi-bot/1.0 (+https://github.com/yunosukeyoshioka/amami-unkou-navi-config)';

export const NAHA_JSON_URL = 'https://www.naha-airport.co.jp/fis/fis_national.json';
export const NAHA_OFFICIAL_URL = 'https://www.naha-airport.co.jp/flight/today/';

// 那覇空港JSONの「行先」欄（全角スペースを含む表記あり）→ 島名・空港名。
const NAHA_DEST_ISLAND_MAP = {
  沖永良部: '沖永良部島',
  与論: '与論島',
};
const NAHA_DEST_AIRPORT_MAP = {
  沖永良部: '沖永良部空港',
  与論: '与論空港',
};

function normalizePlace(text) {
  return text.replace(/[\s　]/g, '');
}

function classifyNahaFlightStatus(statusJa) {
  if (statusJa.includes('欠航')) return 'cancelled';
  if (statusJa.includes('見合わせ')) return 'suspended';
  if (statusJa.includes('遅延')) return 'delayed';
  return 'normal'; // 出発済/到着済/手荷物受取済/搭乗中 等は正常運航中の状態
}

function parseNahaTimestamp(ts) {
  if (!ts || ts.length < 12) return null;
  return {
    date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
    time: `${ts.slice(8, 10)}:${ts.slice(10, 12)}`,
  };
}

// rows: fis_national.json の data 配列（各行は配列）。
// 列: [航空会社, 便名, 行先(漢字), 行先(英字), 定刻(YYYYMMDDHHMMSS), (空), 実績時刻, ステータス(日本語), ステータス(英語), ゲート, D/A区分, ...]
export function parseNahaAirportJson(rows, { todayIso } = {}) {
  const entries = [];
  for (const row of rows) {
    const flightNo = row[1];
    const placeJa = row[2];
    const scheduledTs = row[4];
    const actualTs = row[6];
    const statusJa = row[7] ?? '';
    const directionCode = row[10];

    const place = normalizePlace(placeJa ?? '');
    const island = NAHA_DEST_ISLAND_MAP[place];
    if (!island) continue;

    const scheduled = parseNahaTimestamp(scheduledTs);
    if (!scheduled) continue;
    if (todayIso && scheduled.date !== todayIso) continue;

    const airportName = NAHA_DEST_AIRPORT_MAP[place];
    const actual = parseNahaTimestamp(actualTs);
    const status = classifyNahaFlightStatus(statusJa);
    const actualTime = actual ? actual.time : scheduled.time;

    if (directionCode === 'D') {
      entries.push({
        label: `${flightNo}便 ${place}行き`,
        time: scheduled.time,
        actualTime,
        status,
        note: statusJa || null,
        direction: 'departure',
        islands: [island],
        departureLocation: '那覇空港',
        arrivalLocation: airportName,
        date: scheduled.date,
      });
    } else if (directionCode === 'A') {
      entries.push({
        label: `${flightNo}便 ${place}発`,
        time: scheduled.time,
        actualTime,
        status,
        note: statusJa || null,
        direction: 'arrival',
        islands: [island],
        departureLocation: airportName,
        arrivalLocation: '那覇空港',
        date: scheduled.date,
      });
    }
  }
  return entries;
}

export async function fetchNahaAirportJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function worstStatus(statuses) {
  const SEVERITY = ['normal', 'delayed', 'conditional', 'suspended', 'cancelled'];
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.reduce((worst, s) => (SEVERITY.indexOf(s) > SEVERITY.indexOf(worst) ? s : worst));
}

function sortByTime(departures) {
  const key = (t) => {
    const m = t.match(/(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 100 + Number(m[2]) : Number.MAX_SAFE_INTEGER;
  };
  return [...departures].sort((a, b) => key(a.time) - key(b.time));
}

function jstTodayIso() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function scrapeNahaAirportDepartures() {
  const payload = await fetchNahaAirportJson(NAHA_JSON_URL);
  if (payload.status !== 'success' || !Array.isArray(payload.data)) {
    throw new Error('naha airport: unexpected JSON payload shape (API may have changed)');
  }

  const todayIso = jstTodayIso();
  const entries = sortByTime(parseNahaAirportJson(payload.data, { todayIso }));

  if (entries.length === 0) {
    throw new Error('naha airport: no amami-islands flights parsed (API may have changed)');
  }

  const status = worstStatus(entries.map((d) => d.status));
  const troubled = entries.filter((d) => d.status !== 'normal');
  const note =
    troubled.length === 0
      ? `本日${entries.length}便中、欠航はありません。`
      : `本日${entries.length}便中${troubled.length}便に遅延・欠航等があります。`;

  return {
    id: 'naha_airport_departures',
    operatorName: '航空便',
    routeName: '那覇空港発着（JAL・JTA他）',
    mode: 'air',
    hubAirportName: '那覇空港',
    status,
    note,
    officialUrl: NAHA_OFFICIAL_URL,
    departures: entries,
  };
}
