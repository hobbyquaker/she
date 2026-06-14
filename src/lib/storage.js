'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STORAGE_ROOT = process.env.SHE_DATA_DIR || path.join(os.homedir(), '.she');
const CONFIG_ROOT = path.join(STORAGE_ROOT, 'config');
const SCRIPTS_ROOT = path.join(STORAGE_ROOT, 'scripts');
const DB_ROOT = path.join(STORAGE_ROOT, 'db');

/**
 * Return the absolute path for a named sub-directory of ~/.she/.
 * The directory is NOT created here — call ensureStorageDir() for that.
 */
function getStoragePath(name) {
    return path.join(STORAGE_ROOT, name);
}

/**
 * Return the path to the shared config file: ~/.she/config/config.json.
 */
function getConfigPath() {
    return path.join(CONFIG_ROOT, 'config.json');
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
 * Create ~/.she/ and its standard subdirectories if they don't already exist.
 * Called once at daemon startup before anything else runs.
 */
function ensureRoot() {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
    fs.mkdirSync(CONFIG_ROOT, { recursive: true });
    fs.mkdirSync(SCRIPTS_ROOT, { recursive: true });
    fs.mkdirSync(DB_ROOT, { recursive: true });
}

/**
 * Ensure ~/.she/package.json exists so npm can install packages there.
 * Creates a minimal private package.json if missing.
 */
function ensureUserPackageJson() {
    const pkgPath = path.join(STORAGE_ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(
            pkgPath,
            JSON.stringify(
                {
                    name: 'she-user-scripts',
                    version: '1.0.0',
                    private: true,
                    description: 'User-installed npm packages for she scripts',
                    dependencies: {},
                },
                null,
                2,
            ) + '\n',
            'utf8',
        );
    }
    return pkgPath;
}

module.exports = { STORAGE_ROOT, CONFIG_ROOT, SCRIPTS_ROOT, DB_ROOT, getStoragePath, getConfigPath, ensureStorageDir, ensureRoot, ensureUserPackageJson };
