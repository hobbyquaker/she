'use strict';
/**
 * Zone-aware time helpers for scripts: time windows, wall-clock instants, weekend and holidays,
 * formatting, durations — `she.time`.
 *
 * Everything is computed from `Intl.DateTimeFormat` in the configured time zone, so a script
 * gets the same answers whatever zone the process runs in, and the daylight-saving changes are
 * handled once, here, instead of in every script:
 *
 * - A wall-clock time that does not exist (02:30 on the day the clocks go forward) resolves
 *   to the instant one hour later on the wall clock (03:30), like Temporal's `compatible`
 *   disambiguation. One that exists twice (02:30 on the day the clocks go back) resolves to
 *   its first occurrence (the one still in summer time).
 * - A window compares instants, so the window 02:00–03:00 lasts two hours on the autumn day
 *   and is empty on the spring day.
 * - Durations are differences of instants: a night that spans the autumn change is an hour
 *   longer than its wall-clock times suggest, and `duration` says so.
 *
 * The helpers take a timestamp in ms (what `she.now()`, `obj.ts` and `Date.now()` give), a
 * `Date`, or an ISO string, and default to now. No dependency besides Intl.
 */

const holidayTable = require('./holidays');

const DAY = 86400000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const _formatters = new Map();
function formatter(locale, options) {
    const key = locale + '|' + JSON.stringify(options);
    let f = _formatters.get(key);
    if (!f) {
        f = new Intl.DateTimeFormat(locale, options);
        if (_formatters.size > 500) _formatters.clear();
        _formatters.set(key, f);
    }
    return f;
}

/** The IANA zone the process runs in. */
function systemZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isZone(name) {
    if (typeof name !== 'string' || !name) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name });
        return true;
    } catch {
        return false;
    }
}

function isLocale(tag) {
    if (typeof tag !== 'string' || !tag) return false;
    try {
        return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
    } catch {
        return false;
    }
}

/**
 * The wall-clock fields of an instant in a zone.
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, millisecond:number, weekday:number, offset:number}}
 *   month 1–12, weekday 0 (Sunday) – 6, offset in minutes east of UTC
 */
function wallParts(timeZone, ts) {
    const f = formatter('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'short',
    });
    const whole = Math.floor(ts / 1000) * 1000;
    const p = {};
    for (const { type, value } of f.formatToParts(new Date(whole))) p[type] = value;
    const year = Number(p.year);
    const month = Number(p.month);
    const day = Number(p.day);
    const hour = Number(p.hour) % 24;
    const minute = Number(p.minute);
    const second = Number(p.second);
    const offset = Math.round((Date.UTC(year, month - 1, day, hour, minute, second) - whole) / 60000);
    return { year, month, day, hour, minute, second, millisecond: ts - whole, weekday: WEEKDAYS[p.weekday], offset };
}

function offsetAt(timeZone, ts) {
    return wallParts(timeZone, ts).offset;
}

/**
 * The instant of a wall-clock time in a zone. Fields overflow like `Date.UTC` (day 32, hour 24).
 * A time in a gap resolves forward by the gap; an ambiguous time to its first occurrence.
 */
function zonedToInstant(timeZone, year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    const before = offsetAt(timeZone, wall - DAY);
    const after = offsetAt(timeZone, wall + DAY);
    let first = NaN;
    for (const off of before === after ? [before] : [before, after]) {
        const instant = wall - off * 60000;
        if (offsetAt(timeZone, instant) === off && !(instant >= first)) first = instant;
    }
    return Number.isNaN(first) ? wall - before * 60000 : first;
}

const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000 };

function describe(x) {
    if (typeof x === 'string') return JSON.stringify(x);
    if (x && typeof x === 'object') return Object.prototype.toString.call(x);
    return String(x);
}

