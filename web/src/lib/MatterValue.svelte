<script lang="ts">
    /**
     * One Matter attribute value, readable: byte strings as hex (long ones folded), hardware
     * addresses as MAC/EUI-64, IP addresses as addresses, operational certificates as subject,
     * issuer, validity, extensions and PEM, lists and structs recursively. The server sends bytes
     * as `{ $bytes: "<hex>" }` and certificates as `{ $cert: {…} }` (src/matter/controller.js).
     */
    import Self from './MatterValue.svelte';

    let { value, name = '' }: { value: unknown; name?: string } = $props();

    interface Cert {
        kind: string;
        subject: Record<string, unknown>;
        issuer: Record<string, unknown>;
        subjectDn: string;
        issuerDn: string;
        serialNumber: string;
        validFrom: string;
        validTo: string;
        ca: boolean;
        extensions: Record<string, unknown>;
        fingerprint: string;
        pem: string;
    }

    /** RFC 5280 / Matter's extendedKeyUsage numbers */
    const EKU: Record<number, string> = {
        1: 'serverAuth',
        2: 'clientAuth',
        3: 'codeSigning',
        4: 'emailProtection',
        5: 'timeStamping',
        6: 'OCSPSigning',
    };
    const FOLD_BYTES = 16;

    const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
    const bytesOf = (v: unknown): string | null => (isObj(v) && typeof v.$bytes === 'string' ? v.$bytes : null);
    const certOf = (v: unknown): Cert | null => (isObj(v) && isObj(v.$cert) ? (v.$cert as unknown as Cert) : null);

    function pairs(hex: string): string[] {
        return hex.match(/../g) ?? [];
    }

    /** a byte string as the kind of value its attribute name says it is */
    function fmtBytes(hex: string, key: string): string {
        const b = pairs(hex);
        const k = key.toLowerCase();
        if (k.includes('hardwareaddress') || k.includes('macaddress') || k.includes('extendedaddress')) {
            return b.join(':');
        }
        if (k.includes('ipv4') && b.length === 4) {
            return b.map((x) => parseInt(x, 16)).join('.');
        }
        if (k.includes('ipv6') && b.length === 16) {
            const groups = [];
            for (let i = 0; i < 16; i += 2) groups.push(parseInt(b[i] + b[i + 1], 16).toString(16));
            // the longest run of zero groups becomes "::"
            const s = groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
            return s.replace(/:{3,}/, '::');
        }
        return b.join(' ');
    }

    function fmtScalar(v: unknown): string {
        if (v === null || v === undefined) return '—';
        return typeof v === 'string' ? v : String(v);
    }

    function fmtDate(iso: string): string {
        // Matter's "no well-defined expiration" is X.509's 99991231235959Z
        if (iso.startsWith('9999-12-31')) return 'no expiry';
        const d = new Date(iso);
        return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    function fmtExtension(key: string, v: unknown): string {
        if (key === 'keyUsage' && isObj(v)) {
            return Object.entries(v).filter(([, on]) => on === true).map(([k]) => k).join(', ') || '—';
        }
        if (key === 'extendedKeyUsage' && Array.isArray(v)) {
            return v.map((n) => EKU[n as number] ?? String(n)).join(', ');
        }
        if (key === 'basicConstraints' && isObj(v)) {
            return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ');
        }
        const hex = bytesOf(v);
        if (hex !== null) return pairs(hex).join(':');
        return isObj(v) || Array.isArray(v) ? JSON.stringify(v) : fmtScalar(v);
    }

    function fields(o: Record<string, unknown>): string {
        return Object.entries(o).map(([k, v]) => `${k} ${fmtScalar(v)}`).join(' · ');
    }

    let copied = $state(false);
    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            setTimeout(() => (copied = false), 1500);
        } catch {
            // no clipboard (http, permissions): the PEM is selectable below
        }
    }
</script>

