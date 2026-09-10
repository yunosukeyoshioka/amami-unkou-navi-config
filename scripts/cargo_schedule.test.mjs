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

test('奄美海運の現行週3便から喜界・奄美・徳之島の次回入港を作る', () => {
  const pdfText =
    '平土野行き 月・水・金 鹿児島 喜 界 名 瀬 古仁屋 平土野 ' +
    '04 ： 30 入港 07 ： 00 入港 09 ： 40 入港 ' +
    'フェリーきかい週 3 便運航スケジュール 12 ： 20 入港 火・木・土';

  const result = buildAmamiKaiunSchedule(pdfText, {
    from: new Date('2026-09-10T00:00:00+09:00'),
    days: 4,
  });

  assert.deepEqual(
    result.departures.map((entry) => ({
      date: entry.date,
      time: entry.time,
      island: entry.islands[0],
      port: entry.arrivalLocation,
    })),
    [
      { date: '2026-09-10', time: '04:30', island: '喜界島', port: '湾港' },
      { date: '2026-09-10', time: '07:00', island: '奄美大島', port: '名瀬港' },
      { date: '2026-09-10', time: '09:40', island: '奄美大島', port: '古仁屋港' },
      { date: '2026-09-10', time: '12:20', island: '徳之島', port: '平土野港' },
      { date: '2026-09-12', time: '04:30', island: '喜界島', port: '湾港' },
      { date: '2026-09-12', time: '07:00', island: '奄美大島', port: '名瀬港' },
      { date: '2026-09-12', time: '09:40', island: '奄美大島', port: '古仁屋港' },
      { date: '2026-09-12', time: '12:20', island: '徳之島', port: '平土野港' },
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
