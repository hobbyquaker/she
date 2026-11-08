'use strict';
/**
 * Where in a script a registration came from: the first stack frame that lies in the script's own
 * file. The sandbox APIs call this when a script registers a subscription, a schedule or a timer, so
 * the editor's Runtime panel can jump to the line. Frames of the daemon (index.js, the sandbox
 * modules, the timing library) are skipped — a `she.mqtt.timer()` call reports the script line that
 * called it, not the stdlib line that subscribed on its behalf.
 *
 * Cost: one `new Error()` with its stack captured — tens of microseconds. Registrations happen at
 * load and a few times a second at most; the timing helpers capture once when the helper is created,
 * not on every re-arm.
 */

const FRAME_DEPTH = 30;

/**
 * @param {string} file the script's file name as given to `new vm.Script`
 * @returns {{line: number, column: number}|null}
 */
function callerLine(file) {
    if (!file) return null;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = FRAME_DEPTH;
    const { stack } = new Error();
    Error.stackTraceLimit = limit;
    return parseStack(stack, file);
}

/**
 * @param {string} stack an Error's stack
 * @param {string} file
 * @returns {{line: number, column: number}|null}
 */
function parseStack(stack, file) {
    if (typeof stack !== 'string') return null;
    const needle = file + ':';
    for (const frame of stack.split('\n')) {
        const i = frame.indexOf(needle);
        if (i === -1) continue;
        // the file name must start a location: "(file:l:c)" or "at file:l:c" — not be the tail of a
        // longer path (".../otherdir/file")
        const before = frame[i - 1];
        if (before !== '(' && before !== ' ' && before !== undefined) continue;
        const m = /^(\d+):(\d+)\)?\s*$/.exec(frame.slice(i + needle.length));
        if (!m) continue;
        return { line: Number(m[1]), column: Number(m[2]) };
    }
    return null;
}

module.exports = { callerLine, parseStack };
