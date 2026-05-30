'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORAGE_ROOT = path.join(os.homedir(), '.she');

/**
 * Return the absolute path for a named sub-directory of ~/.she/.
 * The directory is NOT created here — call ensureStorageDir() for that.
 */
function getStoragePath(name) {
    return path.join(STORAGE_ROOT, name);
}

/**
 * Return the path to the shared config file: ~/.she/config.json.
 */
function getConfigPath() {
    return path.join(STORAGE_ROOT, 'config.json');
}

/**
 * Create ~/.she/<name>/ if it does not already exist.
 * Returns the resolved path.
 */
function ensureStorageDir(name) {
    const dir = path.join(STORAGE_ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Create ~/.she/ itself if it does not already exist.
 * Called once at daemon startup before anything else runs.
 */
function ensureRoot() {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
}

module.exports = { STORAGE_ROOT, getStoragePath, getConfigPath, ensureStorageDir, ensureRoot };