/**
 * @param {object} opts
 * @param {string} [opts.timeZone] IANA zone; default the process zone
 * @param {string} [opts.locale] BCP 47 tag for names and words; default 'de-DE'
 * @param {string|null} [opts.holidays] region code of the holiday table, e.g. 'DE-BW'; null = not configured
 * @param {Array<{date: string, name: string}>} [opts.holidaysExtra] parsed with holidays.parseExtra
 * @param {Function} [opts.sunTimes] (noonMs) → the sun events of that day as Dates (suncalc.getTimes)
 * @param {Function} [opts.now] → ms, default Date.now
 * @param {Function} [opts.warn] (msg) one-off warnings
 */
function createTime(opts = {}) {
    const timeZone = isZone(opts.timeZone) ? opts.timeZone : systemZone();
    const locale = isLocale(opts.locale) ? opts.locale : 'de-DE';
    const holidays = holidayTable.isRegion(opts.holidays) ? holidayTable.normalizeRegion(opts.holidays) : null;
    const extra = Array.isArray(opts.holidaysExtra) ? opts.holidaysExtra : [];
    const sunTimes = typeof opts.sunTimes === 'function' ? opts.sunTimes : null;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
    let warnedHolidays = false;

    function toMs(x, api, what = 'ts') {
        if (x === undefined || x === null) return now();
        if (typeof x === 'number') return x;
        if (x && typeof x === 'object' && typeof x.getTime === 'function') return x.getTime();
        if (typeof x === 'string') {
            const ms = Date.parse(x);
            if (!Number.isNaN(ms)) return ms;
        }
        throw new TypeError(`${api}: ${what} must be a timestamp in ms, a Date or an ISO string (got ${describe(x)})`);
    }

    const pad = (n, w = 2) => String(n).padStart(w, '0');

    function offsetString(minutes) {
        const sign = minutes < 0 ? '-' : '+';
        const abs = Math.abs(minutes);
        return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    }

    function parts(ts) {
        const p = wallParts(timeZone, toMs(ts, 'she.time.parts([ts])'));
        p.zone = timeZone;
        return p;
    }

    function startOfDay(ts) {
        const p = wallParts(timeZone, toMs(ts, 'she.time.startOfDay([ts])'));
        return zonedToInstant(timeZone, p.year, p.month, p.day);
    }

    function endOfDay(ts) {
        const p = wallParts(timeZone, toMs(ts, 'she.time.endOfDay([ts])'));
        return zonedToInstant(timeZone, p.year, p.month, p.day + 1) - 1;
    }

    function addDays(ts, days) {
        const api = 'she.time.addDays(ts, days)';
        const p = wallParts(timeZone, toMs(ts, api));
        if (typeof days !== 'number' || !Number.isInteger(days)) throw new TypeError(`${api}: days must be an integer (got ${describe(days)})`);
        return zonedToInstant(timeZone, p.year, p.month, p.day + days, p.hour, p.minute, p.second, p.millisecond);
    }

    /** Resolve 'HH:mm[:ss]' or a sun event with offset ('sunset-30m') on the day of `dayTs`. */
    function resolve(spec, dayTs, api) {
        if (typeof spec === 'number') return spec;
        if (spec && typeof spec === 'object' && typeof spec.getTime === 'function') return spec.getTime();
        if (typeof spec !== 'string') throw new TypeError(`${api}: expected 'HH:mm' or a sun event like 'sunset-30m' (got ${describe(spec)})`);
        const p = wallParts(timeZone, dayTs);
        const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(spec.trim());
        if (clock) {
            const [, h, mi, s] = clock.map(Number);
            if (h > 24 || mi > 59 || s > 59 || (h === 24 && (mi || s))) throw new TypeError(`${api}: ${describe(spec)} is not a time of day`);
            return zonedToInstant(timeZone, p.year, p.month, p.day, h, mi, s || 0);
        }
        const sun = /^([a-zA-Z]+)(?:\s*([+-])\s*(\d+(?:\.\d+)?)(ms|s|m|h)?)?$/.exec(spec.trim());
        if (!sun) throw new TypeError(`${api}: expected 'HH:mm' or a sun event like 'sunset-30m' (got ${describe(spec)})`);
        const [, name, sign, amount, unit] = sun;
        if (!sunTimes) throw new TypeError(`${api}: sun events are not available here`);
        const times = sunTimes(zonedToInstant(timeZone, p.year, p.month, p.day, 12));
        if (!times || !Object.prototype.hasOwnProperty.call(times, name)) {
            throw new TypeError(`${api}: unknown time or sun event ${describe(spec)} — expected 'HH:mm' or one of ${Object.keys(times || {}).join(', ')}`);
        }
        if (sign && !unit) throw new TypeError(`${api}: the offset of ${describe(spec)} needs a unit: ms, s, m or h (e.g. 'sunset-30m')`);
        const base = times[name] instanceof Date ? times[name].getTime() : toMs(times[name], api);
        return base + (sign ? (sign === '-' ? -1 : 1) * Number(amount) * UNIT_MS[unit] : 0);
    }

    function at(spec, ts) {
        const api = 'she.time.at(time, [ts])';
        return resolve(spec, toMs(ts, api), api);
    }

    function between(from, to, ts) {
        const api = 'she.time.between(from, to, [ts])';
        const t = toMs(ts, api);
        const f = resolve(from, t, api);
        const e = resolve(to, t, api);
        if (Number.isNaN(f) || Number.isNaN(e)) return false;
        return f <= e ? t >= f && t < e : t >= f || t < e;
    }

    function isWeekend(ts) {
        const d = wallParts(timeZone, toMs(ts, 'she.time.isWeekend([ts])')).weekday;
        return d === 0 || d === 6;
    }

    function holiday(ts) {
        const p = wallParts(timeZone, toMs(ts, 'she.time.holiday([ts])'));
        const md = `${pad(p.month)}-${pad(p.day)}`;
        const ymd = `${p.year}-${md}`;
        for (const x of extra) if (x.date === md || x.date === ymd) return x.name;
        if (!holidays) {
            if (!warnedHolidays && !extra.length) {
                warnedHolidays = true;
                warn('she.time: no holidays configured — set "holidays" (a region such as DE-BW) or "holidaysExtra" in the config; isHoliday() is always false');
            }
            return null;
        }
        return holidayTable.holidaysOfYear(holidays, p.year).get(md) || null;
    }

    const isHoliday = (ts) => holiday(ts) !== null;
    const isWorkday = (ts) => !isWeekend(ts) && !isHoliday(ts);

    function names(kind, style, ts) {
        return formatter(locale, { timeZone, [kind]: style }).format(new Date(ts));
    }

    const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|mm|m|ss|s|SSS|ddd|dd|Z|./gs;

    function format(ts, pattern = 'YYYY-MM-DD HH:mm:ss') {
        const api = 'she.time.format(ts, pattern)';
        const ms = toMs(ts, api);
        if (typeof pattern !== 'string') throw new TypeError(`${api}: pattern must be a string (got ${describe(pattern)})`);
        const p = wallParts(timeZone, ms);
        return pattern.replace(TOKEN, (tok, literal) => {
            if (literal !== undefined) return literal;
            switch (tok) {
                case 'YYYY':
                    return pad(p.year, 4);
                case 'YY':
                    return pad(p.year % 100);
                case 'MMMM':
                    return names('month', 'long', ms);
                case 'MMM':
                    return names('month', 'short', ms);
                case 'MM':
                    return pad(p.month);
                case 'M':
                    return String(p.month);
                case 'DD':
                    return pad(p.day);
                case 'D':
                    return String(p.day);
                case 'HH':
                    return pad(p.hour);
                case 'H':
                    return String(p.hour);
                case 'mm':
                    return pad(p.minute);
                case 'm':
                    return String(p.minute);
                case 'ss':
                    return pad(p.second);
                case 's':
                    return String(p.second);
                case 'SSS':
                    return pad(p.millisecond, 3);
                case 'ddd':
                    return names('weekday', 'long', ms);
                case 'dd':
                    return names('weekday', 'short', ms);
                case 'Z':
                    return offsetString(p.offset);
                default:
                    return tok;
            }
        });
    }

    function iso(ts) {
        const ms = toMs(ts, 'she.time.iso([ts])');
        const p = wallParts(timeZone, ms);
        return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetString(p.offset)}`;
    }

    function duration(a, b) {
        const api = 'she.time.duration(a, b)';
        return toMs(b, api, 'b') - toMs(a, api, 'a');
    }

    const UNITS = [
        ['day', 'd', DAY],
        ['hour', 'h', 3600000],
        ['minute', 'min', 60000],
        ['second', 's', 1000],
    ];

    /**
     * '2 h 40 min' — the two largest non-zero units with the SI-style symbols d, h, min, s;
     * `{ long: true }` spells them out in the locale ('2 Stunden 40 Minuten'); `{ parts: n }`
     * shows up to n units.
     */
    function humanize(ms, options = {}) {
        const api = 'she.time.humanize(ms, [opts])';
        if (typeof ms !== 'number' || Number.isNaN(ms)) throw new TypeError(`${api}: ms must be a number (got ${describe(ms)})`);
        const { long = false, parts: maxParts = 2 } = options;
        const word = (n, unit, symbol) => (long ? new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(n) : `${n} ${symbol}`);
        const sign = ms < 0 ? '-' : '';
        let rest = Math.abs(Math.round(ms));
        if (rest < 1000) return sign + word(rest, 'millisecond', 'ms');
        const out = [];
        let used = 0; // units from the largest non-zero one on, zero ones included: 2 h 0 min 30 s is '2 h'
        for (const [unit, symbol, size] of UNITS) {
            const n = Math.floor(rest / size);
            rest -= n * size;
            if (n > 0 || used) {
                used++;
                if (n > 0) out.push(word(n, unit, symbol));
                if (used >= maxParts) break;
            }
        }
        return sign + out.join(' ');
    }

    return Object.freeze({
        zone: timeZone,
        locale,
        holidays,
        now: () => now(),
        parts,
        at,
        between,
        startOfDay,
        endOfDay,
        addDays,
        isWeekend,
        isHoliday,
        holiday,
        isWorkday,
        format,
        iso,
        duration,
        humanize,
    });
}

/**
 * The validated time settings of a daemon from its config, with one warning per problem.
 * @param {object} config `timezone`, `locale`, `holidays`, `holidaysExtra`
 * @param {Function} [warn] (msg)
 * @returns {{ timeZone: string, locale: string, holidays: string|null, holidaysExtra: Array<{date: string, name: string}> }}
 */
function settingsFromConfig(config = {}, warn = () => {}) {
    let timeZone = systemZone();
    if (config.timezone) {
        if (isZone(config.timezone)) timeZone = config.timezone;
        else warn(`config: timezone "${config.timezone}" is not an IANA time zone — using ${timeZone}`);
    }
    let locale = 'de-DE';
    if (config.locale) {
        if (isLocale(config.locale)) locale = config.locale;
        else warn(`config: locale "${config.locale}" is not a known locale — using ${locale}`);
    }
    let holidays = null;
    if (config.holidays) {
        if (holidayTable.isRegion(config.holidays)) holidays = holidayTable.normalizeRegion(config.holidays);
        else
            warn(
                `config: holidays "${config.holidays}" is not a known region — known: ${holidayTable
                    .listRegions()
                    .map((r) => r.code)
                    .join(', ')}`,
            );
    }
    const parsed = holidayTable.parseExtra(config.holidaysExtra);
    for (const e of parsed.errors) warn(`config: ${e}`);
    return { timeZone, locale, holidays, holidaysExtra: parsed.entries };
}

module.exports = { createTime, settingsFromConfig, wallParts, zonedToInstant, offsetAt, systemZone, isZone, isLocale };
