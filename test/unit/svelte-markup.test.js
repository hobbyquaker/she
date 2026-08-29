/**
 * Svelte escapes `{expression}` output, so markup that comes out of an expression is shown to the
 * user as literal tags. It is an easy mistake in a list join —
 *
 *     fill in <span>{missing.join('</span> and <span>')}</span>      // renders the tags as text
 *
 * — and it shipped once (she 1.40.0, DeviceScan). The separators belong in the template:
 *
 *     {#each missing as m, i}{#if i > 0} and {/if}<span>{m}</span>{/each}
 *
 * This scans the components for the pattern rather than rendering them: the UI toolchain lives in
 * web/ and is not resolvable from the root test run, and a source check catches every component
 * instead of the ones a test happens to render.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'web', 'src');

function svelteFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...svelteFiles(p));
        else if (entry.name.endsWith('.svelte')) out.push(p);
    }
    return out;
}

/** The template only: `<script>` and `<style>` are not rendered as markup. */
function template(source) {
    return source.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
}

/**
 * Real markup inside a string literal: a closing tag, or an opening tag carrying an attribute.
 * Deliberately not a bare `<word>` — the UI writes placeholders like `<name>/connected` and
 * `svc-<instance>`, which are meant to reach the user exactly as typed. Splitting markup across a
 * join always needs a closing tag, so requiring one costs nothing and drops the false positives.
 */
const MARKUP_IN_STRING = /(['"`])((?:(?!\1)[\s\S])*?)\1/g;
const LOOKS_LIKE_TAG = /<\/[a-zA-Z][\w-]*\s*>|<[a-zA-Z][\w-]*\s+[a-zA-Z-]+\s*=/;

function offences(source) {
    const found = [];
    for (const mustache of template(source).match(/\{[^{}]*\}/g) ?? []) {
        for (const [, , literal] of mustache.matchAll(MARKUP_IN_STRING)) {
            if (LOOKS_LIKE_TAG.test(literal)) found.push(mustache.trim());
        }
    }
    return found;
}

describe('svelte templates', () => {
    test('no component builds markup inside an expression — svelte would escape it', () => {
        const offenders = [];
        for (const file of svelteFiles(ROOT)) {
            const hits = offences(fs.readFileSync(file, 'utf8'));
            if (hits.length) offenders.push(`${path.relative(ROOT, file)}: ${hits.join(' | ')}`);
        }
        expect(offenders).toEqual([]);
    });

    test('the check actually catches the bug it is here for', () => {
        // the line as it shipped in 1.40.0
        expect(offences(`<p>fill in <span class="mono">{missing.join('</span> and <span class="mono">')}</span> above</p>`)).toHaveLength(1);
        // and the fix does not trip it — `i > 0` and a bare comparison are not markup
        expect(offences(`<p>{#each missing as m, i}{#if i > 0}{i === missing.length - 1 ? ' and ' : ', '}{/if}<span>{m}</span>{/each}</p>`)).toEqual([]);
        expect(offences(`<p>{a < b ? 'x' : 'y'}</p>`)).toEqual([]);
        // script and style are not markup output
        expect(offences(`<script>const s = '</div>';</script><p>{x}</p>`)).toEqual([]);
        // placeholders in angle brackets are text the user is meant to see, not markup
        expect(offences(`<p>{legacy ? 'only a <name>/connected topic' : 'svc-<instance>'}</p>`)).toEqual([]);
    });
});
