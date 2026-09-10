import { load } from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const UA =
  'amami-unkou-navi-bot/1.0 (+https://github.com/yunosukeyoshioka/amami-unkou-navi-config)';

const PORTS = {
  奄美大島: '名瀬港',
  喜界島: '湾港',
  徳之島: '亀徳港',
  沖永良部島: '和泊港',
};

const ARRIVAL_TIMES = {
  奄美大島: '06:00頃',
  徳之島: '12:00頃',
  沖永良部島: '16:00頃',
  喜界島: '18:00頃',
};

function asciiDigits(value) {
  return value.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day))
    .toISOString()
    .slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function tokyoDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
  };
}

function dateRange(from, days) {
  const { year, month, day } = tokyoDateParts(from);
  const start = new Date(Date.UTC(year, month - 1, day));
  return Array.from({ length: days }, (_, index) => addDays(start, index));
}

function scheduledArrival({
  operatorName,
  vessel,
  routeName,
  island,
  port,
  date,
  time,
  officialUrl,
  mode = 'cargo',
}) {
  return {
    label: `${vessel ?? operatorName} ${port} 入港（予定）`,
    time,
    date,
    status: 'unknown',
    note: '公式時刻表・配船表に基づく予定です。実際の運航状況は公式サイトでご確認ください。',
    direction: 'arrival',
    islands: [island],
    arrivalLocation: port,
    isScheduled: true,
    vessel: vessel ?? null,
    routeName,
    officialUrl,
    mode,
  };
}

function operatorResult({
  id,
  operatorName,
  routeName,
  mode = 'cargo',
  officialUrl,
  departures,
}) {
  return {
    id,
    operatorName,
    routeName,
    mode,
    status: 'unknown',
    note: '公式時刻表・配船表に基づく入港予定です。',
    officialUrl,
    departures: departures.sort((a, b) =>
      `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
    ),
  };
}

export function parseKyodoScheduleItems(items) {
  const title = asciiDigits(items.map((item) => item.text).join(' '));
  const titleMatch = title.match(/(\d{4})年\s*(\d{1,2})月/);
  if (!titleMatch) {
    throw new Error('共同組海運の配船表から年月を特定できません');
  }
  const year = Number(titleMatch[1]);
  const month = Number(titleMatch[2]);

  const headers = items
    .filter((item) => /^\d{1,2}$/.test(asciiDigits(item.text.trim())))
    .map((item) => ({ ...item, day: Number(asciiDigits(item.text.trim())) }))
    .filter(
      (item) =>
        (item.y > 490 && item.y < 525) ||
        (item.y > 300 && item.y < 330),
    );
  const vesselItems = items.filter(
    (item) =>
      /^(?:Ｔ|T|MⅡ|Ｍ\s*Ⅱ)$/.test(item.text.trim()) &&
      ((item.y > 335 && item.y < 365) ||
        (item.y > 145 && item.y < 175)),
  );

  const destinations = [];
  for (const item of items) {
    let island;
    if (item.text.trim() === '徳之島') island = '徳之島';
    if (item.text.trim() === '沖永良部') island = '沖永良部島';
    if (item.text.trim() === '喜界島') island = '喜界島';
    if (
      item.text.trim() === '奄' &&
      items.some(
        (other) =>
          other.text.trim() === '美' &&
          Math.abs(other.y - item.y) < 1 &&
          other.x > item.x &&
          other.x - item.x < 30,
      )
    ) {
      island = '奄美大島';
    }
    if (!island) continue;
    const isTop = item.y > 330;
    const panelHeaders = headers.filter((header) =>
      isTop ? header.y > 490 : header.y < 330,
    );
    const header = panelHeaders.reduce(
      (nearest, candidate) =>
        !nearest ||
        Math.abs(candidate.x - item.x) < Math.abs(nearest.x - item.x)
          ? candidate
          : nearest,
      null,
    );
    if (!header || Math.abs(header.x - item.x) > 22) continue;
    const panelVessels = vesselItems.filter((vessel) =>
      isTop ? vessel.y > 330 : vessel.y < 200,
    );
    const vesselItem = panelVessels.reduce(
      (nearest, candidate) =>
        !nearest ||
        Math.abs(candidate.x - header.x) < Math.abs(nearest.x - header.x)
          ? candidate
          : nearest,
      null,
    );
    if (!vesselItem || Math.abs(vesselItem.x - header.x) > 22) continue;
    const vessel = /M|Ｍ/.test(vesselItem.text) ? 'みさきⅡ' : 'つばさ';
    destinations.push({ island, day: header.day, vessel });
  }

  const seen = new Set();
  const departures = destinations
    .filter(({ island, day, vessel }) => {
      const key = `${island}-${day}-${vessel}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ island, day, vessel }) =>
      scheduledArrival({
        operatorName: '共同組海運',
        vessel,
        routeName: '鹿児島谷山港〜奄美群島',
        island,
        port: PORTS[island],
        date: isoDate(year, month, day + 1),
        time: ARRIVAL_TIMES[island],
        officialUrl: 'https://www.kyoudougumikaiun.co.jp/',
      }),
    );

  return operatorResult({
    id: 'kyodo_cargo',
    operatorName: '共同組海運',
    routeName: 'みさきⅡ・つばさ／鹿児島谷山港〜奄美群島',
    officialUrl: 'https://www.kyoudougumikaiun.co.jp/',
    departures,
  });
}

