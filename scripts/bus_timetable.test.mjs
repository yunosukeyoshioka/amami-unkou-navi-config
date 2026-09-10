import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBusRoute } from './bus_timetable.mjs';

function group(route, id) {
  const found = route.groups.find((g) => g.id === id);
  assert.ok(found, `group ${id} が見つかりません`);
  return found;
}

function findTrip(group, firstName, firstTime) {
  return group.trips.find((t) => t.stops[0]?.name === firstName && t.stops[0]?.time === firstTime);
}

function tripStops(group, firstName, firstTime) {
  const trip = findTrip(group, firstName, firstTime);
  assert.ok(trip, `${firstName} ${firstTime} 発の便が見つかりません`);
  return trip.stops.map((s) => [s.name, s.time]);
}

function minutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

test('古仁屋・住用線を外部リンクではなく時刻付き路線として生成する', async () => {
  const route = await buildBusRoute('koniya_sumiyo_line');

  assert.equal(route.parsed, true);
  assert.equal(route.revisionDate, '2025-04-01');
  assert.deepEqual(route.groups.map((group) => group.label), ['平日', '土日祝']);
  assert.equal(route.groups[0].trips.length, 18);
  assert.equal(route.groups[1].trips.length, 16);
  assert.deepEqual(route.groups[0].trips[0].stops[0], {
    name: 'こしゅく第1公園',
    time: '6:10',
  });
});

test('宇検線を運行日区分付きの時刻表として生成する', async () => {
  const route = await buildBusRoute('toguchi_uken_line');

  assert.equal(route.parsed, true);
  assert.equal(route.revisionDate, '2025-10-01');
  assert.deepEqual(route.groups.map((group) => group.label), ['平日', '土日祝']);
  assert.ok(route.groups.every((group) => group.trips.length > 0));
});

test('佐仁線をPDFの文字情報から時刻付き路線として生成する', async () => {
  const route = await buildBusRoute('sani_line');

  assert.equal(route.parsed, true);
  assert.equal(route.revisionDate, '2025-10-01');
  assert.deepEqual(route.groups.map((group) => group.label), ['平日', '土日祝']);
  assert.ok(route.groups.every((group) => group.trips.length > 0));
});

test('喜界島は運休中の北中央線18時発を除外して生成する', async () => {
  const route = await buildBusRoute('kikai_bus');

  assert.equal(route.parsed, true);
  assert.equal(route.revisionDate, '2026-06-01');
  assert.deepEqual(route.groups.map((group) => group.label), ['南中央線', '北中央線']);
  const north = route.groups.find((group) => group.id === 'north');
  assert.ok(north);
  assert.ok(north.trips.length > 0);
  assert.ok(north.trips.every((trip) => trip.stops[0]?.time !== '18:00'));
});

test('古仁屋線の停留所名と1便目の非停車を原本どおりに持つ', async () => {
  const route = await buildBusRoute('koniya_sumiyo_line');
  const weekday = group(route, 'weekday');

  const first = tripStops(weekday, 'こしゅく第1公園', '6:10');
  assert.deepEqual(first, [
    ['こしゅく第1公園', '6:10'],
    ['奄美中央病院前', '6:22'],
    ['名瀬合同庁舎前', '6:24'],
    ['塩浜入口', '6:25'],
    ['入舟町', '6:28'],
    ['しまバス本社前', '6:31'],
    ['大島高校前', '6:33'],
    ['奄美小学校前', '6:34'],
    ['県立大島病院前', '6:36'],
    ['三太郎の里', '6:56'],
    ['奄美市住用総合支所前', '7:04'],
    ['新村', '7:14'],
    ['阿木名', '7:31'],
    ['せとうち海の駅', '7:44'],
  ]);
  // 原本が「－」の1便目のマングローブパークを、時刻を推測して補わないこと。
  assert.ok(!first.some(([name]) => name === 'マングローブパーク'));

  // OCRで誤読していた停留所名が残っていないこと。
  const allNames = new Set(
    route.groups.flatMap((g) => g.trips.flatMap((t) => t.stops.map((s) => s.name))),
  );
  for (const wrong of ['名瀬郵便局前', '港町入口', '大熊漁協前', '鳩浜団地前', '奄美川商店前']) {
    assert.ok(!allNames.has(wrong), `誤った停留所名 ${wrong} が残っています`);
  }

  // 2便目以降はマングローブパークにも停車する。
  const second = tripStops(weekday, 'こしゅく第1公園', '7:34');
  assert.deepEqual(second.slice(9), [
    ['三太郎の里', '8:24'],
    ['奄美市住用総合支所前', '8:32'],
    ['マングローブパーク', '8:34'],
    ['新村', '8:44'],
    ['阿木名', '9:01'],
    ['せとうち海の駅', '9:14'],
  ]);

  const back = tripStops(weekday, 'せとうち海の駅', '6:40');
  assert.deepEqual(back[0], ['せとうち海の駅', '6:40']);
  assert.deepEqual(back.at(-1), ['こしゅく第1公園', '8:26']);
  assert.equal(back.length, 15);
});

