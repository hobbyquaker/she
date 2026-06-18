'use strict';

/**
 * ssh-deploy.js — SSH/SCP file deployment helper for remote broker management.
 *
 * Shells out to the system ssh and scp clients — no npm dependencies required.
 * SSH keypair generation uses the system ssh-keygen binary.
 *
 * Requires ssh, scp, and ssh-keygen available in PATH on the she host.
 *
 * StrictHostKeyChecking=accept-new trusts new hosts on first connect and
 * verifies the key on subsequent connections, protecting against MITM after
 * the initial handshake without blocking automation.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);

function expandHome(p) {
    if (typeof p === 'string' && (p.startsWith('~/') || p === '~')) {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

/**
 * Build the common ssh argument list (flags only, no target/command).
 * @param {object} sshConfig - config.broker.ssh
 * @returns {string[]}
 */
function sshArgs(sshConfig) {
    const identityFile = expandHome(sshConfig.identityFile || '~/.she/ssh/broker_id_ed25519');
    return ['-i', identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(sshConfig.port || 22)];
}

/**
 * Build the scp argument list prefix.
 * scp uses -P (capital) for port, unlike ssh which uses -p.
 * @param {object} sshConfig
 * @returns {string[]}
 */
function scpArgs(sshConfig) {
    const identityFile = expandHome(sshConfig.identityFile || '~/.she/ssh/broker_id_ed25519');
    return ['-i', identityFile, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(sshConfig.port || 22)];
}

function sshTarget(sshConfig) {
    return `${sshConfig.user || 'she'}@${sshConfig.host}`;
}

/**
 * Run a command on the remote host via the system ssh client.
 * @param {object} sshConfig - config.broker.ssh
 * @param {string} command
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runCommand(sshConfig, command) {
    const args = [...sshArgs(sshConfig), sshTarget(sshConfig), command];
    try {
        const { stdout, stderr } = await execFileAsync('ssh', args, { timeout: 15000 });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err) {
        const detail = (err.stderr || '').trim() || (err.stdout || '').trim() || err.message;
        throw new Error(detail);
    }
}

/**
 * Read the content of a file on the remote host via ssh cat.
 * @param {object} sshConfig
 * @param {string} remotePath
 * @returns {Promise<string>}
 */
async function readRemoteFile(sshConfig, remotePath) {
    const { stdout } = await runCommand(sshConfig, `cat -- "${remotePath}"`);
    return stdout;
}

/**
 * Upload a local file to the remote host via scp.
 * @param {object} sshConfig
 * @param {string} localPath
 * @param {string} remotePath
 */
async function uploadFile(sshConfig, localPath, remotePath) {
    const args = [...scpArgs(sshConfig), localPath, `${sshTarget(sshConfig)}:${remotePath}`];
    try {
        await execFileAsync('scp', args, { timeout: 30000 });
    } catch (err) {
        const detail = (err.stderr || '').trim() || err.message;
        throw new Error(detail);
    }
}

/**
 * Upload a string as file content to the remote host.
 * Writes to a local temp file then uploads via scp.
 * @param {object} sshConfig
 * @param {string} content
 * @param {string} remotePath
 */
async function uploadContent(sshConfig, content, remotePath) {
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
async function testConnection(sshConfig) {
    await runCommand(sshConfig, 'echo ok');
    return { ok: true };
}

/**
 * Generate an Ed25519 SSH keypair using the system ssh-keygen binary.
 * @param {string} identityFile - path for the private key (e.g. ~/.she/broker_id_ed25519)
 * @returns {Promise<string>} the public key text
 */
async function generateKeypair(identityFile) {
    const expandedPath = expandHome(identityFile || '~/.she/ssh/broker_id_ed25519');
    const dir = path.dirname(expandedPath);
    fs.mkdirSync(dir, { recursive: true });

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

    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', expandedPath, '-N', '', '-C', 'she-broker'], { timeout: 15000 });

    try {
        fs.chmodSync(expandedPath, 0o600);
    } catch {
        /* ignore */
    }

    return fs.readFileSync(expandedPath + '.pub', 'utf8').trim();
}

module.exports = { runCommand, readRemoteFile, uploadFile, uploadContent, testConnection, generateKeypair };
