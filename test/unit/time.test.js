'use strict';

const { createTime, settingsFromConfig, zonedToInstant, wallParts, isZone } = require('../../src/lib/time');

const Z = (s) => Date.parse(s);
const H = 3600000;

// Europe/Berlin: clocks back 2026-10-25 03:00 CEST → 02:00 CET (01:00Z), forward 2027-03-28 02:00 CET → 03:00 CEST (01:00Z).
// America/New_York: back 2026-11-01 02:00 EDT → 01:00 EST (06:00Z), forward 2027-03-14 02:00 EST → 03:00 EDT (07:00Z).

function berlin(extra = {}) {
    return createTime({ timeZone: 'Europe/Berlin', ...extra });
}

describe('she.time: wall clock ↔ instant', () => {
    test('wallParts gives the zone wall clock with offset and weekday', () => {
        const p = wallParts('Europe/Berlin', Z('2026-10-25T00:41:12.345Z'));
        expect(p).toEqual({ year: 2026, month: 10, day: 25, hour: 2, minute: 41, second: 12, millisecond: 345, weekday: 0, offset: 120 });
        expect(wallParts('Europe/Berlin', Z('2026-10-25T01:41:00Z')).offset).toBe(60);
        expect(wallParts('America/New_York', Z('2026-11-01T06:30:00Z'))).toMatchObject({ hour: 1, minute: 30, offset: -300 });
        expect(wallParts('Asia/Kolkata', Z('2026-01-01T00:00:00Z'))).toMatchObject({ hour: 5, minute: 30, offset: 330 });
    });

    test('zonedToInstant: a plain time, a time in the gap (forward), an ambiguous time (first occurrence)', () => {
        expect(zonedToInstant('Europe/Berlin', 2026, 7, 1, 12)).toBe(Z('2026-07-01T10:00:00Z'));
        expect(zonedToInstant('Europe/Berlin', 2026, 12, 1, 12)).toBe(Z('2026-12-01T11:00:00Z'));
        // 02:30 does not exist on 2027-03-28 → 03:30 CEST
        expect(zonedToInstant('Europe/Berlin', 2027, 3, 28, 2, 30)).toBe(Z('2027-03-28T01:30:00Z'));
        // 02:30 exists twice on 2026-10-25 → the first (CEST)
        expect(zonedToInstant('Europe/Berlin', 2026, 10, 25, 2, 30)).toBe(Z('2026-10-25T00:30:00Z'));
        // 03:00 on the autumn day is unambiguous (CET)
        expect(zonedToInstant('Europe/Berlin', 2026, 10, 25, 3, 0)).toBe(Z('2026-10-25T02:00:00Z'));
        // New York: 02:30 on 2027-03-14 is in the gap → 03:30 EDT; 01:30 on 2026-11-01 twice → first (EDT)
        expect(zonedToInstant('America/New_York', 2027, 3, 14, 2, 30)).toBe(Z('2027-03-14T07:30:00Z'));
        expect(zonedToInstant('America/New_York', 2026, 11, 1, 1, 30)).toBe(Z('2026-11-01T05:30:00Z'));
        // overflow like Date.UTC: day 32, hour 24
        expect(zonedToInstant('Europe/Berlin', 2026, 12, 32)).toBe(zonedToInstant('Europe/Berlin', 2027, 1, 1));
        expect(zonedToInstant('Europe/Berlin', 2026, 10, 24, 24)).toBe(zonedToInstant('Europe/Berlin', 2026, 10, 25));
    });

    test('isZone', () => {
        expect(isZone('Europe/Berlin')).toBe(true);
        expect(isZone('UTC')).toBe(true);
        expect(isZone('Mars/Olympus')).toBe(false);
        expect(isZone('')).toBe(false);
    });
});

