import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAmamiKaiunSchedule,
  buildKaniyakuCargoSchedule,
  parseKyodoScheduleItems,
  requireAllSupplySources,
  resolvePdfLink,
} from './cargo_schedule.mjs';

test('共同組海運PDFの列と行から島・船名・翌日の入港予定を復元する', () => {
  const items = [
    { text: '2026年 ９月 運航予定表', x: 306.2, y: 556.7 },
    { text: '1', x: 150.1, y: 512.4 },
    { text: '2', x: 193.0, y: 512.4 },
    { text: '奄', x: 134.8, y: 472.9 },
    { text: '美', x: 157.9, y: 472.9 },
    { text: '徳之島', x: 134.5, y: 441.8 },
    { text: '喜界島', x: 134.5, y: 378.5 },
    { text: 'Ｔ', x: 146.9, y: 349.8 },
    { text: '奄', x: 177.6, y: 472.9 },
    { text: '美', x: 200.8, y: 472.9 },
    { text: '沖永良部', x: 177.4, y: 411.2 },
    { text: 'MⅡ', x: 185.3, y: 349.8 },
  ];

  const result = parseKyodoScheduleItems(items);

  assert.deepEqual(
    result.departures.map((entry) => ({
      date: entry.date,
      time: entry.time,
      island: entry.islands[0],
      vessel: entry.vessel,
    })),
    [
      { date: '2026-09-02', time: '06:00頃', island: '奄美大島', vessel: 'つばさ' },
      { date: '2026-09-02', time: '12:00頃', island: '徳之島', vessel: 'つばさ' },
      { date: '2026-09-02', time: '18:00頃', island: '喜界島', vessel: 'つばさ' },
      { date: '2026-09-03', time: '06:00頃', island: '奄美大島', vessel: 'みさきⅡ' },
      { date: '2026-09-03', time: '16:00頃', island: '沖永良部島', vessel: 'みさきⅡ' },
    ],
  );
});

test('鹿児島荷役は時刻未公表の島を推測せず日付だけで案内する', () => {
  const officialText = `
    鹿児島↔︎奄美
    谷山港 毎週月曜日 出港 17:00
    名瀬港 毎週火曜日 入港 10:30
    古仁屋・火曜日夕方 徳之島・水曜日
    谷山港 毎週木曜日 出港 17:00
    名瀬港 毎週金曜日 入港 10:45
    古仁屋・金曜日夕方 沖永良部・日曜日
  `;

  const result = buildKaniyakuCargoSchedule(officialText, {
    from: new Date('2026-09-10T00:00:00+09:00'),
    days: 8,
  });

  assert.deepEqual(
    result.departures.map((entry) => ({
      date: entry.date,
      time: entry.time,
      island: entry.islands[0],
    })),
    [
      { date: '2026-09-11', time: '10:45', island: '奄美大島' },
      { date: '2026-09-11', time: '時刻未公表', island: '奄美大島' },
      { date: '2026-09-13', time: '時刻未公表', island: '沖永良部島' },
      { date: '2026-09-15', time: '10:30', island: '奄美大島' },
      { date: '2026-09-15', time: '時刻未公表', island: '奄美大島' },
      { date: '2026-09-16', time: '時刻未公表', island: '徳之島' },
    ],
  );
});

