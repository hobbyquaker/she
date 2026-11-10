<script lang="ts">
    /**
     * A ring meter: one value against its limit — heap against the heap limit, CPU against one core.
     * The arc fills clockwise from twelve o'clock over a track in a lighter step of the same colour;
     * the number sits in the middle, in the page's ink. A second, lighter arc behind the value shows
     * the highest value of the span the charts cover, when it lies above the current one. Only for
     * real ratios: a rate without a limit gets a number, not a ring.
     */
    interface Props {
        /** the filled share, 0…1; clamped */
        value: number;
        /** the text inside the ring */
        display: string;
        /** the span's highest share, 0…1; drawn only above the value */
        peak?: number | null;
        level?: 'ok' | 'warn' | 'error';
        size?: number;
        /** the whole reading in words, for a screen reader and as the tooltip */
        title?: string;
    }
    let { value, display, peak = null, level = 'ok', size = 104, title = '' }: Props = $props();

    // on a 100 × 100 grid; the size decides how many pixels that is
    const R = 44;
    const CIRC = 2 * Math.PI * R;
    const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    const frac = $derived(clamp(value));
    const peakFrac = $derived(peak === null ? 0 : clamp(peak));
    const dash = (f: number) => `${(f * CIRC).toFixed(2)} ${CIRC.toFixed(2)}`;
</script>

<div class="ring {level}" style:width="{size}px" style:height="{size}px" role="img" aria-label={title || display} title={title || undefined}>
    <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="track" cx="50" cy="50" r={R} />
        {#if peakFrac > frac + 0.001}
            <circle class="peak" cx="50" cy="50" r={R} stroke-dasharray={dash(peakFrac)} stroke-linecap="round" transform="rotate(-90 50 50)" />
        {/if}
        <!-- a round cap at zero would draw a dot at twelve o'clock and claim a value that is not there -->
        <circle class="arc" cx="50" cy="50" r={R} stroke-dasharray={dash(frac)} stroke-linecap={frac > 0.005 ? 'round' : 'butt'} transform="rotate(-90 50 50)" />
    </svg>
    <span class="num">{display}</span>
</div>

<style>
    .ring { --hue: var(--fg-brand); position: relative; flex: 0 0 auto; }
    .ring.warn { --hue: var(--fg-warn); }
    .ring.error { --hue: var(--fg-err); }
    svg { display: block; width: 100%; height: 100%; }
    circle { fill: none; stroke: var(--hue); stroke-width: 10; }
    .track { opacity: 0.16; }
    .peak { opacity: 0.42; }
    .num { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; color: var(--fg-text); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
    @media (prefers-reduced-motion: no-preference) {
        .arc { transition: stroke-dasharray 0.4s ease; }
    }
</style>
