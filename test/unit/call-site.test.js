'use strict';

const vm = require('vm');
const { callerLine, parseStack } = require('../../src/lib/call-site');

describe('parseStack()', () => {
    const file = '/home/u/.she/scripts/licht/bath.js';
    it('finds the first frame in the script, in both frame shapes', () => {
        const stack = [
            'Error',
            '    at callerLine (/opt/she/src/lib/call-site.js:20:19)',
            '    at Sandbox_mqttsub (/opt/she/src/index.js:1200:30)',
            `    at Object.sub (/opt/she/src/sandbox/stdlib.js:40:33)`,
            `    at ${file}:12:9`,
            `    at onMotion (${file}:30:5)`,
        ].join('\n');
        expect(parseStack(stack, file)).toEqual({ line: 12, column: 9 });
    });

    it('does not take a longer path that ends in the file name', () => {
        const stack = ['Error', `    at fn (/other/dir${file}:3:4)`, `    at fn (${file}:7:8)`].join('\n');
        expect(parseStack(stack, file)).toEqual({ line: 7, column: 8 });
    });

    it('null without a frame in the file, or without a stack', () => {
        expect(parseStack('Error\n    at x (/opt/she/src/index.js:1:1)', file)).toBeNull();
        expect(parseStack(undefined, file)).toBeNull();
        expect(callerLine('')).toBeNull();
    });
});

describe('callerLine() from a vm script', () => {
    it('reports the line of the sandboxed call, skipping the daemon frames', () => {
        const file = '/scripts/test.js';
        const seen = [];
        const api = {
            register() {
                // one daemon frame between the script and the capture, like a sandbox module
                const inner = () => callerLine(file);
                seen.push(inner());
            },
        };
        const script = new vm.Script('api.register();\n\n\napi.register();\nfunction later() { api.register(); }\nlater();', { filename: file });
        script.runInContext(vm.createContext({ api }));
        expect(seen).toEqual([
            { line: 1, column: 5 },
            { line: 4, column: 5 },
            { line: 5, column: 24 },
        ]);
    });

    it('costs tens of microseconds per capture', () => {
        const file = '/scripts/cost.js';
        const script = new vm.Script('for (let i = 0; i < 2000; i++) api.register();', { filename: file });
        const ctx = vm.createContext({ api: { register: () => callerLine(file) } });
        script.runInContext(ctx); // warm up
        const t0 = process.hrtime.bigint();
        script.runInContext(ctx);
        const perCall = Number(process.hrtime.bigint() - t0) / 2000 / 1000; // µs
        expect(perCall).toBeLessThan(500); // generous for a slow CI box; typically well under 50 µs
    });
});
