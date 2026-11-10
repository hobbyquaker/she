<script lang="ts">
    /**
     * A history chart: one or two lines over a span of time, with what a sparkline lacks — a time
     * axis (the start and the end of the span), a top tick that says what the top of the band means,
     * and a readout under the pointer. The band reaches the peak of what is shown, rounded up to a
     * readable step, so a quiet daemon is not a flat line on the floor; the tick keeps that honest.
     *
     * Drawn at its real pixel width, so strokes and text keep their size. A day of minutes is more
     * points than the chart has pixels: every pixel column takes the highest value that falls into
     * it, so a spike survives. Where samples are missing (a restart) the line breaks.
     *
     * The span selector under the chart is bound by the page to one value, so every chart on the
     * page shows the same span.
     */
    import { SPANS, bucketMax, hhmm, niceTop, runs, spanLabel, type Point } from './history.js';

    interface Series {
        label: string;
        points: Point[];
        /** a CSS colour, e.g. `var(--fg-brand)` */
        color: string;
        /** a wash under the line */
        fill?: boolean;
    }
    interface Props {
        series: Series[];
        /** what the chart shows, for a screen reader */
        label: string;
        /** written after a value: "MB", "%", "ms" */
        unit?: string;
        /** the span shown, in minutes; bindable — the selector sets it */
        span?: number;
        /** the right edge of the time axis (ms) */
        end: number;
        height?: number;
        /** draw the first series as bars this many ms wide (its points are the bars' starts) */
        barMs?: number;
        /** the lowest top the band has, whatever the data */
        minTop?: number;
        /** a limit as a dashed line; above the band it is only named at the top edge with an arrow */
        threshold?: { value: number; label: string } | null;
        format?: (v: number) => string;
    }
    let { series, label, unit = '', span = $bindable(1440), end, height = 78, barMs = 0, minTop = 1, threshold = null, format = (v: number) => (v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)) }: Props = $props();

    let width = $state(0);
    const TOP = 14; // room for the tick label above the gridline
    const bottom = $derived(height - 1);

    const t0 = $derived(end - span * 60_000);
    const drawn = $derived(series.map((s) => (barMs ? s.points.filter((p) => p.ts + barMs > t0 && p.ts <= end) : bucketMax(s.points, t0, end, width))));
    const top = $derived(niceTop(Math.max(0, ...drawn.flat().map((p) => p.v)) * 1.05, minTop));
    const x = (ts: number) => ((ts - t0) / (end - t0)) * width;
    const y = (v: number) => bottom - (Math.max(0, Math.min(top, v)) / top) * (bottom - TOP);
    const any = $derived(drawn.some((d) => d.length > 0));

    // two neighbours are joined unless more than two samples are missing between them
    const gapMs = $derived(Math.max(150_000, (2.5 * (end - t0)) / Math.max(1, width)));
    const lines = $derived(
        barMs
            ? []
            : drawn.map((pts, i) => ({
                  color: series[i].color,
                  fill: !!series[i].fill,
                  last: pts.length ? pts[pts.length - 1] : null,
                  runs: runs(pts, gapMs).map((run) => {
                      const d = run.map((p) => `${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
                      return { d, area: `${x(run[0].ts).toFixed(1)},${bottom} ${d} ${x(run[run.length - 1].ts).toFixed(1)},${bottom}`, lone: run.length === 1 ? run[0] : null };
                  }),
              })),
    );
    const bars = $derived(
        barMs
            ? drawn[0]
                  .filter((p) => p.v > 0)
                  .map((p) => {
                      const x0 = Math.max(0, x(p.ts));
                      const x1 = Math.min(width, x(p.ts + barMs));
                      return { x: x0 + 0.5, w: Math.max(1.5, x1 - x0 - 1), y: y(p.v), ts: p.ts };
                  })
            : [],
    );
    const thrIn = $derived(threshold !== null && threshold.value <= top);

    // the reading under the pointer: the nearest point of the first series, the others at its time
    let hover = $state<{ x: number; ts: number; values: (number | null)[] } | null>(null);
    function pick(ev: PointerEvent) {
        const box = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
        const px = ev.clientX - box.left;
        if (barMs) {
            const ts = Math.floor((t0 + (px / width) * (end - t0)) / barMs) * barMs;
            const hit = drawn[0].find((p) => p.ts === ts);
            hover = { x: Math.max(0, Math.min(width, x(ts + barMs / 2))), ts, values: [hit ? hit.v : 0] };
            return;
        }
        let best: Point | null = null;
        let bd = Infinity;
        for (const pts of drawn) {
            for (const p of pts) {
                const d = Math.abs(x(p.ts) - px);
                if (d < bd) {
                    bd = d;
                    best = p;
                }
            }
            if (best) break;
        }
        if (!best) {
            hover = null;
            return;
        }
        const at = best.ts;
        const values = drawn.map((pts) => {
            let near: Point | null = null;
            for (const p of pts) if (near === null || Math.abs(p.ts - at) < Math.abs(near.ts - at)) near = p;
            return near && Math.abs(near.ts - at) <= gapMs ? near.v : null;
        });
        hover = { x: x(at), ts: at, values };
    }
    function leave(ev: PointerEvent) {
        // a mouse leaving clears the marker; a finger lifting keeps it where it tapped
        if (ev.pointerType === 'mouse') hover = null;
    }
    function choose(m: number) {
        span = m;
        hover = null;
    }
    const u = $derived(unit ? ' ' + unit : '');
    const hoverText = $derived.by(() => {
        if (!hover) return '';
        const when = barMs ? `${hhmm(hover.ts)}–${hhmm(hover.ts + barMs)}` : hhmm(hover.ts);
        return `${when} · ` + hover.values.map((v) => (v === null ? '—' : format(v) + u)).join(' / ');
    });
</script>

<div class="chart" bind:clientWidth={width}>
    {#if width > 0}
        <svg {width} {height} viewBox="0 0 {width} {height}" role="img" aria-label="{label}, last {spanLabel(span)}" onpointermove={pick} onpointerdown={pick} onpointerleave={leave}>
            <line class="grid" x1="0" x2={width} y1={TOP + 0.5} y2={TOP + 0.5} />
            <line class="base" x1="0" x2={width} y1={bottom + 0.5} y2={bottom + 0.5} />
            {#if threshold && thrIn}<line class="thr" x1="0" x2={width} y1={y(threshold.value) + 0.5} y2={y(threshold.value) + 0.5} />{/if}
            {#each lines as line, i (i)}
                {#each line.runs as run, j (j)}
                    {#if run.lone}
                        <circle cx={x(run.lone.ts)} cy={y(run.lone.v)} r="2" fill={line.color} />
                    {:else}
                        {#if line.fill}<polygon class="wash" points={run.area} fill={line.color} />{/if}
                        <polyline class="line" points={run.d} stroke={line.color} />
                    {/if}
                {/each}
                {#if line.last}<circle class="end" cx={Math.min(width - 3, x(line.last.ts))} cy={y(line.last.v)} r="2.5" fill={line.color} />{/if}
            {/each}
            {#each bars as b (b.ts)}
                <rect x={b.x} y={b.y} width={b.w} height={bottom - b.y} fill={series[0].color} rx="1" />
            {/each}
            <text class="tick" x="2" y={TOP - 3}>{format(top)}{u}</text>
            {#if threshold}
                <text class="tick thr-label" x={width - 2} y={thrIn && y(threshold.value) - 3 > TOP + 10 ? y(threshold.value) - 3 : TOP - 3} text-anchor="end">{threshold.label}{thrIn ? '' : ' ↑'}</text>
            {/if}
            {#if hover}
                <line class="cursor" x1={hover.x} x2={hover.x} y1={TOP} y2={bottom} />
                {#if !barMs}
                    {#each hover.values as v, i (i)}
                        {#if v !== null}<circle class="marker" cx={hover.x} cy={y(v)} r="3.5" stroke={series[i].color} />{/if}
                    {/each}
                {/if}
            {/if}
        </svg>
        {#if !any}<div class="empty" style:height="{height}px">no history yet</div>{/if}
        {#if hover}
            <div class="tip" style:left="{Math.max(70, Math.min(width - 70, hover.x))}px">{hoverText}</div>
        {/if}
    {:else}
        <div style:height="{height}px"></div>
    {/if}
    <div class="axis">
        <span>{hhmm(t0)}</span>
        <span class="spans" role="group" aria-label="Time span of every chart">
            {#each SPANS as m (m)}
                <button type="button" aria-pressed={m === span} onclick={() => choose(m)}>{spanLabel(m)}</button>
            {/each}
        </span>
        <span>{hhmm(end)}</span>
    </div>
</div>

<style>
    .chart { position: relative; width: 100%; min-width: 0; }
    svg { display: block; overflow: hidden; touch-action: pan-y; cursor: crosshair; }
    .grid { stroke: var(--border); stroke-dasharray: 3 3; }
    .base { stroke: var(--border); }
    .thr { stroke: var(--fg-err); stroke-dasharray: 4 3; opacity: 0.8; }
    .line { fill: none; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
    .wash { opacity: 0.13; stroke: none; }
    /* a halo in the tile's colour, so a line that runs behind a label does not strike it through */
    .tick { font-size: 11px; fill: var(--fg-muted); pointer-events: none; font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--bg-panel); stroke-width: 3px; stroke-linejoin: round; }
    .tick.thr-label { fill: var(--fg-err); }
    .cursor { stroke: var(--fg-dim); }
    .marker { fill: var(--bg-panel); stroke-width: 2; }
    .empty { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: center; color: var(--fg-dim); font-size: 12px; pointer-events: none; }
    .tip { position: absolute; top: 14px; transform: translate(-50%, -100%); pointer-events: none; background: var(--bg-widget); color: var(--fg-text); border: 1px solid var(--border); border-radius: 5px; padding: 2px 8px; font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; z-index: 2; }
    .axis { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; color: var(--fg-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .spans { display: inline-flex; gap: 2px; }
    .spans button { font: inherit; font-size: 12px; color: var(--fg-muted); background: none; border: 0; border-radius: 4px; padding: 1px 7px; cursor: pointer; }
    .spans button:hover { color: var(--fg); background: var(--bg-hover); }
    .spans button[aria-pressed='true'] { color: var(--fg-brand); background: color-mix(in srgb, var(--fg-brand) 15%, transparent); }
    .spans button:focus-visible { outline: 2px solid var(--fg-brand); outline-offset: 2px; }
</style>