describe('she.time.at / startOfDay / endOfDay / addDays', () => {
    const t = berlin();
    const autumn = Z('2026-10-25T12:00:00Z');
    const spring = Z('2027-03-28T12:00:00Z');

    test("at('HH:mm') on an ordinary day, with seconds, with 24:00", () => {
        const day = Z('2026-07-01T10:00:00Z');
        expect(t.at('06:00', day)).toBe(Z('2026-07-01T04:00:00Z'));
        expect(t.at('23:59:30', day)).toBe(Z('2026-07-01T21:59:30Z'));
        expect(t.at('24:00', day)).toBe(t.startOfDay(Z('2026-07-02T10:00:00Z')));
        expect(t.at('0:05', day)).toBe(Z('2026-06-30T22:05:00Z'));
    });

    test('at: the spring gap shifts forward, the autumn double hour takes the first occurrence', () => {
        expect(t.iso(t.at('02:30', spring))).toBe('2027-03-28T03:30:00+02:00');
        expect(t.at('02:30', spring)).toBe(t.at('03:30', spring));
        expect(t.iso(t.at('02:30', autumn))).toBe('2026-10-25T02:30:00+02:00');
        expect(t.at('02:30', autumn)).toBe(Z('2026-10-25T00:30:00Z'));
        expect(t.at('03:00', autumn) - t.at('02:00', autumn)).toBe(2 * H);
        expect(t.at('03:00', spring) - t.at('02:00', spring)).toBe(0);
    });

    test('at accepts an instant or a Date, defaults ts to now, rejects junk', () => {
        const now = Z('2026-10-25T12:00:00Z');
        const tn = berlin({ now: () => now });
        expect(tn.at('13:00')).toBe(Z('2026-10-25T12:00:00Z'));
        expect(t.at(123456)).toBe(123456);
        expect(t.at(new Date(5000))).toBe(5000);
        expect(() => t.at('25:00', now)).toThrow(TypeError);
        expect(() => t.at('6', now)).toThrow(/expected 'HH:mm' or a sun event/);
        expect(() => t.at({}, now)).toThrow(TypeError);
        expect(() => t.at('06:00', 'yesterday')).toThrow(/must be a timestamp/);
        expect(t.at('06:00', '2026-07-01T10:00:00Z')).toBe(Z('2026-07-01T04:00:00Z'));
    });

    test('startOfDay / endOfDay on the 25-hour and the 23-hour day and over the year change', () => {
        expect(t.startOfDay(autumn)).toBe(Z('2026-10-24T22:00:00Z'));
        expect(t.endOfDay(autumn)).toBe(Z('2026-10-25T23:00:00Z') - 1);
        expect(t.endOfDay(autumn) - t.startOfDay(autumn) + 1).toBe(25 * H);
        expect(t.endOfDay(spring) - t.startOfDay(spring) + 1).toBe(23 * H);
        expect(t.iso(t.startOfDay(Z('2026-12-31T23:30:00Z')))).toBe('2027-01-01T00:00:00+01:00');
        expect(t.iso(t.endOfDay(Z('2026-12-31T22:30:00Z')))).toBe('2026-12-31T23:59:59+01:00');
    });

    test('addDays keeps the wall clock across a DST change and the year change', () => {
        expect(t.iso(t.addDays(Z('2026-10-24T13:00:00Z'), 1))).toBe('2026-10-25T15:00:00+01:00');
        expect(t.iso(t.addDays(Z('2027-03-27T12:00:00Z'), 1))).toBe('2027-03-28T13:00:00+02:00');
        expect(t.iso(t.addDays(Z('2027-03-27T01:30:00Z'), 1))).toBe('2027-03-28T03:30:00+02:00'); // 02:30 does not exist
        expect(t.iso(t.addDays(Z('2026-12-31T20:00:00Z'), 1))).toBe('2027-01-01T21:00:00+01:00');
        expect(t.iso(t.addDays(Z('2027-01-01T20:00:00Z'), -1))).toBe('2026-12-31T21:00:00+01:00');
        expect(() => t.addDays(Z('2027-01-01T20:00:00Z'), 1.5)).toThrow(TypeError);
    });
});

