import * as cheerio from 'cheerio';

// ============================================================
// 九州電力送配電の停電情報（奄美地方・市町村別）を取得する。
//
// 公式に文書化されたAPIではないが、九州電力送配電自身の停電情報ページ
// （https://www.kyuden.co.jp/td_teiden/kyushu.html）が参照している
// 静的XMLで、鹿児島県 > 奄美地方 の市町村別停電戸数・復旧見込みを
// リアルタイムに取得できる。
//
// URL構成（同社ページのJS（teiden.js）から判明）:
//   xml/c{都道府県ID}.xml      … 都道府県内の地方別サマリー
//   xml/{都道府県ID}_{地方ID}.xml … 地方内の市町村別内訳
// 鹿児島県=46、奄美地方=01。
// ============================================================

const UA = 'Mozilla/5.0 (compatible; AmamiUnkouNaviBot/1.0; +https://yunosukeyoshioka.github.io/amami-unkou-navi-config/)';
const KAGOSHIMA_PREF_ID = '46';
const AMAMI_REGION_ID = '01';
const OFFICIAL_URL = 'https://www.kyuden.co.jp/td_teiden/kyushu.html';

// 停電情報の市町村コード（CITY_ID）→ このアプリで使っている島名。
// 十島村（304）はトカラ列島で、このアプリが対象とする奄美群島5島には
// 含まれないため対象外とする。
const CITY_ID_TO_ISLAND = {
  '222': '奄美大島', // 奄美市
  '523': '奄美大島', // 大和村
  '524': '奄美大島', // 宇検村
  '525': '奄美大島', // 瀬戸内町
  '527': '奄美大島', // 龍郷町
  '529': '喜界島', // 喜界町
  '530': '徳之島', // 徳之島町
  '531': '徳之島', // 天城町
  '532': '徳之島', // 伊仙町
  '533': '沖永良部島', // 和泊町
  '534': '沖永良部島', // 知名町
  '535': '与論島', // 与論町
};

async function fetchXml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const text = await res.text();
  return cheerio.load(text, { xmlMode: true });
}

function text($, el, tag) {
  const t = $(el).find(tag).first().text().trim();
  return t === '' ? null : t;
}

// 「約10,440戸」等の表示文字列から数値を取り出す（無ければnull）。
// 文字列表示自体はそのまま[blackoutCount]として保持し、こちらは
// ソート・「停電あり/なし」判定用の補助値。
function parseCount(displayText) {
  if (!displayText) return 0;
  const m = displayText.replace(/,/g, '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

export async function scrapePowerOutage() {
  // 1. 鹿児島県内の地方別サマリー（奄美地方の合計戸数を含む）
  const $pref = await fetchXml(`https://www.kyuden.co.jp/td_teiden/xml/c${KAGOSHIMA_PREF_ID}.xml`);
  const releaseDateRaw = $pref('HEADER RELEASE_DATE').first().text().trim();
  const prefComment = $pref('DATA PC_COMMENT').first().text().trim() || null;

  let amamiRegionTotal = null;
  $pref('REGION_LIST REGION').each((_, el) => {
    if (text($pref, el, 'REGION_ID') === AMAMI_REGION_ID) {
      amamiRegionTotal = text($pref, el, 'BLACKOUT_COUNT');
    }
  });

  // 2. 奄美地方内の市町村別内訳
  const $region = await fetchXml(
    `https://www.kyuden.co.jp/td_teiden/xml/${KAGOSHIMA_PREF_ID}_${AMAMI_REGION_ID}.xml`,
  );

  const municipalities = [];
  $region('DATA_LIST DATA').each((_, el) => {
    const cityId = text($region, el, 'CITY_ID');
    const cityName = text($region, el, 'CITY_NAME');
    const blackoutCount = text($region, el, 'BLACKOUT_COUNT') ?? '0戸';
    const restoration = text($region, el, 'RESTORATION');
    const island = cityId ? CITY_ID_TO_ISLAND[cityId] : undefined;
    if (!cityId || !cityName || !island) return; // 群島外（十島村等）は対象外
    municipalities.push({
      cityId,
      cityName,
      island,
      blackoutCount,
      hasOutage: parseCount(blackoutCount) > 0,
      restoration,
    });
  });

  if (municipalities.length === 0) {
    throw new Error('power outage: no municipality data parsed (page structure may have changed)');
  }

  // 「令和8年8月28日00時41分現在」の形式ではなく機械可読な日時に変換できる場合のみ変換し、
  // できなければ生の文字列のまま保持する（捏造を避ける）。
  const releaseDateIso = parseKyudenDate(releaseDateRaw);

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sourceReleaseAt: releaseDateIso,
    officialUrl: OFFICIAL_URL,
    amamiRegionBlackoutCount: amamiRegionTotal,
    comment: prefComment,
    municipalities,
  };
}

// 九電のRELEASE_DATEは "20260828004112" 形式（YYYYMMDDhhmmss）。
function parseKyudenDate(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // 九電サイトはJST基準のため、明示的にJST(+09:00)として解釈する。
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`;
}