test('奄美海運の現行週3便から下り便・上り便の全寄港地の入出港を作る', () => {
  const pdfText =
    '平土野行き 月・水・金 鹿児島 喜 界 名 瀬 古仁屋 平土野 ' +
    '04 ： 30 入港 07 ： 00 入港 09 ： 40 入港 ' +
    'フェリーきかい週 3 便運航スケジュール 12 ： 20 入港 火・木・土 ' +
    '鹿児島行 火・木・土 水・金・日 平土野 古仁屋 名 瀬 喜 界 鹿児島 ' +
    '12 ： 50 出港 15 ： 10 入港 15 ： 30 出港 ' +
    '17 ： 50 入港 18 ： 20 出港 20 ： 30 入港 21 ： 00 出港 08 ： 30 入港';

  const result = buildAmamiKaiunSchedule(pdfText, {
    from: new Date('2026-09-10T00:00:00+09:00'),
    days: 2,
  });

  // 2026-09-10（木）が基準日。下り便は前日（09-09水）鹿児島発、
  // 上り便は翌日（09-11金）鹿児島着で、いずれも「下り便」「上り便」の
  // ラベル接頭辞と区間の出発地・到着地が付与されている。
  assert.deepEqual(
    result.departures.map((entry) => ({
      date: entry.date,
      time: entry.time,
      label: entry.label,
      island: entry.islands[0],
      departureLocation: entry.departureLocation,
      arrivalLocation: entry.arrivalLocation,
    })),
    [
      {
        date: '2026-09-09',
        time: '17:30',
        label: '下り便 フェリーきかい 鹿児島 出港（予定）',
        island: '喜界島',
        departureLocation: '鹿児島',
        arrivalLocation: '湾港',
      },
      {
        date: '2026-09-10',
        time: '04:30',
        label: '下り便 フェリーきかい 湾港 入港（予定）',
        island: '喜界島',
        departureLocation: '鹿児島',
        arrivalLocation: '湾港',
      },
      {
        date: '2026-09-10',
        time: '05:00',
        label: '下り便 フェリーきかい 湾港 出港（予定）',
        island: '喜界島',
        departureLocation: '湾港',
        arrivalLocation: '名瀬港',
      },
      {
        date: '2026-09-10',
        time: '07:00',
        label: '下り便 フェリーきかい 名瀬港 入港（予定）',
        island: '奄美大島',
        departureLocation: '湾港',
        arrivalLocation: '名瀬港',
      },
      {
        date: '2026-09-10',
        time: '07:30',
        label: '下り便 フェリーきかい 名瀬港 出港（予定）',
        island: '奄美大島',
        departureLocation: '名瀬港',
        arrivalLocation: '古仁屋港',
      },
      {
        date: '2026-09-10',
        time: '09:40',
        label: '下り便 フェリーきかい 古仁屋港 入港（予定）',
        island: '奄美大島',
        departureLocation: '名瀬港',
        arrivalLocation: '古仁屋港',
      },
      {
        date: '2026-09-10',
        time: '10:00',
        label: '下り便 フェリーきかい 古仁屋港 出港（予定）',
        island: '奄美大島',
        departureLocation: '古仁屋港',
        arrivalLocation: '平土野港',
      },
      {
        date: '2026-09-10',
        time: '12:20',
        label: '下り便 フェリーきかい 平土野港 入港（予定）',
        island: '徳之島',
        departureLocation: '古仁屋港',
        arrivalLocation: '平土野港',
      },
      {
        date: '2026-09-10',
        time: '12:50',
        label: '上り便 フェリーきかい 平土野港 出港（予定）',
        island: '徳之島',
        departureLocation: '平土野港',
        arrivalLocation: '古仁屋港',
      },
      {
        date: '2026-09-10',
        time: '15:10',
        label: '上り便 フェリーきかい 古仁屋港 入港（予定）',
        island: '奄美大島',
        departureLocation: '平土野港',
        arrivalLocation: '古仁屋港',
      },
      {
        date: '2026-09-10',
        time: '15:30',
        label: '上り便 フェリーきかい 古仁屋港 出港（予定）',
        island: '奄美大島',
        departureLocation: '古仁屋港',
        arrivalLocation: '名瀬港',
      },
      {
        date: '2026-09-10',
        time: '17:50',
        label: '上り便 フェリーきかい 名瀬港 入港（予定）',
        island: '奄美大島',
        departureLocation: '古仁屋港',
        arrivalLocation: '名瀬港',
      },
      {
        date: '2026-09-10',
        time: '18:20',
        label: '上り便 フェリーきかい 名瀬港 出港（予定）',
        island: '奄美大島',
        departureLocation: '名瀬港',
        arrivalLocation: '湾港',
      },
      {
        date: '2026-09-10',
        time: '20:30',
        label: '上り便 フェリーきかい 湾港 入港（予定）',
        island: '喜界島',
        departureLocation: '名瀬港',
        arrivalLocation: '湾港',
      },
      {
        date: '2026-09-10',
        time: '21:00',
        label: '上り便 フェリーきかい 湾港 出港（予定）',
        island: '喜界島',
        departureLocation: '湾港',
        arrivalLocation: '鹿児島',
      },
      {
        date: '2026-09-11',
        time: '08:30',
        label: '上り便 フェリーきかい 鹿児島 入港（予定）',
        island: '喜界島',
        departureLocation: '湾港',
        arrivalLocation: '鹿児島',
      },
    ],
  );
});

test('公式ページの相対URLと全角数字を正規化してPDFリンクを返す', () => {
  const html = `
    <a href="/library/current.pdf">9月配船予定表</a>
    <a href="/schedule/amami.pdf">「フェリーきかい」週３便スケジュール（ヨコ）</a>
  `;

  assert.equal(
    resolvePdfLink(
      html,
      /週3便スケジュール（ヨコ）/,
      'https://example.com/amami/time/',
    ),
    'https://example.com/schedule/amami.pdf',
  );
});

test('一社でも取得失敗した場合は不完全なJSON更新を許可しない', () => {
  assert.throws(
    () =>
      requireAllSupplySources([
        { status: 'fulfilled', value: { id: 'kyodo_cargo' } },
        { status: 'rejected', reason: new Error('official PDF unavailable') },
      ]),
    /official PDF unavailable/,
  );
});
