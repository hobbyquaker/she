'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../../src/web/ai-memory');

describe('AI memory (I29)', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-ai-memory-'));
        memory.init(dir, (t) => t.replace('hunter2', '***'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('adds, lists, edits and removes notes in memory.json', () => {
        const a = memory.add('  the PIR in the bathroom   cannot see the shower ', 'model');
        expect(a.note.text).toBe('the PIR in the bathroom cannot see the shower');
        expect(a.note.source).toBe('model');
        expect(memory.add('The PIR in the bathroom cannot see the shower').duplicate).toBe(true);
        expect(memory.list()).toHaveLength(1);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'));
        expect(saved.notes[0].id).toBe(a.note.id);
        const u = memory.update(a.note.id, 'the PIR cannot see the tub');
        expect(u.note.source).toBe('user');
        expect(memory.remove(a.note.id).note.text).toBe('the PIR cannot see the tub');
        expect(memory.list()).toHaveLength(0);
        expect(memory.remove('nope').error).toMatch(/no note/);
    });

    it('refuses secrets, long and empty notes, and redacts known secret values', () => {
        expect(memory.add('').error).toMatch(/empty/);
        expect(memory.add('x'.repeat(201)).error).toMatch(/200 characters/);
        expect(memory.add('the api key is sk-ant-api03-abcdefghij').error).toMatch(/looks like a key/);
        expect(memory.add('password: geheim').error).toMatch(/looks like a key/);
        expect(memory.add('the wifi password is hunter2').note.text).toBe('the wifi password is ***');
    });

    it('caps the number of notes', () => {
        for (let i = 0; i < memory.MAX_NOTES; i++) memory.add('fact ' + i);
        expect(memory.add('one more').error).toMatch(/at most 300 notes/);
    });
});