{#if certOf(value)}
    {@const c = certOf(value)!}
    <details class="mv-cert">
        <summary>
            <span class="mv-kind">{c.kind}</span>
            <span class="mv-dim">{fields(c.subject)}</span>
            <span class="mv-dim">· valid {fmtDate(c.validFrom)} – {fmtDate(c.validTo)}</span>
        </summary>
        <table class="mv-table">
            <tbody>
                <tr><td class="mv-key">subject</td><td>{c.subjectDn}</td></tr>
                <tr><td class="mv-key">issuer</td><td>{c.issuerDn}</td></tr>
                <tr><td class="mv-key">serial number</td><td>{c.serialNumber}</td></tr>
                <tr><td class="mv-key">valid from</td><td>{c.validFrom}</td></tr>
                <tr><td class="mv-key">valid to</td><td>{c.validTo.startsWith('9999-12-31') ? 'no expiry (9999-12-31)' : c.validTo}</td></tr>
                <tr><td class="mv-key">CA</td><td>{c.ca ? 'yes' : 'no'}</td></tr>
                {#each Object.entries(c.extensions ?? {}) as [k, v]}
                    <tr><td class="mv-key">{k}</td><td>{fmtExtension(k, v)}</td></tr>
                {/each}
                <tr><td class="mv-key">SHA-256</td><td>{c.fingerprint}</td></tr>
            </tbody>
        </table>
        <div class="mv-pem-head">
            <span class="mv-key">PEM</span>
            <button class="mv-copy" onclick={() => copy(c.pem)}>{copied ? 'copied' : 'copy'}</button>
        </div>
        <pre class="mv-pem">{c.pem}</pre>
    </details>
{:else if bytesOf(value) !== null}
    {@const hex = bytesOf(value)!}
    {@const text = fmtBytes(hex, name)}
    {#if text === pairs(hex).join(' ') && pairs(hex).length > FOLD_BYTES}
        <details class="mv-bytes">
            <summary>{pairs(hex).slice(0, FOLD_BYTES).join(' ')} … <span class="mv-dim">({pairs(hex).length} bytes)</span></summary>
            <span class="mv-hex">{text}</span>
        </details>
    {:else}
        <span class="mv-hex">{text}</span>
    {/if}
{:else if Array.isArray(value)}
    {#if value.length === 0}
        <span class="mv-dim">—</span>
    {:else if value.every((x) => !isObj(x) && !Array.isArray(x))}
        <span class="mv-scalar">{value.map(fmtScalar).join(', ')}</span>
    {:else}
        <ul class="mv-list">
            {#each value as item}
                <li><Self value={item} {name} /></li>
            {/each}
        </ul>
    {/if}
{:else if isObj(value)}
    <table class="mv-table">
        <tbody>
            {#each Object.entries(value) as [k, v]}
                <tr><td class="mv-key">{k}</td><td><Self value={v} name={k} /></td></tr>
            {/each}
        </tbody>
    </table>
{:else}
    <span class="mv-scalar">{fmtScalar(value)}</span>
{/if}

<style>
    .mv-scalar,
    .mv-hex {
        color: var(--fg-value);
        font-family: monospace;
        overflow-wrap: anywhere;
    }
    .mv-dim {
        color: var(--fg-dim);
    }
    .mv-kind {
        color: var(--fg-value);
        font-weight: 600;
        margin-right: 6px;
    }
    .mv-key {
        color: var(--fg-muted);
        padding: 0 8px 0 0;
        white-space: nowrap;
        vertical-align: top;
    }
    .mv-table {
        border-collapse: collapse;
        font-size: 11px;
        font-family: monospace;
    }
    .mv-table td {
        padding: 1px 8px 1px 0;
        vertical-align: top;
        overflow-wrap: anywhere;
    }
    .mv-list {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .mv-list > li + li {
        border-top: 1px solid var(--border-sub);
        margin-top: 2px;
        padding-top: 2px;
    }
    details > summary {
        cursor: pointer;
        font-family: monospace;
        font-size: 11px;
        overflow-wrap: anywhere;
    }
    .mv-pem-head {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 4px;
        font-size: 11px;
        font-family: monospace;
    }
    .mv-copy {
        padding: 0 6px;
        font-size: 10px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--bg-input, #2a2a2a);
        color: var(--fg);
        cursor: pointer;
    }
    .mv-pem {
        margin: 2px 0 0;
        font-size: 10px;
        color: var(--fg-value);
        user-select: all;
        white-space: pre;
        overflow-x: auto;
    }
</style>