describe('she.time.between', () => {
    const t = berlin();

    test('a plain window: from inclusive, to exclusive', () => {
        const day = (hm) => t.at(hm, Z('2026-07-01T10:00:00Z'));
        expect(t.between('08:00', '17:00', day('08:00'))).toBe(true);
        expect(t.between('08:00', '17:00', day('12:00'))).toBe(true);
        expect(t.between('08:00', '17:00', day('17:00'))).toBe(false);
        expect(t.between('08:00', '17:00', day('07:59'))).toBe(false);
        expect(t.between('08:00', '08:00', day('08:00'))).toBe(false);
        expect(t.between('00:00', '24:00', day('23:59'))).toBe(true);
    });

    test('a midnight-crossing window 22:00–06:00', () => {
        expect(t.between('22:00', '06:00', Z('2026-07-01T20:00:00Z'))).toBe(true); // 22:00
        expect(t.between('22:00', '06:00', Z('2026-07-01T22:30:00Z'))).toBe(true); // 00:30
        expect(t.between('22:00', '06:00', Z('2026-07-02T03:59:00Z'))).toBe(true); // 05:59
        expect(t.between('22:00', '06:00', Z('2026-07-02T04:00:00Z'))).toBe(false); // 06:00
        expect(t.between('22:00', '06:00', Z('2026-07-02T10:00:00Z'))).toBe(false); // 12:00
        expect(t.between('22:00', '06:00', Z('2026-07-01T19:59:00Z'))).toBe(false); // 21:59
    });

    test('a midnight-crossing window over the autumn change and over the year change', () => {
        // the night 2026-10-24/25: 22:00 CEST … 06:00 CET is 9 hours long
        expect(t.between('22:00', '06:00', Z('2026-10-24T20:00:00Z'))).toBe(true);
        expect(t.between('22:00', '06:00', Z('2026-10-25T00:30:00Z'))).toBe(true); // 02:30 CEST
        expect(t.between('22:00', '06:00', Z('2026-10-25T01:30:00Z'))).toBe(true); // 02:30 CET
        expect(t.between('22:00', '06:00', Z('2026-10-25T04:59:00Z'))).toBe(true); // 05:59 CET
        expect(t.between('22:00', '06:00', Z('2026-10-25T05:00:00Z'))).toBe(false); // 06:00 CET
        expect(t.between('22:00', '06:00', Z('2026-12-31T23:30:00Z'))).toBe(true); // 00:30 on New Year's Day
        expect(t.between('22:00', '06:00', Z('2027-01-01T04:59:00Z'))).toBe(true);
    });

    test('the window 02:00–03:00 lasts two hours on the autumn day and is empty on the spring day', () => {
        expect(t.between('02:00', '03:00', Z('2026-10-25T00:00:00Z'))).toBe(true); // 02:00 CEST
        expect(t.between('02:00', '03:00', Z('2026-10-25T00:59:00Z'))).toBe(true); // 02:59 CEST
        expect(t.between('02:00', '03:00', Z('2026-10-25T01:00:00Z'))).toBe(true); // 02:00 CET
        expect(t.between('02:00', '03:00', Z('2026-10-25T01:59:00Z'))).toBe(true); // 02:59 CET
        expect(t.between('02:00', '03:00', Z('2026-10-25T02:00:00Z'))).toBe(false); // 03:00 CET
        expect(t.between('02:00', '03:00', Z('2027-03-28T01:00:00Z'))).toBe(false); // 03:00 CEST, right after the gap
        expect(t.between('02:00', '03:00', Z('2027-03-28T00:59:00Z'))).toBe(false); // 01:59 CET
        // a window that spans the gap still works: 01:30–03:30 on the spring day is one hour long
        expect(t.between('01:30', '03:30', Z('2027-03-28T00:45:00Z'))).toBe(true);
        expect(t.between('01:30', '03:30', Z('2027-03-28T01:29:00Z'))).toBe(true);
        expect(t.between('01:30', '03:30', Z('2027-03-28T01:30:00Z'))).toBe(false);
    });

    test('in another zone: New York on its autumn day', () => {
        const ny = createTime({ timeZone: 'America/New_York' });
        expect(ny.between('22:00', '06:00', Z('2026-11-01T05:30:00Z'))).toBe(true); // 01:30 EDT
        expect(ny.between('22:00', '06:00', Z('2026-11-01T06:30:00Z'))).toBe(true); // 01:30 EST
        expect(ny.between('22:00', '06:00', Z('2026-11-01T11:00:00Z'))).toBe(false); // 06:00 EST
        expect(ny.between('01:00', '02:00', Z('2026-11-01T06:59:00Z'))).toBe(true); // 01:59 EST — the double hour
        expect(ny.at('02:00', Z('2026-11-01T12:00:00Z')) - ny.at('01:00', Z('2026-11-01T12:00:00Z'))).toBe(2 * H);
    });

    test('defaults ts to now', () => {
        const tn = berlin({ now: () => Z('2026-07-01T22:30:00Z') }); // 00:30
        expect(tn.between('22:00', '06:00')).toBe(true);
        expect(tn.between('06:00', '22:00')).toBe(false);
    });
});

