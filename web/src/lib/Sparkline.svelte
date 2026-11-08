<script lang="ts">
    /**
     * One gauge over the last hour: a single-hue line with a hover readout. The samples are the
     * daemon's 10 s history plus the live second-by-second values appended by the page.
     */
    interface Props {
        values: { ts: number; v: number }[];
        width?: number;
        height?: number;
        unit?: string;
        /** the y axis starts at 0 (counts, percentages) rather than at the minimum */
        zero?: boolean;
    }
    let { values, width = 120, height = 28, unit = '', zero = true }: Props = $props();

    const pad = 2;
    let hover = $state<{ x: number; y: number; v: number; ts: number } | null>(null);

    const geom = $derived.by(() => {
        if (values.length < 2) return null;
        const t0 = values[0].ts;
        const t1 = values[values.length - 1].ts;
        const span = Math.max(1, t1 - t0);
        let min = zero ? 0 : Infinity;
        let max = -Infinity;
        for (const s of values) {
            if (s.v < min) min = s.v;
            if (s.v > max) max = s.v;
        }
        if (max === min) max = min + 1;
        const x = (ts: number) => pad + ((ts - t0) / span) * (width - 2 * pad);
        const y = (v: number) => height - pad - ((v - min) / (max - min)) * (height - 2 * pad);
        const pts = values.map((s) => ({ x: x(s.ts), y: y(s.v), v: s.v, ts: s.ts }));
        return { pts, line: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '), area: `${pts[0].x.toFixed(1)},${height} ` + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ` ${pts[pts.length - 1].x.toFixed(1)},${height}`, max, min };
    });

    function onMove(e: MouseEvent) {
        if (!geom) return;
        const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
        const mx = ((e.clientX - rect.left) / rect.width) * width;
        let best = geom.pts[0];
        for (const p of geom.pts) if (Math.abs(p.x - mx) < Math.abs(best.x - mx)) best = p;
        hover = best;
    }
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg class="spark" viewBox="0 0 {width} {height}" width={width} height={height} preserveAspectRatio="none" onmousemove={onMove} onmouseleave={() => (hover = null)} role="img" aria-label={geom ? `${fmt(geom.min)} to ${fmt(geom.max)} ${unit} over the last hour` : 'no history yet'}>
    {#if geom}
        <polygon class="area" points={geom.area} />
        <polyline class="line" points={geom.line} fill="none" />
        {#if hover}
            <line class="cursor" x1={hover.x} x2={hover.x} y1={0} y2={height} />
            <circle class="dot" cx={hover.x} cy={hover.y} r="2.5" />
        {/if}
    {/if}
</svg>
{#if hover}
    <span class="readout">{fmt(hover.v)}{unit ? ' ' + unit : ''} <span class="at">{clock(hover.ts)}</span></span>
{/if}

<style>
    .spark { display: block; width: 100%; height: 28px; overflow: visible; cursor: crosshair; }
    .line { stroke: var(--fg-brand); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
    .area { fill: var(--fg-brand); opacity: 0.12; }
    .cursor { stroke: var(--fg-dim); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .dot { fill: var(--fg-brand); }
    .readout { position: absolute; right: 10px; top: 8px; font-size: 11px; color: var(--fg); background: var(--bg-widget); padding: 1px 5px; border-radius: 3px; font-variant-numeric: tabular-nums; pointer-events: none; }
    .readout .at { color: var(--fg-muted); }
</style>