export function buildKaniyakuCargoSchedule(
  officialText,
  { from = new Date(), days = 14 } = {},
) {
  const text = officialText.replace(/\s+/g, '');
  const required = [
    '毎週月曜日',
    '毎週火曜日',
    '毎週木曜日',
    '毎週金曜日',
    '古仁屋・火曜日夕方',
    '古仁屋・金曜日夕方',
    '徳之島・水曜日',
    '沖永良部・日曜日',
  ];
  if (!required.every((marker) => text.includes(marker))) {
    throw new Error('鹿児島荷役の公式週間ダイヤを確認できません');
  }
  const tuesdayTime = text.match(
    /名瀬港毎週火曜日入港(\d{1,2}:\d{2})/,
  )?.[1];
  const fridayTime = text.match(
    /名瀬港毎週金曜日入港(\d{1,2}:\d{2})/,
  )?.[1];
  if (!tuesdayTime || !fridayTime) {
    throw new Error('鹿児島荷役の名瀬港入港時刻を確認できません');
  }

  const departures = [];
  for (const date of dateRange(from, days)) {
    const day = date.getUTCDay();
    const iso = date.toISOString().slice(0, 10);
    if (day === 2 || day === 5) {
      departures.push(
        scheduledArrival({
          operatorName: '鹿児島荷役海陸運輸',
          routeName: '鹿児島谷山港〜奄美',
          island: '奄美大島',
          port: '名瀬港',
          date: iso,
          time: day === 2 ? tuesdayTime : fridayTime,
          officialUrl: 'https://www.kaniyaku.co.jp/passage/',
        }),
      );
      departures.push(
        scheduledArrival({
          operatorName: '鹿児島荷役海陸運輸',
          routeName: '鹿児島谷山港〜奄美',
          island: '奄美大島',
          port: '古仁屋港',
          date: iso,
          time: '時刻未公表',
          officialUrl: 'https://www.kaniyaku.co.jp/passage/',
        }),
      );
    }
    if (day === 3) {
      departures.push(
        scheduledArrival({
          operatorName: '鹿児島荷役海陸運輸',
          routeName: '鹿児島谷山港〜奄美',
          island: '徳之島',
          port: '亀徳港',
          date: iso,
          time: '時刻未公表',
          officialUrl: 'https://www.kaniyaku.co.jp/passage/',
        }),
      );
    }
    if (day === 0) {
      departures.push(
        scheduledArrival({
          operatorName: '鹿児島荷役海陸運輸',
          routeName: '鹿児島谷山港〜奄美',
          island: '沖永良部島',
          port: '和泊港',
          date: iso,
          time: '時刻未公表',
          officialUrl: 'https://www.kaniyaku.co.jp/passage/',
        }),
      );
    }
  }

  return operatorResult({
    id: 'kaniyaku_cargo',
    operatorName: '鹿児島荷役海陸運輸',
    routeName: '貨物船／鹿児島谷山港〜奄美',
    officialUrl: 'https://www.kaniyaku.co.jp/passage/',
    departures,
  });
}

