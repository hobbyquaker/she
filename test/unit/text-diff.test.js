'use strict';

const { unifiedDiff } = require('../../src/lib/text-diff');

describe('unifiedDiff()', () => {
    it('shows the changed lines with context and counts them', () => {
        const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
        const b = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'].join('\n');
        const d = unifiedDiff(a, b, { fromName: 'x.js', toName: 'x.js' });
        expect(d.added).toBe(2);
        expect(d.removed).toBe(1);
        expect(d.text).toContain('--- x.js');
        expect(d.text).toContain('-d');
        expect(d.text).toContain('+D');
        expect(d.text).toContain('+h');
        expect(d.text).toMatch(/@@ -1,7 \+1,8 @@/);
    });

    it('is empty for equal texts and whole for a new file', () => {
        expect(unifiedDiff('x\ny', 'x\ny').text).toBe('');
        const d = unifiedDiff('', 'one\ntwo', { fromName: '/dev/null', toName: 'n.js' });
        expect(d.added).toBe(2);
        expect(d.removed).toBe(0);
        expect(d.text).toContain('+one');
    });
});