describe('she.time: sun events', () => {
    // a stub of suncalc.getTimes: sunrise 07:00Z and sunset 17:00Z of the day the noon falls in
    const sunTimes = jest.fn((noonMs) => {
        const d = new Date(noonMs);
        const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        return { sunrise: new Date(base + 7 * H), sunset: new Date(base + 17 * H), dawn: new Date(base + 6.5 * H), nadir: new Date(NaN) };
    });
    const t = berlin({ sunTimes });
    const day = Z('2026-10-25T12:00:00Z');

    test('at(sun event) with offsets; the source is asked for the local noon of the day', () => {
        sunTimes.mockClear();
        expect(t.at('sunset', day)).toBe(Z('2026-10-25T17:00:00Z'));
        expect(sunTimes).toHaveBeenCalledWith(Z('2026-10-25T11:00:00Z')); // 12:00 CET
        expect(t.at('sunset-30m', day)).toBe(Z('2026-10-25T16:30:00Z'));
        expect(t.at('dawn+1h', day)).toBe(Z('2026-10-25T07:30:00Z'));
        expect(t.at('sunrise+90s', day)).toBe(Z('2026-10-25T07:01:30Z'));
        expect(t.at('sunrise + 1.5h', day)).toBe(Z('2026-10-25T08:30:00Z'));
        expect(t.at('nadir', day)).toBeNaN();
    });

    test('between with sun events, over midnight, and a window that does not occur', () => {
        expect(t.between('sunset', 'sunrise', Z('2026-10-25T20:00:00Z'))).toBe(true);
        expect(t.between('sunset', 'sunrise', Z('2026-10-26T06:59:00Z'))).toBe(true);
        expect(t.between('sunset', 'sunrise', Z('2026-10-26T07:00:00Z'))).toBe(false);
        expect(t.between('sunset-30m', '23:00', Z('2026-10-25T16:45:00Z'))).toBe(true);
        expect(t.between('07:00', 'sunset', Z('2026-10-25T12:00:00Z'))).toBe(true);
        expect(t.between('nadir', '12:00', day)).toBe(false);
    });

    test('bad specs are TypeErrors that say what is expected', () => {
        expect(() => t.at('moonrise', day)).toThrow(/unknown time or sun event "moonrise".*sunrise/);
        expect(() => t.at('sunset-30', day)).toThrow(/needs a unit/);
        expect(() => berlin().at('sunset', day)).toThrow(/sun events are not available/);
    });
});