export function buildAmamiKaiunSchedule(
  pdfText,
  { from = new Date(), days = 14 } = {},
) {
  const text = asciiDigits(pdfText)
    .replace(/[⽉月]/g, '月')
    .replace(/[⽔水]/g, '水')
    .replace(/[⾦金]/g, '金')
    .replace(/[⽕火]/g, '火')
    .replace(/[⽊木]/g, '木')
    .replace(/[⼟土]/g, '土')
    .replace(/[⿅鹿]/g, '鹿')
    .replace(/[⼊入]/g, '入')
    .replace(/[：:]/g, ':')
    .replace(/\s+/g, '');
  const required = [
    'フェリーきかい週3便運航スケジュール',
    '月・水・金',
    '火・木・土',
    '喜界',
    '名瀬',
    '古仁屋',
    '平土野',
    '04:30',
    '07:00',
    '09:40',
    '12:20',
  ];
  if (!required.every((marker) => text.includes(marker))) {
    throw new Error('奄美海運の週3便ダイヤを確認できません');
  }

  const ports = [
    ['喜界島', '湾港', '04:30'],
    ['奄美大島', '名瀬港', '07:00'],
    ['奄美大島', '古仁屋港', '09:40'],
    ['徳之島', '平土野港', '12:20'],
  ];
  const departures = [];
  for (const date of dateRange(from, days)) {
    if (![2, 4, 6].includes(date.getUTCDay())) continue;
    const iso = date.toISOString().slice(0, 10);
    for (const [island, port, time] of ports) {
      departures.push(
        scheduledArrival({
          operatorName: '奄美海運',
          vessel: 'フェリーきかい',
          routeName: '鹿児島〜喜界〜名瀬〜古仁屋〜平土野',
          island,
          port,
          date: iso,
          time,
          officialUrl: 'https://www.aline-ferry.com/amami/time/',
          mode: 'ferry',
        }),
      );
    }
  }

  return operatorResult({
    id: 'amami_kaiun_freight_ferry',
    operatorName: '奄美海運（貨物取扱あり）',
    routeName: 'フェリーきかい／鹿児島〜喜界〜奄美〜徳之島',
    mode: 'ferry',
    officialUrl: 'https://www.aline-ferry.com/amami/time/',
    departures,
  });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

async function fetchPdfItems(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  const document = await getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      items.push({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
      });
    }
  }
  return items;
}

export function resolvePdfLink(html, linkText, baseUrl) {
  const $ = load(html);
  const href = $('a')
    .toArray()
    .map((element) => ({
      href: $(element).attr('href'),
      text: asciiDigits($(element).text()).replace(/\s+/g, ''),
    }))
    .find(
      (link) =>
        link.href?.toLowerCase().includes('.pdf') &&
        linkText.test(link.text),
    )?.href;
  if (!href) throw new Error('公式ページから配船表PDFを特定できません');
  return new URL(href, baseUrl).href;
}

export function requireAllSupplySources(settled) {
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed) {
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error(String(failed.reason));
  }
  return settled.map((result) => result.value);
}

export async function scrapeAdditionalSupplyServices() {
  const tasks = [
    (async () => {
      const baseUrl = 'https://www.kyoudougumikaiun.co.jp/';
      const html = await fetchText(baseUrl);
      const url = resolvePdfLink(html, /配船予定表/, baseUrl);
      return parseKyodoScheduleItems(await fetchPdfItems(url));
    })(),
    (async () => {
      const html = await fetchText('https://www.kaniyaku.co.jp/passage/');
      return buildKaniyakuCargoSchedule(load(html).text());
    })(),
    (async () => {
      const baseUrl = 'https://www.aline-ferry.com/amami/time/';
      const html = await fetchText(baseUrl);
      const url = resolvePdfLink(
        html,
        /週3便スケジュール（ヨコ）/,
        baseUrl,
      );
      const items = await fetchPdfItems(url);
      return buildAmamiKaiunSchedule(
        items.map((item) => item.text).join(' '),
      );
    })(),
  ];

  const settled = await Promise.allSettled(tasks);
  return requireAllSupplySources(settled);
}
