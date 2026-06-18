'use strict';

/**
 * ca.js — Local CA operations for she's broker certificate manager.
 *
 * All operations shell out to the system `openssl` binary (standard on
 * Linux/macOS). No new Node.js dependencies required.
 *
 * Directory layout under caDir (default ~/.she/broker/ca/):
 *   ca.key       — CA private key (Ed25519, chmod 600)
 *   ca.crt       — CA self-signed certificate
 *   ca.srl       — serial counter file
 *   crl.pem      — certificate revocation list
 *   clients/     — issued client certs (per-CN subdirectory)
 *     <cn>/
 *       client.key
 *       client.crt
 *       client.p12
 *
 * CA cert metadata is stored in sheDB at she/broker/ca.
 * Issued cert metadata is stored in sheDB at she/broker/cert/<serial>.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

const OPENSSL = 'openssl';

// ── Path helpers ───────────────────────────────────────────────────────────────

function expandHome(p) {
    if (p.startsWith('~/') || p === '~') {
        return path.join(os.homedir(), p.slice(2));
    }
    return p;
}

function caDir(config) {
    return expandHome((config.broker && config.broker.caDir) || '~/.she/broker/ca');
}

function caCertsDir(config) {
    return expandHome((config.broker && config.broker.caCertsDir) || '~/.she/broker/ca-certs');
}

// ── openssl wrapper ────────────────────────────────────────────────────────────

async function openssl(args, options = {}) {
    const { stdout, stderr } = await execFileAsync(OPENSSL, args, {
        timeout: 30000,
        ...options,
    });
    return { stdout, stderr };
}

// ── CA generation ──────────────────────────────────────────────────────────────

/**
 * Generate a new local CA keypair + self-signed cert.
 * @param {object} config
 * @param {{ cn?: string, days?: number }} options
 * @returns {Promise<{ crt: string, fingerprint: string, expires: string }>}
 */
async function generateCA(config, { cn = 'she-broker-ca', days = 365 } = {}) {
    const dir = caDir(config);
    fs.mkdirSync(dir, { recursive: true });

    const keyPath = path.join(dir, 'ca.key');
    const crtPath = path.join(dir, 'ca.crt');
    const srlPath = path.join(dir, 'ca.srl');

    // Generate Ed25519 key + self-signed cert
    await openssl(['req', '-x509', '-newkey', 'ed25519', '-keyout', keyPath, '-out', crtPath, '-days', String(days), '-nodes', '-subj', `/CN=${cn}`]);

    // chmod 600 the private key
    try {
        fs.chmodSync(keyPath, 0o600);
    } catch {
        /* ignore on systems where this fails */
    }

    // Initialise serial file
    if (!fs.existsSync(srlPath)) {
        fs.writeFileSync(srlPath, '01\n', 'utf8');
    }

    const fingerprint = await certFingerprint(crtPath);
    const expires = await certExpiry(crtPath);
    const crt = fs.readFileSync(crtPath, 'utf8');

    return { crt, fingerprint, expires, cn };
}

/**
 * Get CA status. Returns null if no CA exists.
 * @param {object} config
 */
async function getCA(config) {
    const dir = caDir(config);
    const crtPath = path.join(dir, 'ca.crt');
    if (!fs.existsSync(crtPath)) return null;
    try {
        const fingerprint = await certFingerprint(crtPath);
        const expires = await certExpiry(crtPath);
        const cn = await certCN(crtPath);
        const crt = fs.readFileSync(crtPath, 'utf8');
        return { crt, fingerprint, expires, cn };
    } catch {
        return null;
    }
}

// ── Server certificate ─────────────────────────────────────────────────────────

/**
 * Generate a server keypair + CSR + sign it with the local CA.
 * @param {object} config
 * @param {{ cn?: string, san?: string[], days?: number }} options
 * @returns {Promise<{ crt: string, key: string, fingerprint: string, expires: string }>}
 */
