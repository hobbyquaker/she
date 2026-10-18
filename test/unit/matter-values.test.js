'use strict';

/**
 * The value conversion for the Matter UI and REST API (src/matter/controller.js _attrValue): byte
 * strings as { $bytes }, operational certificates as { $cert } with subject, issuer, validity,
 * extensions and PEM.
 *
 * matter.js is ESM and cannot run under jest, so @matter/protocol is mocked: its Noc/Rcac classes
 * hand back the DER that real matter.js produced (once, outside jest) for a certificate authority
 * made up for this test — fabric 5, node 7, root 0 — and the rest (PEM, X.509 parsing, the DN
 * names, the fallback) runs for real.
 */

const NOC_DER =
    '308201d83082017fa003020102020101300a06082a8648ce3d04030230223120301e060a2b0601040182a27c01040c10' +
    '30303030303030303030303030303030301e170d3235313031383137343831375a170d3336313031353137343831375a' +
    '30443120301e060a2b0601040182a27c01050c10303030303030303030303030303030353120301e060a2b0601040182' +
    'a27c01010c10303030303030303030303030303030373059301306072a8648ce3d020106082a8648ce3d030107034200' +
    '042e7aae64cad7d9fb6f90297fd91be0d7e683dd7d7cfabf6c1444bfdfdbdc4c51ce8c36b645929ef50ddd41344a6e38' +
    'e0d28cb5c3bc2fb2c093c1412957f3ad3fa38183308180300c0603551d130101ff04023000300e0603551d0f0101ff04' +
    '040302078030200603551d250101ff0416301406082b0601050507030206082b06010505070301301d0603551d0e0416' +
    '0414148bc467fc26ea2b3242e48166a23dc981e7894a301f0603551d230418301680142ed2578d4405af890f5d0b0ad3' +
    'f116edc0520d0e300a06082a8648ce3d0403020347003044022057e7df3f849e6a663b8c60ef7359cadd3e921df78e9d' +
    '1fec5e92bd9bfafc11fd022074da0cd04fd11068156b004a58b3b76bb704aa972fe11319d74b63550f4d9503';
const ROOT_DER =
    '308201963082013ca003020102020100300a06082a8648ce3d04030230223120301e060a2b0601040182a27c01040c10' +
    '30303030303030303030303030303030301e170d3235313031383137343831375a170d3336313031353137343831375a' +
    '30223120301e060a2b0601040182a27c01040c10303030303030303030303030303030303059301306072a8648ce3d02' +
    '0106082a8648ce3d03010703420004cca385d72c53486d038895882658c965f4ba4f338548bbc5fcbf4d6058990535ef' +
    '53f1df09cdf9d6526bf0d00e13c4892fe7ef623f82ac7adb176bd4a2459ddfa3633061300f0603551d130101ff040530' +
    '030101ff300e0603551d0f0101ff040403020106301d0603551d0e041604142ed2578d4405af890f5d0b0ad3f116edc0' +
    '520d0e301f0603551d230418301680142ed2578d4405af890f5d0b0ad3f116edc0520d0e300a06082a8648ce3d040302' +
    '0348003045022100b1299a721f1d985e45843fdcab6bb4410a6626d705802f24f14bf7b7048c3bd202202b800480d1ae' +
    '25e87ebda28f915c35e31994ce3c3a420c90064c4cbe99da9c70';

function fakeCert(derHex, cert) {
    return { cert, asSignedDer: () => Uint8Array.from(Buffer.from(derHex, 'hex')) };
}

describe('matter attribute values', () => {
    let _attrValue;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('@matter/main', () => ({}));
        jest.doMock('@matter/protocol', () => {
            const fromTlv = (der, cert) =>
                jest.fn((tlv) => {
                    if (tlv.length < 10) throw new Error('not a certificate');
                    return fakeCert(der, cert);
                });
            return {
                Noc: {
                    fromTlv: fromTlv(NOC_DER, {
                        subject: { fabricId: BigInt(5), nodeId: BigInt(7) },
                        issuer: { rcacId: BigInt(0) },
                        extensions: {
                            basicConstraints: { isCa: false },
                            keyUsage: { digitalSignature: true, keyCertSign: false },
                            extendedKeyUsage: [2, 1],
                            subjectKeyIdentifier: new Uint8Array(20).fill(0xab),
                        },
                    }),
                },
                Icac: { fromTlv: jest.fn() },
                Rcac: {
                    fromTlv: fromTlv(ROOT_DER, {
                        subject: { rcacId: BigInt(0) },
                        issuer: { rcacId: BigInt(0) },
                        extensions: { basicConstraints: { isCa: true } },
                    }),
                },
            };
        });
        ({ _attrValue } = require('../../src/matter/controller'));
    });

    test('byte strings become hex, nested too; big integers strings', () => {
        expect(_attrValue('generalDiagnostics', 'networkInterfaces', [{ name: 'x', hardwareAddress: new Uint8Array([1, 2, 255]) }])).toEqual([
            { name: 'x', hardwareAddress: { $bytes: '0102ff' } },
        ]);
        expect(_attrValue('x', 'y', BigInt('18446744073709551615'))).toBe('18446744073709551615');
    });

    test('a NOC becomes a certificate with subject, issuer, validity, extensions and PEM', () => {
        const [entry] = _attrValue('operationalCredentials', 'nocs', [{ noc: new Uint8Array(200), icac: null, fabricIndex: 1 }]);
        expect(entry.fabricIndex).toBe(1);
        expect(entry.icac).toBeNull();
        const c = entry.noc.$cert;
        expect(c.kind).toBe('NOC');
        expect(c.subject).toEqual({ fabricId: 5, nodeId: 7 });
        expect(c.issuer).toEqual({ rcacId: 0 });
        expect(c.subjectDn).toBe('matter-fabric-id=0000000000000005, matter-node-id=0000000000000007');
        expect(c.issuerDn).toBe('matter-rcac-id=0000000000000000');
        expect(c.ca).toBe(false);
        expect(c.extensions.extendedKeyUsage).toEqual([2, 1]);
        expect(c.extensions.subjectKeyIdentifier).toEqual({ $bytes: 'ab'.repeat(20) });
        expect(new Date(c.validTo) > new Date(c.validFrom)).toBe(true);
        expect(c.pem).toMatch(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/);
        const x509 = new (require('crypto').X509Certificate)(c.pem);
        expect(x509.fingerprint256).toBe(c.fingerprint);
    });

    test('trusted roots become CA certificates', () => {
        const [root] = _attrValue('operationalCredentials', 'trustedRootCertificates', [new Uint8Array(200)]);
        expect(root.$cert.kind).toBe('RCAC');
        expect(root.$cert.ca).toBe(true);
    });

    test('bytes that are not a certificate stay bytes', () => {
        const [root] = _attrValue('operationalCredentials', 'trustedRootCertificates', [new Uint8Array([1, 2, 3])]);
        expect(root).toEqual({ $bytes: '010203' });
    });
});