test('住用町市線は平日のみの2便を全停留所つきで持つ', async () => {
  const route = await buildBusRoute('koniya_sumiyo_line');
  const weekday = group(route, 'weekday');
  const holiday = group(route, 'holiday');

  const outbound = tripStops(weekday, '浦上奥万田', '18:00');
  assert.deepEqual(outbound, [
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
  ]);

  const inbound = tripStops(weekday, '住用町市', '6:25');
  assert.deepEqual(inbound, [
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
  ]);
  // 原本で前後の時刻と矛盾する7:29は推測せず省く。
  assert.ok(!inbound.some(([name]) => name === '奄美市役所前'));

  // 平日のみ運行なので、土日祝には現れない。
  assert.equal(findTrip(holiday, '浦上奥万田', '18:00'), undefined);
  assert.equal(findTrip(holiday, '住用町市', '6:25'), undefined);
});

test('宇検線は4つの表の全便を途中停留所つきで持つ', async () => {
  const route = await buildBusRoute('toguchi_uken_line');
  const weekday = group(route, 'weekday');
  const holiday = group(route, 'holiday');

  assert.equal(weekday.trips.length, 28);
  assert.equal(holiday.trips.length, 21);

  // 始発と終着しか無い不完全な便を作らない。奄美空港との直行便のみ2停留所。
  for (const g of route.groups) {
    for (const trip of g.trips) {
      const names = trip.stops.map((s) => s.name);
      if (trip.stops.length < 3) {
        assert.ok(
          names.includes('奄美空港'),
          `途中停留所の無い便: ${g.id} ${names.join('→')}`,
        );
      }
      assert.ok(trip.stops.length >= 2);
    }
  }
  const allTrips = route.groups.flatMap((g) => g.trips);
  const airportShuttles = allTrips.filter((t) => t.stops.length === 2);
  assert.equal(allTrips.length, 49);
  assert.equal(airportShuttles.length, 11);
  assert.ok(allTrips.filter((t) => t.stops.length > 2).every((t) => t.stops.length >= 4));

  // 宇検 → 名瀬市街地方面（ケンムンの館は原本の注記により時刻なし）。
  assert.deepEqual(tripStops(weekday, '宇検', '6:15'), [
    ['宇検', '6:15'],
    ['久志', '6:19'],
    ['生勝', '6:22'],
    ['芦検住宅前', '6:32'],
    ['芦検', '6:33'],
    ['田検', '6:39'],
    ['湯湾', '6:41'],
    ['石良', '6:46'],
    ['新村', '7:11'],
  ]);
  assert.deepEqual(tripStops(holiday, '宇検', '6:15').at(-1), ['新村', '7:11']);
  assert.deepEqual(tripStops(weekday, '新村', '7:16'), [
    ['新村', '7:16'],
    ['マングローブパーク', '7:26'],
    ['県立大島病院前', '7:56'],
    ['奄美小学校前', '7:58'],
    ['大島高等学校前', '7:59'],
    ['しまバス本社前', '8:04'],
    ['ウエストコート前', '8:09'],
    ['名瀬合同庁舎前', '8:12'],
    ['奄美中央病院前', '8:14'],
    ['こしゅく第1公園', '8:26'],
  ]);
  assert.deepEqual(tripStops(weekday, 'しまバス本社前', '8:37'), [
    ['しまバス本社前', '8:37'],
    ['奄美空港', '9:34'],
  ]);

  // 名瀬市街地 → 宇検方面（1便目のマングローブパークは原本が「－」）。
  const toUken = tripStops(weekday, 'こしゅく第1公園', '6:10');
  assert.deepEqual(toUken.at(-1), ['新村', '7:14']);
  assert.ok(!toUken.some(([name]) => name === 'マングローブパーク'));
  assert.deepEqual(tripStops(weekday, '新村', '7:21'), [
    ['新村', '7:21'],
    ['石良', '7:46'],
    ['ケンムンの館', '7:50'],
    ['湯湾', '7:53'],
    ['田検', '7:55'],
    ['芦検', '8:01'],
    ['芦検住宅前', '8:02'],
    ['生勝', '8:12'],
    ['久志', '8:15'],
    ['宇検', '8:19'],
  ]);

  // 宇検 → 古仁屋方面、古仁屋 → 宇検方面。
  assert.deepEqual(tripStops(weekday, '新村', '7:14'), [
    ['新村', '7:14'],
    ['勝浦', '7:28'],
    ['阿木名', '7:31'],
    ['ひかり幼稚園前', '7:37'],
    ['古仁屋港前', '7:39'],
    ['瀬戸内合同庁舎前', '7:41'],
    ['古仁屋郵便局前', '7:42'],
    ['せとうち海の駅', '7:44'],
  ]);
  assert.deepEqual(tripStops(holiday, 'せとうち海の駅', '6:40'), [
    ['せとうち海の駅', '6:40'],
    ['古仁屋郵便局前', '6:42'],
    ['瀬戸内合同庁舎前', '6:43'],
    ['古仁屋港前', '6:45'],
    ['ひかり幼稚園前', '6:47'],
    ['阿木名', '6:53'],
    ['勝浦', '6:57'],
    ['新村', '7:11'],
  ]);

  // 夕方の便は「平日のみ運行」、15:42発は「平日運休・土日祝のみ運行」。
  assert.ok(findTrip(weekday, '湯湾', '17:01'));
  assert.equal(findTrip(holiday, '湯湾', '17:01'), undefined);
  assert.ok(findTrip(holiday, 'せとうち海の駅', '15:42'));
  assert.equal(findTrip(weekday, 'せとうち海の駅', '15:42'), undefined);
  assert.deepEqual(tripStops(weekday, '新村', '14:50').at(-1), ['湯湾', '15:22']);
});