async function generateServerCert(config, { cn, san = [], days = 365 } = {}) {
    const dir = caDir(config);
    const caKeyPath = path.join(dir, 'ca.key');
    const caCrtPath = path.join(dir, 'ca.crt');
    const srlPath = path.join(dir, 'ca.srl');

    if (!fs.existsSync(caCrtPath)) throw new Error('No CA found — generate CA first');

    const serverDir = path.join(dir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });

    const keyPath = path.join(serverDir, 'server.key');
    const csrPath = path.join(serverDir, 'server.csr');
    const crtPath = path.join(serverDir, 'server.crt');
    const extPath = path.join(serverDir, 'server.ext');

    // Build SAN extension file
    const sanEntries = [cn, ...san].filter(Boolean).map((s, i) => {
        return /^\d+\.\d+\.\d+\.\d+$/.test(s) ? `IP.${i + 1}:${s}` : `DNS.${i + 1}:${s}`;
    });
    const extContent = `[SAN]\nsubjectAltName=${sanEntries.join(',')}\n`;
    fs.writeFileSync(extPath, extContent, 'utf8');

    // Generate key
    await openssl(['genpkey', '-algorithm', 'ed25519', '-out', keyPath]);
    try {
        fs.chmodSync(keyPath, 0o600);
    } catch {
        /* ignore */
    }

    // Generate CSR
    await openssl(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${cn || 'mosquitto'}`]);

    // Sign with CA
    await openssl([
        'x509',
        '-req',
        '-in',
        csrPath,
        '-CA',
        caCrtPath,
        '-CAkey',
        caKeyPath,
        '-CAserial',
        srlPath,
        '-out',
        crtPath,
        '-days',
        String(days),
        '-extfile',
        extPath,
        '-extensions',
        'SAN',
    ]);

    const fingerprint = await certFingerprint(crtPath);
    const expires = await certExpiry(crtPath);
    const crt = fs.readFileSync(crtPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');

    return { crt, key, fingerprint, expires, certPath: crtPath, keyPath };
}

// ── Client certificate issuance ────────────────────────────────────────────────

/**
 * Issue a client certificate signed by the local CA.
 * Returns paths to .p12, .crt, .key and the p12 passphrase.
 *
 * @param {object} config
 * @param {{ cn: string, days?: number }} options
 * @returns {Promise<{ serial: string, crt: string, key: string, p12Path: string, passphrase: string, fingerprint: string, expires: string }>}
 */
async function issueClientCert(config, { cn, days = 365 } = {}) {
    if (!cn) throw new Error('cn is required');

    const dir = caDir(config);
    const caKeyPath = path.join(dir, 'ca.key');
    const caCrtPath = path.join(dir, 'ca.crt');
    const srlPath = path.join(dir, 'ca.srl');

    if (!fs.existsSync(caCrtPath)) throw new Error('No CA found — generate CA first');

    // Sanitise CN for use as directory name
    const safeCn = cn.replace(/[^a-zA-Z0-9._-]/g, '_');
    const clientDir = path.join(dir, 'clients', safeCn);
    fs.mkdirSync(clientDir, { recursive: true });

    const keyPath = path.join(clientDir, 'client.key');
    const csrPath = path.join(clientDir, 'client.csr');
    const crtPath = path.join(clientDir, 'client.crt');
    const p12Path = path.join(clientDir, 'client.p12');

    // Generate client key
    await openssl(['genpkey', '-algorithm', 'ed25519', '-out', keyPath]);
    try {
        fs.chmodSync(keyPath, 0o600);
    } catch {
        /* ignore */
    }

    // Generate CSR
    await openssl(['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${cn}`]);

    // Sign with CA
    await openssl(['x509', '-req', '-in', csrPath, '-CA', caCrtPath, '-CAkey', caKeyPath, '-CAserial', srlPath, '-out', crtPath, '-days', String(days)]);

    // Read serial from the signed cert
    const serial = await certSerial(crtPath);

    // Bundle to .p12
    const passphrase = crypto.randomBytes(10).toString('hex');
    await openssl(['pkcs12', '-export', '-in', crtPath, '-inkey', keyPath, '-certfile', caCrtPath, '-out', p12Path, '-passout', `pass:${passphrase}`, '-legacy']);

    const fingerprint = await certFingerprint(crtPath);
    const expires = await certExpiry(crtPath);
    const crt = fs.readFileSync(crtPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');

    return {
        serial,
        cn,
        crt,
        key,
        p12Path,
        passphrase,
        fingerprint,
        expires,
        issued: new Date().toISOString(),
    };
}

