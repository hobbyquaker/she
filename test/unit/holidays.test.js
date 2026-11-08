'use strict';

const h = require('../../src/lib/holidays');

const utc = (ms) => new Date(ms).toISOString().slice(0, 10);

describe('holidays: Easter', () => {
    test('Easter Sunday of known years', () => {
        expect(utc(h.easterSunday(2024))).toBe('2024-03-31');
        expect(utc(h.easterSunday(2025))).toBe('2025-04-20');
        expect(utc(h.easterSunday(2026))).toBe('2026-04-05');
        expect(utc(h.easterSunday(2027))).toBe('2027-03-28');
        expect(utc(h.easterSunday(2028))).toBe('2028-04-16');
        expect(utc(h.easterSunday(2038))).toBe('2038-04-25'); // the latest possible date
        expect(utc(h.easterSunday(2285))).toBe('2285-03-22'); // the earliest possible date
    });
});

describe('holidays: regions and tables', () => {
    test('regions: Germany with its states, Austria; codes are case-insensitive', () => {
        const codes = h.listRegions().map((r) => r.code);
        expect(codes).toContain('DE');
        expect(codes).toContain('DE-BW');
        expect(codes).toContain('AT');
        expect(codes.filter((c) => c.startsWith('DE-'))).toHaveLength(16);
        expect(h.isRegion('de-bw')).toBe(true);
        expect(h.isRegion(' DE ')).toBe(true);
        expect(h.isRegion('CH')).toBe(false);
        expect(h.isRegion(undefined)).toBe(false);
        expect(h.normalizeRegion('de-nw')).toBe('DE-NW');
    });

    test('the national German holidays of 2026 in calendar order', () => {
        expect([...h.holidaysOfYear('DE', 2026)]).toEqual([
            ['01-01', 'Neujahr'],
            ['04-03', 'Karfreitag'],
            ['04-06', 'Ostermontag'],
            ['05-01', 'Tag der Arbeit'],
            ['05-14', 'Christi Himmelfahrt'],
            ['05-25', 'Pfingstmontag'],
            ['10-03', 'Tag der Deutschen Einheit'],
            ['12-25', '1. Weihnachtstag'],
            ['12-26', '2. Weihnachtstag'],
        ]);
    });

    test('a state inherits the national days and adds its own', () => {
        const bw = h.holidaysOfYear('DE-BW', 2026);
        expect(bw.size).toBe(12);
        expect(bw.get('01-06')).toBe('Heilige Drei Könige');
        expect(bw.get('06-04')).toBe('Fronleichnam');
        expect(bw.get('11-01')).toBe('Allerheiligen');
        expect(bw.get('10-31')).toBeUndefined();
        const sn = h.holidaysOfYear('DE-SN', 2026);
        expect(sn.get('10-31')).toBe('Reformationstag');
        expect(sn.get('11-18')).toBe('Buß- und Bettag'); // the Wednesday before Nov 23
        expect(h.holidaysOfYear('DE-SN', 2025).get('11-19')).toBe('Buß- und Bettag');
        expect(h.holidaysOfYear('DE-SN', 2028).get('11-22')).toBe('Buß- und Bettag');
        expect(h.holidaysOfYear('DE-BE', 2026).get('03-08')).toBe('Internationaler Frauentag');
        expect(h.holidaysOfYear('DE-TH', 2026).get('09-20')).toBe('Weltkindertag');
        expect(h.holidaysOfYear('DE-SL', 2026).get('08-15')).toBe('Mariä Himmelfahrt');
        expect(h.holidaysOfYear('DE-BY', 2026).get('08-15')).toBeUndefined(); // not everywhere in Bavaria — holidaysExtra
        expect(h.holidaysOfYear('DE-BB', 2026).get('04-05')).toBe('Ostersonntag');
        expect(h.holidaysOfYear('DE-BB', 2026).get('05-24')).toBe('Pfingstsonntag');
    });

    test('Austria', () => {
        const at = h.holidaysOfYear('AT', 2026);
        expect(at.size).toBe(13);
        expect(at.get('10-26')).toBe('Nationalfeiertag');
        expect(at.get('12-08')).toBe('Mariä Empfängnis');
        expect(at.get('06-04')).toBe('Fronleichnam');
    });

    test('an unknown region has no holidays; the table is cached', () => {
        expect(h.holidaysOfYear('XX', 2026).size).toBe(0);
        expect(h.holidaysOfYear('DE', 2026)).toBe(h.holidaysOfYear('de', 2026));
    });
});

describe('holidays: parseExtra', () => {
    test('strings with and without a name, objects, and the errors', () => {
        const r = h.parseExtra(['05-08 Tag der Befreiung', '2026-12-24', { date: '12-31', name: 'Silvester' }, { date: '01-02' }, 'Montag', { date: '13-01' }, 7]);
        expect(r.entries).toEqual([
            { date: '05-08', name: 'Tag der Befreiung' },
            { date: '2026-12-24', name: '2026-12-24' },
            { date: '12-31', name: 'Silvester' },
            { date: '01-02', name: '01-02' },
        ]);
        expect(r.errors).toHaveLength(3);
        expect(r.errors[0]).toMatch(/"Montag"/);
        expect(r.errors[1]).toMatch(/"13-01" is not a calendar date/);
        expect(h.parseExtra(undefined)).toEqual({ entries: [], errors: [] });
        expect(h.parseExtra('05-08').errors).toEqual(['holidaysExtra must be a list']);
    });
});
