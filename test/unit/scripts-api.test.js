'use strict';

const os = require('os');
const path = require('path');
const { safePath } = require('../../src/web/scripts-api');

// Use an OS temp path as root so the test works on both Windows and Linux.
const root = path.join(os.tmpdir(), 'she-test-scripts');

describe('safePath()', () => {
    it('resolves a simple relative path inside the root', () => {
        expect(safePath(root, 'test.js')).toBe(path.join(root, 'test.js'));
    });

    it('resolves a nested relative path inside the root', () => {
        expect(safePath(root, 'sub/dir/file.js')).toBe(path.join(root, 'sub', 'dir', 'file.js'));
    });

    it('strips a leading slash and resolves safely', () => {
        expect(safePath(root, '/test.js')).toBe(path.join(root, 'test.js'));
    });

    it('strips multiple leading slashes', () => {
        expect(safePath(root, '///test.js')).toBe(path.join(root, 'test.js'));
    });

    it('accepts a path that resolves exactly to the root', () => {
        expect(safePath(root, '.')).toBe(root);
    });

    it('rejects ../ traversal to parent directory', () => {
        expect(safePath(root, '../passwd')).toBeNull();
    });

    it('rejects deep traversal that escapes root', () => {
        expect(safePath(root, 'sub/../../passwd')).toBeNull();
    });

    it('rejects traversal that passes through subdirectory before escaping', () => {
        expect(safePath(root, 'a/b/../../../secret')).toBeNull();
    });
});
