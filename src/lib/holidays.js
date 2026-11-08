'use strict';
/**
 * Public holidays as a small rule table — fixed dates and days counted from Easter Sunday —
 * for `she.time.isHoliday()`. Regions are an ISO 3166 country code, optionally with a
 * subdivision (`DE`, `DE-BW`, `AT`); a subdivision inherits its country's rules.
 *
 * Deliberately small: no library, no calendar data files. What is not a public holiday
 * everywhere in a region is left out (Mariä Himmelfahrt in Bavaria's catholic communities,
 * the Augsburger Friedensfest) — a local day goes into the `holidaysExtra` config list.
 */

const DAY = 86400000;

/** Easter Sunday of a Gregorian year as UTC ms (Meeus/Jones/Butcher). */
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(year, month - 1, day);
}

/** Buß- und Bettag: the Wednesday before November 23. */
function penanceDay(year) {
    let t = Date.UTC(year, 10, 22);
    while (new Date(t).getUTCDay() !== 3) t -= DAY;
    return t;
}

const fixed = (date, name) => ({ fixed: date, name });
const easter = (offset, name) => ({ easter: offset, name });

const DE_NATIONAL = [
    fixed('01-01', 'Neujahr'),
    easter(-2, 'Karfreitag'),
    easter(1, 'Ostermontag'),
    fixed('05-01', 'Tag der Arbeit'),
    easter(39, 'Christi Himmelfahrt'),
    easter(50, 'Pfingstmontag'),
    fixed('10-03', 'Tag der Deutschen Einheit'),
    fixed('12-25', '1. Weihnachtstag'),
    fixed('12-26', '2. Weihnachtstag'),
];

const EPIPHANY = fixed('01-06', 'Heilige Drei Könige');
const WOMENS_DAY = fixed('03-08', 'Internationaler Frauentag');
const CORPUS_CHRISTI = easter(60, 'Fronleichnam');
const ASSUMPTION = fixed('08-15', 'Mariä Himmelfahrt');
const REFORMATION = fixed('10-31', 'Reformationstag');
const ALL_SAINTS = fixed('11-01', 'Allerheiligen');
const CHILDRENS_DAY = fixed('09-20', 'Weltkindertag');
const PENANCE = { compute: penanceDay, name: 'Buß- und Bettag' };

const REGIONS = {
    'DE': { name: 'Deutschland (bundesweite Feiertage)', rules: DE_NATIONAL },
    'DE-BW': { name: 'Baden-Württemberg', parent: 'DE', rules: [EPIPHANY, CORPUS_CHRISTI, ALL_SAINTS] },
    'DE-BY': { name: 'Bayern', parent: 'DE', rules: [EPIPHANY, CORPUS_CHRISTI, ALL_SAINTS] },
    'DE-BE': { name: 'Berlin', parent: 'DE', rules: [WOMENS_DAY] },
    'DE-BB': { name: 'Brandenburg', parent: 'DE', rules: [easter(0, 'Ostersonntag'), easter(49, 'Pfingstsonntag'), REFORMATION] },
    'DE-HB': { name: 'Bremen', parent: 'DE', rules: [REFORMATION] },
    'DE-HH': { name: 'Hamburg', parent: 'DE', rules: [REFORMATION] },
    'DE-HE': { name: 'Hessen', parent: 'DE', rules: [CORPUS_CHRISTI] },
    'DE-MV': { name: 'Mecklenburg-Vorpommern', parent: 'DE', rules: [WOMENS_DAY, REFORMATION] },
    'DE-NI': { name: 'Niedersachsen', parent: 'DE', rules: [REFORMATION] },
    'DE-NW': { name: 'Nordrhein-Westfalen', parent: 'DE', rules: [CORPUS_CHRISTI, ALL_SAINTS] },
    'DE-RP': { name: 'Rheinland-Pfalz', parent: 'DE', rules: [CORPUS_CHRISTI, ALL_SAINTS] },
    'DE-SL': { name: 'Saarland', parent: 'DE', rules: [CORPUS_CHRISTI, ASSUMPTION, ALL_SAINTS] },
    'DE-SN': { name: 'Sachsen', parent: 'DE', rules: [REFORMATION, PENANCE] },
    'DE-ST': { name: 'Sachsen-Anhalt', parent: 'DE', rules: [EPIPHANY, REFORMATION] },
    'DE-SH': { name: 'Schleswig-Holstein', parent: 'DE', rules: [REFORMATION] },
    'DE-TH': { name: 'Thüringen', parent: 'DE', rules: [CHILDRENS_DAY, REFORMATION] },
    'AT': {
        name: 'Österreich',
        rules: [
            fixed('01-01', 'Neujahr'),
            EPIPHANY,
            easter(1, 'Ostermontag'),
            fixed('05-01', 'Staatsfeiertag'),
            easter(39, 'Christi Himmelfahrt'),
            easter(50, 'Pfingstmontag'),
            CORPUS_CHRISTI,
            ASSUMPTION,
            fixed('10-26', 'Nationalfeiertag'),
            ALL_SAINTS,
            fixed('12-08', 'Mariä Empfängnis'),
            fixed('12-25', 'Christtag'),
            fixed('12-26', 'Stefanitag'),
        ],
    },
};

