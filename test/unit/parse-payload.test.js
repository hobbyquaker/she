'use strict';

const parsePayload = require('../../src/lib/parse-payload');

describe('parsePayload()', () => {
    describe('booleans', () => {
        it('parses "true" as boolean true', () => {
            expect(parsePayload('true')).toEqual({ val: true });
        });
        it('parses "false" as boolean false', () => {
            expect(parsePayload('false')).toEqual({ val: false });
        });
    });

    describe('numbers', () => {
        it('parses integer strings', () => {
            expect(parsePayload('42')).toEqual({ val: 42 });
        });
        it('parses float strings', () => {
            expect(parsePayload('3.14')).toEqual({ val: 3.14 });
        });
        it('parses zero', () => {
            expect(parsePayload('0')).toEqual({ val: 0 });
        });
        it('parses negative numbers', () => {
            expect(parsePayload('-7')).toEqual({ val: -7 });
        });
    });

    describe('JSON objects', () => {
        it('returns object as-is when it has a val property', () => {
            expect(parsePayload('{"val":1,"ts":1000,"lc":900}')).toEqual({ val: 1, ts: 1000, lc: 900 });
        });
        it('wraps object in val when no val property', () => {
            expect(parsePayload('{"foo":"bar"}')).toEqual({ val: { foo: 'bar' } });
        });
        it('wraps null in val', () => {
            expect(parsePayload('null')).toEqual({ val: null });
        });
    });

    describe('JSON arrays', () => {
        it('wraps arrays in val', () => {
            expect(parsePayload('[1,2,3]')).toEqual({ val: [1, 2, 3] });
        });
        it('wraps empty array in val', () => {
            expect(parsePayload('[]')).toEqual({ val: [] });
        });
    });

    describe('plain strings', () => {
        it('wraps plain string in val', () => {
            expect(parsePayload('hello')).toEqual({ val: 'hello' });
        });
    });

    describe('Buffer input', () => {
        it('accepts a Buffer and converts to string first', () => {
            expect(parsePayload(Buffer.from('42'))).toEqual({ val: 42 });
        });
        it('handles boolean Buffer', () => {
            expect(parsePayload(Buffer.from('true'))).toEqual({ val: true });
        });
    });
});