test('佐仁線・喜界島の解析結果に壊れた便が無い', async () => {
  for (const id of ['sani_line', 'kikai_bus']) {
    const route = await buildBusRoute(id);
    for (const g of route.groups) {
      assert.ok(g.trips.length > 0, `${id} ${g.id} に便がありません`);
      for (const trip of g.trips) {
        assert.ok(trip.stops.length >= 3, `${id} ${g.id} に停留所2つ以下の便があります`);
        for (const stop of trip.stops) {
          assert.match(stop.time, /^\d{1,2}:\d{2}$/);
          assert.ok(stop.name && stop.name.trim() !== '', `${id} に空の停留所名があります`);
          assert.doesNotMatch(stop.name, /\d/, `${id} の停留所名に数字が混入: ${stop.name}`);
        }
        // 1便が停留所を巡る時刻は単調非減少でなければならない。
        const times = trip.stops.map((s) => minutes(s.time));
        assert.deepEqual(times, [...times].sort((a, b) => a - b), `${id} の時刻順が不正です`);
      }
    }
  }
});

test('佐仁線は平日と土日祝を見出しどおりに振り分ける', async () => {
  const route = await buildBusRoute('sani_line');

  assert.equal(group(route, 'weekday').trips.length, 11);
  assert.equal(group(route, 'holiday').trips.length, 1);
  // 同じ便が両区分に二重登録されていないこと。
  const weekdayKeys = group(route, 'weekday').trips.map((t) => `${t.stops[0].name}${t.stops[0].time}`);
  const holidayKeys = group(route, 'holiday').trips.map((t) => `${t.stops[0].name}${t.stops[0].time}`);
  assert.equal(holidayKeys.filter((k) => weekdayKeys.includes(k)).length, 0);
});