function normalizeRegion(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

function isRegion(code) {
    return Object.prototype.hasOwnProperty.call(REGIONS, normalizeRegion(code));
}

/** @returns {Array<{code: string, name: string}>} */
function listRegions() {
    return Object.keys(REGIONS).map((code) => ({ code, name: REGIONS[code].name }));
}

const pad2 = (n) => String(n).padStart(2, '0');
const mmdd = (utcMs) => {
    const d = new Date(utcMs);
    return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

function rulesOf(code) {
    const region = REGIONS[normalizeRegion(code)];
    if (!region) return [];
    return region.parent ? [...rulesOf(region.parent), ...region.rules] : region.rules;
}

const _cache = new Map();

/**
 * The holidays of a region in one year.
 * @param {string} code region, e.g. 'DE-BW'
 * @param {number} year
 * @returns {Map<string, string>} 'MM-DD' → name, in calendar order; empty for an unknown region
 */
function holidaysOfYear(code, year) {
    const key = `${normalizeRegion(code)}|${year}`;
    const hit = _cache.get(key);
    if (hit) return hit;
    const es = easterSunday(year);
    const days = rulesOf(code).map((rule) => {
        if (rule.fixed) return [rule.fixed, rule.name];
        if (typeof rule.easter === 'number') return [mmdd(es + rule.easter * DAY), rule.name];
        return [mmdd(rule.compute(year)), rule.name];
    });
    days.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const map = new Map(days);
    if (_cache.size > 200) _cache.clear();
    _cache.set(key, map);
    return map;
}

/**
 * Parse the `holidaysExtra` config list: strings `MM-DD` or `YYYY-MM-DD`, optionally followed
 * by a name (`"05-08 Tag der Befreiung"`), or objects `{ date, name }`.
 * @param {unknown} list
 * @returns {{ entries: Array<{date: string, name: string}>, errors: string[] }} date is 'MM-DD' or 'YYYY-MM-DD'
 */
function parseExtra(list) {
    const entries = [];
    const errors = [];
    if (list === undefined || list === null || list === '') return { entries, errors };
    if (!Array.isArray(list)) return { entries, errors: ['holidaysExtra must be a list'] };
    for (const item of list) {
        let date, name;
        if (typeof item === 'string') {
            const m = /^\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})(?:\s+(.*?))?\s*$/.exec(item);
            if (m) [, date, name] = m;
        } else if (item && typeof item === 'object' && typeof item.date === 'string') {
            if (/^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.test(item.date)) {
                date = item.date;
                name = typeof item.name === 'string' ? item.name : undefined;
            }
        }
        if (!date) {
            errors.push(`holidaysExtra: "${typeof item === 'string' ? item : JSON.stringify(item)}" is not "MM-DD" or "YYYY-MM-DD" (optionally followed by a name)`);
            continue;
        }
        const [mo, d] = date.slice(-5).split('-').map(Number);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) {
            errors.push(`holidaysExtra: "${date}" is not a calendar date`);
            continue;
        }
        entries.push({ date, name: name || date });
    }
    return { entries, errors };
}

module.exports = { REGIONS, easterSunday, isRegion, listRegions, holidaysOfYear, normalizeRegion, parseExtra };
