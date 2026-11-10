/** The arithmetic of the history charts: the span shown, the top of the band, a point per pixel. */

export interface Point {
    ts: number;
    v: number;
}

/** The spans the Runtime page offers, in minutes. */
export const SPANS = [60, 360, 1440];

/** 60 → "1 h", 1440 → "24 h", 30 → "30 min" */
export function spanLabel(minutes: number): string {
    return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** "14:05" */
export function hhmm(ts: number): string {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * The top of a chart's band: the peak rounded up to a step a reader can do sums with — 1, 2, 2.5
 * or 5 times a power of ten — so the tick says "50 ms" and not "46.3 ms".
 */
export function niceTop(peak: number, min = 1): number {
    const v = Math.max(peak, min);
    if (!(v > 0) || !Number.isFinite(v)) return min > 0 ? min : 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) {
        // the product is rounded: 2.5 × 0.1 is not 0.25 in floating point
        const step = Number((m * exp).toPrecision(3));
        if (step >= v) return step;
    }
    return 10 * exp;
}

/**
 * At most one point per pixel column over [t0, t1]: every column takes the **highest** value that
 * falls into it, so a spike of one minute is still there when a day is drawn on 400 pixels.
 * @returns the points with their x in pixels, oldest first
 */
export function bucketMax(points: Point[], t0: number, t1: number, width: number): (Point & { x: number })[] {
    const cols = Math.max(1, Math.floor(width));
    const range = t1 - t0;
    if (range <= 0) return [];
    const out: (Point & { x: number })[] = [];
    let col = -1;
    for (const p of points) {
        if (p.ts < t0 || p.ts > t1) continue;
        const x = ((p.ts - t0) / range) * width;
        const c = Math.min(cols - 1, Math.floor(x));
        if (c !== col) {
            out.push({ ts: p.ts, v: p.v, x });
            col = c;
        } else if (p.v > out[out.length - 1].v) {
            // the spike keeps its own time, so the readout names the minute it happened in
            out[out.length - 1] = { ts: p.ts, v: p.v, x: out[out.length - 1].x };
        }
    }
    return out;
}

/**
 * Cut a series where time is missing (the daemon was down, the page of a fresh start): a line
 * across the hole would draw values nobody measured.
 * @param gapMs two neighbours further apart than this are not joined
 */
export function runs<T extends Point>(points: T[], gapMs: number): T[][] {
    const out: T[][] = [];
    let cur: T[] = [];
    for (const p of points) {
        if (cur.length && p.ts - cur[cur.length - 1].ts > gapMs) {
            out.push(cur);
            cur = [];
        }
        cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
}

/** The highest value of a series from `since` on; null when it has none. */
export function peakOf(points: Point[], since: number): number | null {
    let max: number | null = null;
    for (const p of points) if (p.ts >= since && (max === null || p.v > max)) max = p.v;
    return max;
}

/** Add a series up into bars of `barMs`, aligned to the clock: [{ ts: start of the bar, v: sum }]. */
export function sumBars(points: Point[], barMs: number): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        const start = Math.floor(p.ts / barMs) * barMs;
        const last = out[out.length - 1];
        if (last && last.ts === start) last.v += p.v;
        else out.push({ ts: start, v: p.v });
    }
    return out;
}

/** For every point the sum of the values in the `windowMs` that end with it. */
export function rollingSum(points: Point[], windowMs: number): Point[] {
    const out: Point[] = [];
    let sum = 0;
    let from = 0;
    for (let i = 0; i < points.length; i++) {
        sum += points[i].v;
        while (points[from].ts <= points[i].ts - windowMs) sum -= points[from++].v;
        out.push({ ts: points[i].ts, v: sum });
    }
    return out;
}