/**
 * Regenerate CRL from a list of revoked cert files.
 * @param {object} config
 * @param {string[]} revokedCertPaths - PEM cert file paths to include in CRL
 */
async function generateCRL(config, revokedCertPaths = []) {
    const dir = caDir(config);
    const caKeyPath = path.join(dir, 'ca.key');
    const caCrtPath = path.join(dir, 'ca.crt');
    const crlPath = path.join(dir, 'crl.pem');

    if (!fs.existsSync(caCrtPath)) throw new Error('No CA found');

    // Build a minimal openssl database for revocations
    const dbDir = path.join(dir, '.crldb');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, 'index.txt');
    const dbAttr = path.join(dbDir, 'index.txt.attr');
    const crlSrl = path.join(dbDir, 'crlnumber');
    const confPath = path.join(dbDir, 'openssl.cnf');

    // Initialise DB files if missing
    if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, '', 'utf8');
    if (!fs.existsSync(dbAttr)) fs.writeFileSync(dbAttr, 'unique_subject = no\n', 'utf8');
    if (!fs.existsSync(crlSrl)) fs.writeFileSync(crlSrl, '01\n', 'utf8');

    const confContent = `
[ ca ]
default_ca = CA_default

[ CA_default ]
dir               = ${dbDir}
database          = ${dbFile}
new_certs_dir     = ${dbDir}
certificate       = ${caCrtPath}
private_key       = ${caKeyPath}
default_md        = default
default_crl_days  = 30
crl_extensions    = crl_ext
crlnumber         = ${crlSrl}

[ crl_ext ]
authorityKeyIdentifier = keyid:always

[ req ]
default_bits = 2048
`;
    fs.writeFileSync(confPath, confContent, 'utf8');

    // Revoke each cert in the database
    for (const certPath of revokedCertPaths) {
        try {
            await openssl(['ca', '-config', confPath, '-revoke', certPath, '-batch']);
        } catch {
            // cert may already be in the DB — ignore duplicate errors
        }
    }

    // Generate CRL
    await openssl(['ca', '-config', confPath, '-gencrl', '-out', crlPath, '-batch']);

    return crlPath;
}

// ── Trusted CA certs (capath) ──────────────────────────────────────────────────

/**
 * List all trusted CA certs in the capath directory.
 * @param {object} config
 * @returns {Promise<{ filename: string, cn: string, fingerprint: string, expires: string }[]>}
 */
async function listTrustedCerts(config) {
    const dir = caCertsDir(config);
    let files;
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.pem') || f.endsWith('.crt'));
    } catch {
        return [];
    }

    const result = [];
    for (const file of files) {
        const fp = path.join(dir, file);
        try {
            const cn = await certCN(fp);
            const fingerprint = await certFingerprint(fp);
            const expires = await certExpiry(fp);
            result.push({ filename: file, cn, fingerprint, expires });
        } catch {
            result.push({ filename: file, cn: '?', fingerprint: '?', expires: '?' });
        }
    }
    return result;
}

/**
 * Add a trusted CA cert to the capath directory.
 * @param {object} config
 * @param {string} pemContent - PEM certificate text
 * @returns {Promise<{ filename: string, fingerprint: string }>}
 */
