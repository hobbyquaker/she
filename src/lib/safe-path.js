'use strict';
/**
 * A path a request names, kept inside a root directory — symlinks included.
 *
 * Comparing strings (`path.resolve` + `startsWith(root)`) stops `../`, but not a symlink that sits
 * inside the root and points out of it: `scripts/notes -> /etc` makes `notes/passwd` a path
 * "inside" the script directory. So the path is resolved the way the kernel will resolve it, and
 * what is compared is where it really ends up.
 *
 * - A symlink whose target is inside the root keeps working, and so does a root that is itself a
 *   symlink — both sides are resolved.
 * - A path that does not exist yet (a file about to be written, a directory to create) is judged
 *   by its deepest existing ancestor.
 * - A link whose target is missing is refused: writing "to" it would create the target, wherever
 *   the link points.
 * - `followLeaf: false` is for what acts on the entry itself and not on what it points to —
 *   delete, rename: only the directory the entry sits in has to be inside the root, so a link
 *   that points outside can still be removed.
 *
 * This is a check before the use, not an atomic open: someone who can swap a directory for a
 * symlink between the two wins the race. Whoever can do that writes to the root directory already.
 */

const fs = require('fs');
const path = require('path');

/** Where `abs` really is, whether it exists or not; null when it leads through a dead or looping link. */
function realOf(abs) {
    try {
        return fs.realpathSync(abs);
    } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
    }
    try {
        // realpath found nothing, but there is an entry: a link to a target that does not exist
        if (fs.lstatSync(abs).isSymbolicLink()) return null;
    } catch {
        /* nothing there at all */
    }
    const parent = path.dirname(abs);
    if (parent === abs) return null;
    const realParent = realOf(parent);
    return realParent === null ? null : path.join(realParent, path.basename(abs));
}

function isInside(root, abs) {
    return abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The absolute path of `relPath` below `root`, or null when it is not inside the root.
 * @param {string} root the directory nothing may leave
 * @param {string} relPath the client's path, relative to the root (leading slashes are ignored)
 * @param {{followLeaf?: boolean}} [opts] followLeaf false: the last component is not resolved (see above)
 * @returns {string|null} the path as given, joined to the root — not the resolved one
 */
function resolveInside(root, relPath, { followLeaf = true } = {}) {
    if (typeof root !== 'string' || !root || typeof relPath !== 'string' || relPath.includes('\0')) return null;
    const absRoot = path.resolve(root);
    const abs = path.resolve(absRoot, relPath.replace(/^\/+/, ''));
    if (!isInside(absRoot, abs)) return null;
    const realRoot = realOf(absRoot);
    if (realRoot === null) return null;
    let real;
    if (followLeaf || abs === absRoot) {
        real = realOf(abs);
    } else {
        const realParent = realOf(path.dirname(abs));
        real = realParent === null ? null : path.join(realParent, path.basename(abs));
    }
    if (real === null || !isInside(realRoot, real)) return null;
    return abs;
}

/**
 * True when `abs` is below `root` by its name but really lies somewhere else: a symlink on the way
 * (the entry itself or a directory above it) leads out of the root. A path that is not below the
 * root by name, a link whose target is missing and a loop answer false — they are not "linked in
 * from outside", whatever else is wrong with them.
 * @param {string} root the directory
 * @param {string} abs the path as it is named
 * @param {string} [real] where the path really ends up, when the caller knows it already
 */
function linksOutside(root, abs, real) {
    if (typeof root !== 'string' || !root || typeof abs !== 'string') return false;
    const absRoot = path.resolve(root);
    if (!isInside(absRoot, path.resolve(abs))) return false;
    const realRoot = realOf(absRoot);
    if (realRoot === null) return false;
    if (real === undefined) {
        try {
            real = fs.realpathSync(path.resolve(abs));
        } catch {
            return false;
        }
    }
    return !isInside(realRoot, real);
}

module.exports = { resolveInside, realOf, linksOutside };
