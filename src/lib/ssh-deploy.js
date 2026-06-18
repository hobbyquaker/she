'use strict';

/**
 * ssh-deploy.js — SSH/SFTP file deployment helper for remote broker management.
 *
 * Uses the `ssh2` npm package for SFTP uploads and remote command execution.
 * SSH keypair generation delegates to the `ssh-keygen` CLI tool.
 *
 * Usage:
 *   const ssh = require('./ssh-deploy');
 *   await ssh.uploadFile(sshConfig, localPath, remotePath);
 *   const { stdout } = await ssh.runCommand(sshConfig, 'sudo systemctl reload mosquitto');
 *   const pubkey = await ssh.generateKeypair(identityFile);
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);

// ssh2 is an optional dependency — only loaded when needed
let _ssh2 = null;
function getSsh2() {
    if (!_ssh2) {
        try {
            _ssh2 = require('ssh2');
        } catch {
            throw new Error('ssh2 package not installed — run: npm install ssh2');
        }
    }
    return _ssh2;
}

function expandHome(p) {
    if (typeof p === 'string' && (p.startsWith('~/') || p === '~')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

/**
 * Build ssh2 connection options from she broker.ssh config.
 * @param {object} sshConfig - config.broker.ssh
 */
function buildConnectOpts(sshConfig) {
    const identityFile = expandHome(sshConfig.identityFile || '~/.she/broker_id_ed25519');
    let privateKey;
    try {
        privateKey = fs.readFileSync(identityFile);
    } catch (err) {
        throw new Error(`Cannot read SSH identity file ${identityFile}: ${err.message}`);
    }

    return {
        host: sshConfig.host,
        port: sshConfig.port || 22,
        username: sshConfig.user || 'she',
        privateKey,
        readyTimeout: 10000,
        keepaliveInterval: 0,
    };
}

/**
 * Connect to the remote host, execute a command, and return stdout/stderr.
 * @param {object} sshConfig - config.broker.ssh
 * @param {string} command
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runCommand(sshConfig, command) {
    const { Client } = getSsh2();
    const opts = buildConnectOpts(sshConfig);

    return new Promise((resolve, reject) => {
        const conn = new Client();
        let stdout = '';
        let stderr = '';

        conn.on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                stream.on('close', (code) => {
                    conn.end();
                    if (code !== 0) {
                        reject(new Error(`Remote command exited ${code}: ${stderr.trim() || stdout.trim()}`));
                    } else {
                        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
                    }
                });
                stream.on('data', (d) => {
                    stdout += d.toString();
                });
                stream.stderr.on('data', (d) => {
                    stderr += d.toString();
                });
            });
        });

        conn.on('error', reject);
        conn.connect(opts);
    });
}

/**
 * Upload a local file to the remote host via SFTP.
 * @param {object} sshConfig
 * @param {string} localPath
 * @param {string} remotePath
 */
function uploadFile(sshConfig, localPath, remotePath) {
    const { Client } = getSsh2();
    const opts = buildConnectOpts(sshConfig);

    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on('ready', () => {
            conn.sftp((err, sftp) => {
                if (err) {
                    conn.end();
                    return reject(err);
                }
                sftp.fastPut(localPath, remotePath, (err2) => {
                    conn.end();
                    if (err2) reject(err2);
                    else resolve();
                });
            });
        });
        conn.on('error', reject);
        conn.connect(opts);
    });
}

/**
 * Upload a string as file content to the remote host.
 * @param {object} sshConfig
 * @param {string} content
 * @param {string} remotePath
 */
async function uploadContent(sshConfig, content, remotePath) {
    // Write to a temp file, then SFTP upload, then delete temp
    const tmp = path.join(os.tmpdir(), `she-ssh-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, content, 'utf8');
    try {
        await uploadFile(sshConfig, tmp, remotePath);
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
    }
}

/**
 * Test SSH connectivity. Resolves to { ok: true } on success, or throws.
 * @param {object} sshConfig
 */
function testConnection(sshConfig) {
    return runCommand(sshConfig, 'echo ok').then(() => ({ ok: true }));
}

/**
 * Generate an Ed25519 SSH keypair using the system ssh-keygen binary.
 * @param {string} identityFile - path for the private key (e.g. ~/.she/broker_id_ed25519)
 * @returns {Promise<string>} the public key text
 */
async function generateKeypair(identityFile) {
    const expandedPath = expandHome(identityFile || '~/.she/broker_id_ed25519');
    const dir = path.dirname(expandedPath);
    fs.mkdirSync(dir, { recursive: true });

    // Remove existing key if present
    try {
        fs.unlinkSync(expandedPath);
    } catch {
        /* ok */
    }
    try {
        fs.unlinkSync(expandedPath + '.pub');
    } catch {
        /* ok */
    }

    await execFileAsync(
        'ssh-keygen',
        [
            '-t',
            'ed25519',
            '-f',
            expandedPath,
            '-N',
            '', // no passphrase
            '-C',
            'she-broker',
        ],
        { timeout: 15000 },
    );

    try {
        fs.chmodSync(expandedPath, 0o600);
    } catch {
        /* ignore */
    }

    const pubkey = fs.readFileSync(expandedPath + '.pub', 'utf8');
    return pubkey.trim();
}

module.exports = { runCommand, uploadFile, uploadContent, testConnection, generateKeypair };