test('喜界島は南北それぞれの全便を循環全区間つきで持つ', async () => {
  const route = await buildBusRoute('kikai_bus');
  const south = group(route, 'south');
  const north = group(route, 'north');

  assert.equal(south.trips.length, 6);
  assert.equal(north.trips.length, 5);
  assert.deepEqual(south.trips.map((t) => t.stops[0].time), ['7:00', '8:40', '10:30', '12:00', '14:30', '16:50']);
  assert.deepEqual(north.trips.map((t) => t.stops[0].time), ['7:20', '9:50', '11:00', '13:30', '15:20']);
  for (const g of [south, north]) {
    for (const trip of g.trips) {
      assert.equal(trip.stops[0].name, '旧湾営業所');
      assert.ok(trip.stops.length >= 40, `喜界島の便の停留所数が少なすぎます: ${trip.stops.length}`);
    }
  }
});

test('空港線を外部リンクではなく時刻付き路線として生成する', async () => {
  const route = await buildBusRoute('airport_line');

  assert.equal(route.parsed, true);
  assert.equal(route.revisionDate, '2025-04-01');
  assert.deepEqual(route.groups.map((g) => g.label), ['平日', '土日祝']);
  assert.ok(group(route, 'weekday').trips.length > 10);
  assert.ok(group(route, 'holiday').trips.length > 10);
});

test('空港線の市街地→空港の朝便を原本どおりに持つ', async () => {
  const weekday = group(await buildBusRoute('airport_line'), 'weekday');
  const holiday = group(await buildBusRoute('airport_line'), 'holiday');

  const first = tripStops(weekday, '平田町奥又', '6:30');
  assert.deepEqual(first.slice(0, 5), [
    ['平田町奥又', '6:30'],
    ['県立大島病院前', '6:32'],
    ['奄美小学校前', '6:34'],
    ['大島高等学校前', '6:35'],
    ['永田橋', '6:36'],
  ]);
  assert.ok(!first.some(([name]) => name === 'こしゅく第1公園'));
  assert.deepEqual(first.at(-1), ['奄美空港', '7:47']);
  assert.equal(findTrip(holiday, '平田町奥又', '6:30'), undefined);

  const daily = tripStops(weekday, 'こしゅく第1公園', '6:39');
  assert.deepEqual(daily[0], ['こしゅく第1公園', '6:39']);
  assert.deepEqual(daily.at(-1), ['奄美空港', '7:57']);
  assert.ok(findTrip(holiday, 'こしゅく第1公園', '6:39'));

  const midMorning = tripStops(weekday, 'こしゅく第1公園', '9:16');
  assert.deepEqual(
    midMorning.filter(([name]) => ['土浜', '奄美パーク', '奄美空港', '赤木名外金久'].includes(name)),
    [
      ['土浜', '10:27'],
      ['奄美パーク', '10:31'],
      ['奄美空港', '10:36'],
      ['赤木名外金久', '10:48'],
    ],
  );
});

test('空港線の空港→市街地の朝便を原本どおりに持つ', async () => {
  const weekday = group(await buildBusRoute('airport_line'), 'weekday');
  const holiday = group(await buildBusRoute('airport_line'), 'holiday');

  const sani = tripStops(weekday, '佐仁', '6:19');
  assert.deepEqual(sani[0], ['佐仁', '6:19']);
  assert.deepEqual(sani.at(-1), ['真名津町', '7:34']);
  assert.ok(!sani.some(([name]) => name === '平田町奥又'));
  assert.equal(findTrip(holiday, '佐仁', '6:19'), undefined);

  const daily = tripStops(weekday, '佐仁', '6:23');
  assert.deepEqual(daily.at(-1), ['平田町奥又', '8:05']);
  assert.ok(findTrip(holiday, '佐仁', '6:23'));
});

test('固定転記した便の時刻が停留所順に逆行しない', async () => {
  for (const routeId of ['koniya_sumiyo_line', 'toguchi_uken_line', 'airport_line']) {
    const route = await buildBusRoute(routeId);
    for (const timetableGroup of route.groups) {
      for (const busTrip of timetableGroup.trips) {
        const times = busTrip.stops.map((stop) => minutes(stop.time));
        assert.deepEqual(
          times,
          [...times].sort((a, b) => a - b),
          `${routeId} ${busTrip.stops[0]?.name} ${busTrip.stops[0]?.time} の時刻順が不正です`,
        );
      }
    }
  }
});
