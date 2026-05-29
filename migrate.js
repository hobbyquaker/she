#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2];

if (!targetDir) {
    console.error('Usage: node migrate.js <directory>');
    process.exit(1);
}

// Substitution rules — order matters: log methods first, sunSchedule before schedule
const rules = [
    // Flatten log.X() → she.X()
    [/(?<!\.)\blog\.debug\s*\(/g, 'she.debug('],
    [/(?<!\.)\blog\.info\s*\(/g, 'she.info('],
    [/(?<!\.)\blog\.warn\s*\(/g, 'she.warn('],
    [/(?<!\.)\blog\.error\s*\(/g, 'she.error('],
    // sunSchedule before schedule to prevent partial match
    [/(?<!\.)\bsunSchedule\s*\(/g, 'she.sunSchedule('],
    // MQTT methods (renamed)
    [/(?<!\.)\bsubscribe\s*\(/g, 'she.mqttsub('],
    [/(?<!\.)\bpublish\s*\(/g, 'she.mqttpub('],
    // Other sandbox methods
    [/(?<!\.)\bschedule\s*\(/g, 'she.schedule('],
    [/(?<!\.)\bsetValue\s*\(/g, 'she.setValue('],
    [/(?<!\.)\bgetValue\s*\(/g, 'she.getValue('],
    [/(?<!\.)\bgetProp\s*\(/g, 'she.getProp('],
    [/(?<!\.)\blink\s*\(/g, 'she.link('],
    [/(?<!\.)\bcombineBool\s*\(/g, 'she.combineBool('],
    [/(?<!\.)\bcombineMax\s*\(/g, 'she.combineMax('],
    [/(?<!\.)\btimer\s*\(/g, 'she.timer('],
    [/(?<!\.)\bnow\s*\(/g, 'she.now('],
    [/(?<!\.)\bage\s*\(/g, 'she.age('],
];

function migrateFile(filePath) {
    let src = fs.readFileSync(filePath, 'utf8');
    const original = src;
    for (const [regex, replacement] of rules) {
        src = src.replace(regex, replacement);
    }
    if (src !== original) {
        fs.writeFileSync(filePath, src, 'utf8');
        console.log('migrated:', filePath);
    } else {
        console.log('unchanged:', filePath);
    }
}

function walkDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') {
            walkDir(full);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            migrateFile(full);
        }
    }
}

walkDir(path.resolve(targetDir));
