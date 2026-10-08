'use strict';

/**
 * The daemon's logger: one level for every sink (roadmap B-12).
 *
 * A line below the configured level is dropped here, before redaction, serialisation
 * and the sinks — the journal (pino), the UI (ring buffer and websocket) and the file.
 * Until B-12 only pino honoured the level; the other two got every debug line.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * @param {{ level?: string, redact?: (s: string) => string, sinks: Array<(level: string, msg: string) => void> }} opts
 */
function createLogger({ level = 'info', redact = (s) => s, sinks = [] }) {
    let threshold = LEVELS[level] ?? LEVELS.info;
    const logger = {};
    for (const name of Object.keys(LEVELS)) {
        logger[name] = (...args) => {
            if (LEVELS[name] < threshold) return;
            const msg = redact(args.join(' '));
            for (const sink of sinks) sink(name, msg);
        };
    }
    logger.setLevel = (l) => {
        threshold = LEVELS[l] ?? LEVELS.info;
    };
    Object.defineProperty(logger, 'level', { get: () => Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) });
    return logger;
}

module.exports = { createLogger, LEVELS };