describe('she.time: weekend, holidays, workday', () => {
    test('isWeekend by the zone, not the process', () => {
        const t = createTime({ timeZone: 'Pacific/Auckland' });
        // Saturday 2026-11-07 23:00Z is Sunday 12:00 in Auckland; Sunday 2026-11-08 12:00Z is Monday 01:00 there
        expect(t.isWeekend(Z('2026-11-07T23:00:00Z'))).toBe(true);
        expect(t.isWeekend(Z('2026-11-08T12:00:00Z'))).toBe(false);
        expect(berlin().isWeekend(Z('2026-11-08T12:00:00Z'))).toBe(true);
        expect(berlin().isWeekend(Z('2026-11-06T12:00:00Z'))).toBe(false);
    });

    test('holidays of a German state: fixed, Easter-based and the local ones', () => {
        const t = berlin({ holidays: 'DE-BW' });
        expect(t.holiday(Z('2026-01-01T10:00:00Z'))).toBe('Neujahr');
        expect(t.holiday(Z('2026-01-06T10:00:00Z'))).toBe('Heilige Drei Könige');
        expect(t.holiday(Z('2026-04-03T10:00:00Z'))).toBe('Karfreitag'); // Easter 2026-04-05
        expect(t.holiday(Z('2026-04-06T10:00:00Z'))).toBe('Ostermontag');
        expect(t.holiday(Z('2026-05-14T10:00:00Z'))).toBe('Christi Himmelfahrt');
        expect(t.holiday(Z('2026-05-25T10:00:00Z'))).toBe('Pfingstmontag');
        expect(t.holiday(Z('2026-06-04T10:00:00Z'))).toBe('Fronleichnam');
        expect(t.holiday(Z('2026-11-01T10:00:00Z'))).toBe('Allerheiligen');
        expect(t.holiday(Z('2026-10-31T10:00:00Z'))).toBeNull(); // Reformationstag is not one in BW
        expect(t.isHoliday(Z('2026-12-25T10:00:00Z'))).toBe(true);
        expect(t.isHoliday(Z('2026-12-24T10:00:00Z'))).toBe(false);
        // Easter 2027-03-28 — Easter Sunday is the spring DST day; Good Friday 03-26, Easter Monday 03-29
        expect(t.holiday(Z('2027-03-26T10:00:00Z'))).toBe('Karfreitag');
        expect(t.holiday(Z('2027-03-29T10:00:00Z'))).toBe('Ostermontag');
        // the day is taken in the zone: 2026-12-25 23:30Z is already the 26th in Berlin
        expect(t.holiday(Z('2026-12-25T23:30:00Z'))).toBe('2. Weihnachtstag');
        expect(berlin({ holidays: 'DE-SN' }).holiday(Z('2026-11-18T10:00:00Z'))).toBe('Buß- und Bettag');
        expect(berlin({ holidays: 'DE-SN' }).holiday(Z('2027-11-17T10:00:00Z'))).toBe('Buß- und Bettag');
        expect(berlin({ holidays: 'de-bb' }).holiday(Z('2026-04-05T10:00:00Z'))).toBe('Ostersonntag');
        expect(berlin({ holidays: 'DE' }).holiday(Z('2026-01-06T10:00:00Z'))).toBeNull();
        expect(createTime({ timeZone: 'Europe/Vienna', holidays: 'AT' }).holiday(Z('2026-10-26T10:00:00Z'))).toBe('Nationalfeiertag');
    });

    test('holidaysExtra: yearly and one-off dates, with and without a name', () => {
        const t = berlin({
            holidays: 'DE',
            holidaysExtra: [
                { date: '05-08', name: 'Tag der Befreiung' },
                { date: '2026-12-24', name: '2026-12-24' },
            ],
        });
        expect(t.holiday(Z('2026-05-08T10:00:00Z'))).toBe('Tag der Befreiung');
        expect(t.holiday(Z('2027-05-08T10:00:00Z'))).toBe('Tag der Befreiung');
        expect(t.holiday(Z('2026-12-24T10:00:00Z'))).toBe('2026-12-24');
        expect(t.holiday(Z('2027-12-24T10:00:00Z'))).toBeNull();
        const onlyExtra = berlin({ holidaysExtra: [{ date: '05-08', name: 'x' }], warn: jest.fn() });
        expect(onlyExtra.isHoliday(Z('2026-05-08T10:00:00Z'))).toBe(true);
        expect(onlyExtra.isHoliday(Z('2026-12-25T10:00:00Z'))).toBe(false);
    });

    test('isWorkday: neither weekend nor holiday', () => {
        const t = berlin({ holidays: 'DE-BW' });
        expect(t.isWorkday(Z('2026-11-09T10:00:00Z'))).toBe(true); // Monday
        expect(t.isWorkday(Z('2026-11-08T10:00:00Z'))).toBe(false); // Sunday
        expect(t.isWorkday(Z('2026-06-04T10:00:00Z'))).toBe(false); // Fronleichnam, a Thursday
        expect(t.isWorkday(Z('2026-10-03T10:00:00Z'))).toBe(false); // Saturday and a holiday
    });

    test('without a holiday config isHoliday is false and warns once', () => {
        const warn = jest.fn();
        const t = berlin({ warn });
        expect(t.isHoliday(Z('2026-12-25T10:00:00Z'))).toBe(false);
        expect(t.isWorkday(Z('2026-12-25T10:00:00Z'))).toBe(true);
        expect(t.isHoliday()).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/no holidays configured/);
        expect(t.holidays).toBeNull();
        expect(berlin({ holidays: 'XX-YY', warn }).holidays).toBeNull();
    });
});

