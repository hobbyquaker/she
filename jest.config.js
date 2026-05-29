// @ts-check
/** @type {import('jest').Config} */
const jestConfig = {
    testEnvironment: 'node',
    cacheDirectory: '<rootDir>/.cache/jest',
    testMatch: ['<rootDir>/test.js'],
    testTimeout: 180000,
    forceExit: true,
};

module.exports = jestConfig;
