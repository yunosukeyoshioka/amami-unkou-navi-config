import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNahaAirportJson } from './airport_naha.mjs';

test('那覇空港JSONから沖永良部・与論行きの便だけを本日分に絞って抽出する', () => {
  const rows = [
    ['JL', '3715', '沖永良部', 'OKINOERABU', '20260915143500', '', '20260915143300', '出発済', 'DEPARTED', '28C', 'D', '', '0', '', '', '', '', '', ''],
    ['JL', '3715', '沖永良部', 'OKINOERABU', '20260916143500', '', '', '欠航', 'CANCELLED', '28B', 'D', '', '0', '', '', '', '', '', ''],
    ['BC', '0590', '神　戸', 'KOBE', '20260915060500', '', '20260915060200', '出発済', 'DEPARTED', '37', 'D', '', '0', '', '', '', '', '', ''],
    ['JL', '3716', '与　論', 'YORON', '20260915134500', '20260915134300', '20260915134600', '手荷物受取済', 'ARRIVED', '', 'A', '', '0', '', '', '', '', '', ''],
  ];

  const entries = parseNahaAirportJson(rows, { todayIso: '2026-09-15' });

  assert.deepEqual(
    entries.map((e) => ({
      label: e.label,
      time: e.time,
      direction: e.direction,
      islands: e.islands,
      status: e.status,
      departureLocation: e.departureLocation,
      arrivalLocation: e.arrivalLocation,
      date: e.date,
    })),
    [
      {
        label: '3715便 沖永良部行き',
        time: '14:35',
        direction: 'departure',
        islands: ['沖永良部島'],
        status: 'normal',
        departureLocation: '那覇空港',
        arrivalLocation: '沖永良部空港',
        date: '2026-09-15',
      },
      {
        label: '3716便 与論発',
        time: '13:45',
        direction: 'arrival',
        islands: ['与論島'],
        status: 'normal',
        departureLocation: '与論空港',
        arrivalLocation: '那覇空港',
        date: '2026-09-15',
      },
    ],
  );
});

test('欠航ステータスを判定する', () => {
  const rows = [
    ['JL', '3715', '沖永良部', 'OKINOERABU', '20260915143500', '', '', '欠航', 'CANCELLED', '28B', 'D', '', '0', '', '', '', '', '', ''],
  ];

  const entries = parseNahaAirportJson(rows, { todayIso: '2026-09-15' });

  assert.equal(entries[0].status, 'cancelled');
});

test('todayIsoと異なる日付の便は除外する', () => {
  const rows = [
    ['JL', '3715', '沖永良部', 'OKINOERABU', '20260917143500', '', '', '', '', '28B', 'D', '', '0', '', '', '', '', '', ''],
  ];

  const entries = parseNahaAirportJson(rows, { todayIso: '2026-09-15' });

  assert.equal(entries.length, 0);
});
