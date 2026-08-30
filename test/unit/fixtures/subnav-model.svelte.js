/**
 * The reactive shape every page with a sub-navigation uses (Services, Security, MQTT, DB):
 * a `sub` segment arriving from the router, a local `tab`, an effect steering the tab from
 * the url, and an effect reporting the tab back so the url follows.
 *
 * It is modelled here because the trap is not obvious: an effect that *writes* a state
 * re-runs when that state changes elsewhere — `untrack` does not prevent it, it tracks
 * writes too. Without the seenSub guard the "url -> tab" effect re-enters right after a
 * click, with the url still on the previous slug, and puts the tab straight back — which is
 * exactly the bug that shipped in 1.45.0 (every sub-tab click did nothing).
 */
import { untrack } from 'svelte';

const SLUGS = { instances: 'instances', hosts: 'installations', hostsconf: 'hosts' };
const fromSlug = (slug) => Object.keys(SLUGS).find((t) => SLUGS[t] === slug) ?? null;

export function makePage(initialTab, initialSub, { guard = true } = {}) {
    let tab = $state(initialTab);
    let sub = $state(initialSub); // the `sub` prop
    let hash = $state(initialSub); // what the parent puts in the address bar

    // deliberately not $state: it only remembers what the url last said
    let seenSub;

    const stop = $effect.root(() => {
        // url -> tab
        $effect(() => {
            const s = sub;
            if (guard) {
                if (s === seenSub) return;
                seenSub = s;
            }
            const t = fromSlug(s);
            if (t) {
                untrack(() => {
                    if (t !== tab) tab = t;
                });
            }
        });
        // tab -> url (the parent's setSub: writes the hash and feeds the prop back down)
        $effect(() => {
            const slug = SLUGS[tab];
            untrack(() => {
                if (hash !== slug) {
                    hash = slug;
                    seenSub = slug;
                    sub = slug;
                }
            });
        });
    });

    return {
        click: (t) => {
            tab = t;
        },
        urlTo: (slug) => {
            sub = slug;
        },
        get tab() {
            return tab;
        },
        get hash() {
            return hash;
        },
        stop,
    };
}

/**
 * The other half of the same trap, in the tab-reload wiring: an effect that reloads when
 * another tab reports a change, where load() reads a state it also writes (`refreshing`).
 * Unguarded, the write feeds back into the effect and the tab reloads forever — an endless
 * round of requests to every host. The guard remembers the generation it last acted on.
 */
export function makeReloader({ guard = true, cap = 40 } = {}) {
    let generation = $state(0);
    let refreshing = $state(false);
    let loads = 0;
    let seen = 0;

    async function load(refresh) {
        loads++;
        if (loads > cap) return; // a runaway must not hang the test
        refreshing = refreshing || refresh; // the read-and-write that closes the loop
        await Promise.resolve();
        refreshing = false;
    }

    const stop = $effect.root(() => {
        $effect(() => {
            const g = generation;
            if (guard) {
                if (g === seen) return;
                seen = g;
                untrack(() => load(true));
                return;
            }
            if (g > 0) load(true);
        });
    });

    return {
        change: () => generation++,
        get loads() {
            return loads;
        },
        stop,
    };
}