async function addTrustedCert(config, pemContent) {
    const dir = caCertsDir(config);
    fs.mkdirSync(dir, { recursive: true });

    // Derive filename from fingerprint
    const tmpPath = path.join(dir, `_tmp_${Date.now()}.pem`);
    fs.writeFileSync(tmpPath, pemContent, 'utf8');
    let fingerprint;
    try {
        fingerprint = await certFingerprint(tmpPath);
    } catch (e) {
        fs.unlinkSync(tmpPath);
        throw new Error(`Invalid certificate PEM: ${e.message}`);
    }

    const filename = fingerprint.replace(/:/g, '').slice(0, 16) + '.pem';
    const destPath = path.join(dir, filename);
    fs.renameSync(tmpPath, destPath);

    // Re-run openssl rehash so mosquitto can find this cert
    try {
        await openssl(['rehash', dir]);
    } catch {
        /* openssl rehash may not exist on all platforms — non-fatal */
    }

    return { filename, fingerprint };
}

/**
 * Remove a trusted CA cert by its fingerprint.
 * @param {object} config
 * @param {string} fingerprint
 */
async function removeTrustedCert(config, fingerprint) {
    const dir = caCertsDir(config);
    const certs = await listTrustedCerts(config);
    const match = certs.find((c) => c.fingerprint === fingerprint);
    if (!match) throw new Error('Cert not found');
    fs.unlinkSync(path.join(dir, match.filename));

    // Rehash after removal
    try {
        await openssl(['rehash', dir]);
    } catch {
        /* non-fatal */
    }
}

// ── Client cert file helpers (for download) ────────────────────────────────────

/**
 * Get file paths for an issued client cert by CN.
 * @param {object} config
 * @param {string} cn
 * @returns {{ keyPath, crtPath, p12Path, caPath }}
 */
function clientCertPaths(config, cn) {
    const dir = caDir(config);
    const safeCn = cn.replace(/[^a-zA-Z0-9._-]/g, '_');
    const clientDir = path.join(dir, 'clients', safeCn);
    return {
        keyPath: path.join(clientDir, 'client.key'),
        crtPath: path.join(clientDir, 'client.crt'),
        p12Path: path.join(clientDir, 'client.p12'),
        caPath: path.join(dir, 'ca.crt'),
        serverCrtPath: path.join(dir, 'server', 'server.crt'),
        serverKeyPath: path.join(dir, 'server', 'server.key'),
    };
}

// ── openssl x509 parsing helpers ───────────────────────────────────────────────

async function certFingerprint(certPath) {
    const { stdout } = await openssl(['x509', '-in', certPath, '-fingerprint', '-sha256', '-noout']);
    const match = stdout.match(/SHA256 Fingerprint=([0-9A-F:]+)/i);
    return match ? match[1] : stdout.trim();
}

async function certExpiry(certPath) {
    const { stdout } = await openssl(['x509', '-in', certPath, '-enddate', '-noout']);
    const match = stdout.match(/notAfter=(.+)/);
    return match ? new Date(match[1]).toISOString() : stdout.trim();
}

async function certCN(certPath) {
    const { stdout } = await openssl(['x509', '-in', certPath, '-subject', '-noout', '-nameopt', 'RFC2253']);
    const match = stdout.match(/CN=([^,]+)/);
    return match ? match[1].trim() : stdout.trim();
}

async function certSerial(certPath) {
    const { stdout } = await openssl(['x509', '-in', certPath, '-serial', '-noout']);
    const match = stdout.match(/serial=([0-9A-Fa-f]+)/);
    return match ? match[1] : stdout.trim();
}

module.exports = {
    caDir,
    caCertsDir,
    generateCA,
    getCA,
    generateServerCert,
    issueClientCert,
    generateCRL,
    listTrustedCerts,
    addTrustedCert,
    removeTrustedCert,
    clientCertPaths,
    certFingerprint,
    certExpiry,
    certCN,
    certSerial,
};
