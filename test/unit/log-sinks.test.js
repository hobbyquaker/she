'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogFile } = require('../../src/lib/log-file');
const { createLogger } = require('../../src/lib/logger');
const logWs = require('../../src/web/log-ws');

describe('createLogger()', () => {
    it('drops lines below the level before redaction and the sinks', () => {
        const redact = jest.fn((s) => s.replace('secret', '***'));
        const sink = jest.fn();
        const log = createLogger({ level: 'info', redact, sinks: [sink] });
        log.debug('a secret');
        expect(redact).not.toHaveBeenCalled();
        expect(sink).not.toHaveBeenCalled();
        log.info('a', 'secret');
        expect(sink).toHaveBeenCalledWith('info', 'a ***');
        log.setLevel('error');
        log.warn('x');
        expect(sink).toHaveBeenCalledTimes(1);
        log.error('y');
        expect(sink).toHaveBeenCalledWith('error', 'y');
        expect(log.level).toBe('error');
    });
});

describe('createLogFile()', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-logfile-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    function wait(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    it('rotates on start and by size, keeping the configured number of files', async () => {
        fs.writeFileSync(path.join(dir, 'she.jsonl'), 'old run\n');
        const f = createLogFile({ dir, maxBytes: 200, keep: 2 });
        expect(fs.readFileSync(path.join(dir, 'she.jsonl.1'), 'utf8')).toBe('old run\n'); // start rotation
        for (let i = 0; i < 12; i++) f.write('info', 'line ' + i + ' ' + 'x'.repeat(40)); // ~70 bytes each → rotates every 3 lines
        f.close();
        await wait(50);
        const files = fs.readdirSync(dir).sort();
        expect(files).toEqual(['she.jsonl', 'she.jsonl.1', 'she.jsonl.2']); // keep 2 → nothing older than .2
        expect(f.files().map((p) => path.basename(p))).toEqual(['she.jsonl', 'she.jsonl.1', 'she.jsonl.2']);
        // the write that crosses the threshold rotates at once: the newest line sits in .1, the current file is fresh
        const lines = ['she.jsonl.2', 'she.jsonl.1', 'she.jsonl']
            .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n'))
            .filter(Boolean)
            .map((l) => JSON.parse(l).msg.split(' ')[1]);
        expect(lines).toEqual(['6', '7', '8', '9', '10', '11']); // the older ones were rotated out (keep 2)
    });
});

describe('log-ws broadcast backlog', () => {
    const { clients, MAX_BACKLOG } = logWs._internal;
    afterEach(() => clients.clear());

    function fakeClient(bufferedAmount) {
        return { OPEN: 1, readyState: 1, bufferedAmount, send: jest.fn(), terminate: jest.fn() };
    }

    it('closes a client whose backlog is above the limit and keeps serving the others', () => {
        const fine = fakeClient(10);
        const stalled = fakeClient(MAX_BACKLOG + 1);
        clients.add(fine);
        clients.add(stalled);
        logWs.broadcastLog({ level: 'info', msg: 'hello', ts: 1 });
        expect(fine.send).toHaveBeenCalledTimes(1);
        expect(stalled.send).not.toHaveBeenCalled();
        expect(stalled.terminate).toHaveBeenCalledTimes(1);
        expect(clients.has(stalled)).toBe(false);
        expect(clients.has(fine)).toBe(true);
    });
});
