'use strict';

const mqttWildcard = require('../../src/lib/mqtt-wildcards');

describe('mqttWildcard()', () => {
    describe('exact matches', () => {
        it('matches identical topic', () => {
            expect(mqttWildcard('a/b/c', 'a/b/c')).toBeTruthy();
        });
        it('does not match different topic', () => {
            expect(mqttWildcard('a/b/c', 'a/b/d')).toBeFalsy();
        });
        it('does not match prefix only', () => {
            expect(mqttWildcard('a/b', 'a/b/c')).toBeFalsy();
        });
    });

    describe('single-level wildcard (+)', () => {
        it('matches one level', () => {
            expect(mqttWildcard('a/b/c', 'a/+/c')).toBeTruthy();
        });
        it('matches at beginning', () => {
            expect(mqttWildcard('x/b/c', '+/b/c')).toBeTruthy();
        });
        it('matches at end', () => {
            expect(mqttWildcard('a/b/x', 'a/b/+')).toBeTruthy();
        });
        it('does not span multiple levels', () => {
            expect(mqttWildcard('a/b/c', 'a/+')).toBeFalsy();
        });
        it('matches multiple + wildcards', () => {
            expect(mqttWildcard('a/b/c', '+/+/+')).toBeTruthy();
        });
    });

    describe('multi-level wildcard (#)', () => {
        it('matches remaining levels', () => {
            expect(mqttWildcard('a/b/c/d', 'a/#')).toBeTruthy();
        });
        it('matches single remaining level', () => {
            expect(mqttWildcard('a/b', 'a/#')).toBeTruthy();
        });
        it('matches when # is entire subscription', () => {
            expect(mqttWildcard('a/b/c', '#')).toBeTruthy();
        });
        it('does not match unrelated prefix', () => {
            expect(mqttWildcard('x/b/c', 'a/#')).toBeFalsy();
        });
    });

    describe('var/status/# pattern (used internally)', () => {
        it('matches variable status topics', () => {
            expect(mqttWildcard('var/status/foo', 'var/status/#')).toBeTruthy();
        });
        it('does not match set topics', () => {
            expect(mqttWildcard('var/set/foo', 'var/status/#')).toBeFalsy();
        });
    });
});