describe('she.time.format / iso', () => {
    const t = berlin();
    const ts = Z('2026-10-25T00:41:07.042Z'); // 02:41:07.042 CEST, Sunday

    test('the tokens', () => {
        expect(t.format(ts, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-10-25 02:41:07');
        expect(t.format(ts, 'D.M.YY H:m:s')).toBe('25.10.26 2:41:7');
        expect(t.format(ts, 'SSS Z')).toBe('042 +02:00');
        expect(t.format(ts + H, 'HH:mm Z')).toBe('02:41 +01:00');
        expect(t.format(ts, 'dd HH:mm')).toBe('So 02:41');
        expect(t.format(ts, 'ddd, D. MMMM YYYY')).toBe('Sonntag, 25. Oktober 2026');
        expect(t.format(ts, 'MMM')).toBe('Okt');
        expect(t.format(ts, '[Zeit:] HH:mm [Uhr]')).toBe('Zeit: 02:41 Uhr');
        expect(t.format(ts)).toBe('2026-10-25 02:41:07');
        expect(t.format(Z('2026-01-05T12:00:00Z'), 'D.M.')).toBe('5.1.');
    });

    test('names follow the locale', () => {
        const en = createTime({ timeZone: 'Europe/Berlin', locale: 'en-US' });
        expect(en.format(ts, 'dd ddd MMM MMMM')).toBe('Sun Sunday Oct October');
        const fr = createTime({ timeZone: 'Europe/Paris', locale: 'fr-FR' });
        expect(fr.format(ts, 'ddd')).toBe('dimanche');
        expect(createTime({ timeZone: 'Europe/Berlin', locale: 'xx-INVALID' }).locale).toBe('de-DE');
    });

    test('format and iso in another zone and with a Date or ISO string', () => {
        const ny = createTime({ timeZone: 'America/New_York' });
        expect(ny.iso(ts)).toBe('2026-10-24T20:41:07-04:00');
        expect(ny.iso(Z('2026-11-01T06:30:00Z'))).toBe('2026-11-01T01:30:00-05:00');
        expect(ny.iso(Z('2026-11-01T05:30:00Z'))).toBe('2026-11-01T01:30:00-04:00');
        expect(t.iso(new Date(ts))).toBe('2026-10-25T02:41:07+02:00');
        expect(t.iso('2026-10-25T00:41:07Z')).toBe('2026-10-25T02:41:07+02:00');
        expect(createTime({ timeZone: 'Asia/Kolkata' }).iso(Z('2026-01-01T00:00:00Z'))).toBe('2026-01-01T05:30:00+05:30');
        expect(createTime({ timeZone: 'UTC' }).iso(Z('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00+00:00');
    });

    test('iso makes the double hour sortable: the same wall clock, different offsets', () => {
        const a = t.iso(Z('2026-10-25T00:08:00Z')); // 02:08 CEST
        const b = t.iso(Z('2026-10-25T01:41:00Z')); // 02:41 CET — later, though "02:41" > "02:08" looks right only by chance
        const c = t.iso(Z('2026-10-25T00:41:00Z')); // 02:41 CEST
        expect([b, a, c].map((s) => Date.parse(s)).sort((x, y) => x - y)).toEqual([Z('2026-10-25T00:08:00Z'), Z('2026-10-25T00:41:00Z'), Z('2026-10-25T01:41:00Z')]);
        expect(a).toBe('2026-10-25T02:08:00+02:00');
        expect(b).toBe('2026-10-25T02:41:00+01:00');
    });

    test('format rejects a non-string pattern', () => {
        expect(() => t.format(ts, 5)).toThrow(TypeError);
    });
});

describe('she.time.duration / humanize / parts', () => {
    const t = berlin();

    test('duration is the real difference across the autumn change', () => {
        // asleep 02:40 CEST, awake 06:25 CET: the wall clock says 3 h 45 min, the night was 4 h 45 min
        const asleep = t.at('02:40', Z('2026-10-25T12:00:00Z'));
        const awake = t.at('06:25', Z('2026-10-25T12:00:00Z'));
        expect(t.duration(asleep, awake)).toBe(4.75 * H);
        expect(t.humanize(t.duration(asleep, awake))).toBe('4 h 45 min');
        expect(t.duration(new Date(1000), 4000)).toBe(3000);
        expect(t.duration('2026-10-25T00:40:00Z', '2026-10-25T05:25:00Z')).toBe(4.75 * H);
        expect(() => t.duration('x', 1)).toThrow(/a must be/);
    });

    test('humanize', () => {
        expect(t.humanize(2 * H + 40 * 60000)).toBe('2 h 40 min');
        expect(t.humanize(2 * H + 30000)).toBe('2 h');
        expect(t.humanize(90000)).toBe('1 min 30 s');
        expect(t.humanize(3 * 86400000 + 5 * H + 6 * 60000)).toBe('3 d 5 h');
        expect(t.humanize(3 * 86400000 + 5 * H + 6 * 60000, { parts: 3 })).toBe('3 d 5 h 6 min');
        expect(t.humanize(59999)).toBe('59 s');
        expect(t.humanize(500)).toBe('500 ms');
        expect(t.humanize(0)).toBe('0 ms');
        expect(t.humanize(-90000)).toBe('-1 min 30 s');
        expect(t.humanize(2 * H + 40 * 60000, { long: true })).toBe('2 Stunden 40 Minuten');
        expect(createTime({ timeZone: 'Europe/Berlin', locale: 'en-US' }).humanize(H + 60000, { long: true })).toBe('1 hour 1 minute');
        expect(() => t.humanize('5m')).toThrow(TypeError);
    });

    test('parts gives the wall clock of the zone', () => {
        expect(t.parts(Z('2026-10-25T00:41:07.042Z'))).toEqual({
            year: 2026,
            month: 10,
            day: 25,
            hour: 2,
            minute: 41,
            second: 7,
            millisecond: 42,
            weekday: 0,
            offset: 120,
            zone: 'Europe/Berlin',
        });
        const tn = berlin({ now: () => Z('2026-12-31T23:30:00Z') });
        expect(tn.parts()).toMatchObject({ year: 2027, month: 1, day: 1, hour: 0, minute: 30, weekday: 5 });
        expect(tn.now()).toBe(Z('2026-12-31T23:30:00Z'));
    });

    test('the object is frozen and names its zone', () => {
        expect(Object.isFrozen(t)).toBe(true);
        expect(t.zone).toBe('Europe/Berlin');
        expect(createTime({ timeZone: 'Nowhere/Land' }).zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

describe('settingsFromConfig', () => {
    test('defaults: the process zone, de-DE, no holidays', () => {
        const warn = jest.fn();
        expect(settingsFromConfig({}, warn)).toEqual({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'de-DE', holidays: null, holidaysExtra: [] });
        expect(warn).not.toHaveBeenCalled();
    });

    test('valid values are taken, invalid ones warned about once each and replaced by the default', () => {
        const warn = jest.fn();
        const s = settingsFromConfig(
            { timezone: 'America/New_York', locale: 'en-GB', holidays: 'de-by', holidaysExtra: ['05-08 Befreiung', 'nope', { date: '2026-12-24' }] },
            warn,
        );
        expect(s).toEqual({
            timeZone: 'America/New_York',
            locale: 'en-GB',
            holidays: 'DE-BY',
            holidaysExtra: [
                { date: '05-08', name: 'Befreiung' },
                { date: '2026-12-24', name: '2026-12-24' },
            ],
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/holidaysExtra: "nope"/);
        const bad = settingsFromConfig({ timezone: 'Mars/Olympus', locale: 'zz-ZZZZ-zz-zz', holidays: 'XX' }, warn);
        expect(bad.locale).toBe('de-DE');
        expect(bad.holidays).toBeNull();
        expect(warn).toHaveBeenCalledTimes(4);
        expect(warn.mock.calls[1][0]).toMatch(/timezone "Mars\/Olympus"/);
        expect(warn.mock.calls[3][0]).toMatch(/known: DE, DE-BW/);
    });
});
