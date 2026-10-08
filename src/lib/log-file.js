'use strict';

/**
 * JSON-lines log file with rotation by size (roadmap B-12).
 *
 * `she.jsonl` is rotated on every daemon start and whenever it passes `maxBytes`:
 * `.jsonl` → `.jsonl.1` → … → `.jsonl.<keep>`; the oldest file is dropped.
 * The stream is written without waiting for the disk; what the thread pool has not
 * written yet sits in the stream's buffer, which is transient.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 5;

/**
 * @param {{ dir: string, name?: string, maxBytes?: number, keep?: number }} opts
 */
function createLogFile({ dir, name = 'she.jsonl', maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP }) {
    const current = path.join(dir, name);
    let stream = null;
    let bytes = 0;

    function shift() {
        // .keep is dropped, .(keep-1) → .keep, …, current → .1
        for (let i = keep; i >= 1; i--) {
            const from = i === 1 ? current : `${current}.${i - 1}`;
            const to = `${current}.${i}`;
            try {
                if (i === keep) fs.rmSync(to, { force: true });
                fs.renameSync(from, to);
            } catch {
                /* a missing file in the chain — nothing to move */
            }
        }
    }

    function open() {
        shift();
        if (stream) stream.end();
        // open synchronously: the file must exist and be bound before the next rotation renames it,
        // and a stream opened lazily would bind to whatever carries the name by then
        stream = fs.createWriteStream(null, { fd: fs.openSync(current, 'w') });
        stream.on('error', () => {
            /* the log file is a convenience: a disk error must not take the daemon down */
        });
        bytes = 0;
    }

    open();

    return {
        /** @param {string} level @param {string} msg */
        write(level, msg) {
            const line = JSON.stringify({ level, msg, ts: Date.now() }) + '\n';
            bytes += Buffer.byteLength(line);
            stream.write(line);
            if (bytes >= maxBytes) open();
        },
        /** the files that exist, newest first — what the AI log tool reads */
        files() {
            const list = [];
            for (let i = 0; i <= keep; i++) {
                const f = i === 0 ? current : `${current}.${i}`;
                if (fs.existsSync(f)) list.push(f);
            }
            return list;
        },
        close() {
            if (stream) stream.end();
            stream = null;
        },
        get path() {
            return current;
        },
    };
}

module.exports = { createLogFile, DEFAULT_MAX_BYTES, DEFAULT_KEEP };
