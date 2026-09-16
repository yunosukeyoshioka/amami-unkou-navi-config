import test from 'node:test';
import assert from 'node:assert/strict';

import { parseKagoshimaAirportHtml } from './airport_kagoshima.mjs';

function tableHtml(rows) {
  const trs = rows
    .map(
      ({ flightNo, place, time, time2 = '', biko = '' }) => `
        <tr class="flighted">
          <td class="f_airline"><img alt="JAL"></td>
          <td class="f_no">${flightNo}</td>
          <td class="f_place">${place}</td>
          <td class="f_time">${time}</td>
          <td class="f_time2">${time2}</td>
          <td class="f_biko">${biko}</td>
        </tr>`,
    )
    .join('');
  return `
    <table id="flightList_dep">
      <thead><tr class="listheader"><th class="f_place">行先</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>`;
}

test('鹿児島空港の出発便テーブルから奄美群島4島行きの便だけを抽出する', () => {
  const html = tableHtml([
    { flightNo: '3801', place: '沖永良部', time: '07:20', biko: '出発済み' },
    { flightNo: '542', place: '大阪', time: '07:25', biko: '出発済み' }, // 奄美群島外は除外
    { flightNo: '3783', place: '喜界島', time: '07:35', time2: '08:20', biko: '出発済み' },
  ]);

  const entries = parseKagoshimaAirportHtml(html, 'departure');

  assert.deepEqual(
    entries.map((e) => ({
      label: e.label,
      time: e.time,
      islands: e.islands,
      departureLocation: e.departureLocation,
      arrivalLocation: e.arrivalLocation,
      status: e.status,
    })),
    [
      {
        label: '3801便 沖永良部行き',
        time: '07:20',
        islands: ['沖永良部島'],
        departureLocation: '鹿児島空港',
        arrivalLocation: '沖永良部空港',
        status: 'normal',
      },
      {
        label: '3783便 喜界島行き',
        time: '07:35',
        islands: ['喜界島'],
        departureLocation: '鹿児島空港',
        arrivalLocation: '喜界空港',
        status: 'delayed',
      },
    ],
  );
});

test('備考欄の欠航・見合わせキーワードでステータスを判定する', () => {
  const html = tableHtml([
    { flightNo: '3791', place: '徳之島', time: '07:50', biko: '欠航' },
    { flightNo: '3825', place: '与論', time: '11:10', biko: '見合わせ' },
  ]);

  const entries = parseKagoshimaAirportHtml(html, 'departure');

  assert.deepEqual(entries.map((e) => e.status), ['cancelled', 'suspended']);
});

test('到着便では出発地・到着地が逆になる', () => {
  const html = tableHtml([{ flightNo: '3792', place: '徳之島', time: '11:20', biko: '到着済み' }]);

  const entries = parseKagoshimaAirportHtml(html, 'arrival');

  assert.deepEqual(
    entries.map((e) => ({
      label: e.label,
      direction: e.direction,
      departureLocation: e.departureLocation,
      arrivalLocation: e.arrivalLocation,
    })),
    [
      {
        label: '3792便 徳之島発',
        direction: 'arrival',
        departureLocation: '徳之島空港',
        arrivalLocation: '鹿児島空港',
      },
    ],
  );
});
