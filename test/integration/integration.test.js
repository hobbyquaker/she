#!/usr/bin/env node

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');
const Aedes = require('aedes');
const Mqtt = require('mqtt');

const msCmd = path.join(__dirname, '../mockdate.js');

let msArgs;
let ms;
let broker;
let brokerServer;
let brokerPort;
let brokerSockets = new Set();
let mqtt;
let tmpConfigFile;
let tmpDataDir;
// the additional brokers: "shed" is a second Aedes, "late" a port nothing listens on until a test starts it
let shed;
let shedServer;
let shedPort;
let shedMqtt;
const shedSubscriptions = {};
let latePort;
let late = null;
let lateServer = null;
let lateMqtt = null;
let httpPort; // the daemon's HTTP port, learned from its log line by the brokers block

const msSubscriptions = {};
const msBuffer = [];
const mqttSubscriptions = {};

let subIndex = 0;

function subscribe(type, rx, cb) {
    subIndex += 1;
    if (type === 'ms') {
        msSubscriptions[subIndex] = { rx, cb };
    }
    matchSubscriptions(type);
    return subIndex;
}

function _unsubscribe(type, idx) {
    if (type === 'ms') {
        delete msSubscriptions[idx];
    }
}

function matchSubscriptions(type, data) {
    let subs;
    let buf;
    if (type === 'ms') {
        subs = msSubscriptions;
        buf = msBuffer;
    }
    if (!subs) return;
    if (data) {
        buf.push(data);
    }
    buf.forEach((line, index) => {
        let matched = false;
        Object.keys(subs).forEach((key) => {
            if (matched) return;
            const sub = subs[key];
            let m;
            if ((m = line.match(sub.rx))) {
                matched = true;
                sub.cb(line, m);
                delete subs[key];
                buf.splice(index, 1);
            }
        });
    });
}

function mqttSubscribe(topic, callback) {
    if (mqttSubscriptions[topic]) {
        mqttSubscriptions[topic].push(callback);
    } else {
        mqttSubscriptions[topic] = [callback];
        mqtt.subscribe(topic);
    }
}

function shedSubscribe(topic, callback) {
    if (shedSubscriptions[topic]) {
        shedSubscriptions[topic].push(callback);
    } else {
        shedSubscriptions[topic] = [callback];
        shedMqtt.subscribe(topic);
    }
}

/** a TCP port nothing listens on right now */
function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function startMs() {
    ms = cp.spawn(process.execPath, [msCmd, ...msArgs]);
    const rlOut = readline.createInterface({ input: ms.stdout, crlfDelay: Infinity });
    const rlErr = readline.createInterface({ input: ms.stderr, crlfDelay: Infinity });
    // Strip ANSI escape codes so regex comparisons in tests are not confused by
    // colour wrapping added by pino-pretty's colorize:true option.
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
    rlOut.on('line', (data) => {
        const line = stripAnsi(data.toString());
        console.log('ms', line);
        matchSubscriptions('ms', line);
    });
    rlErr.on('line', (data) => {
        const line = stripAnsi(data.toString());
        console.log('ms', line);
        matchSubscriptions('ms', line);
    });
}

beforeAll((done) => {
    broker = new Aedes();
    brokerServer = net.createServer(broker.handle);
    brokerServer.on('connection', (socket) => {
        brokerSockets.add(socket);
        socket.on('close', () => brokerSockets.delete(socket));
    });
    brokerServer.listen(0, async () => {
        brokerPort = brokerServer.address().port;
        // the second broker, with a retained value the daemon finds when it connects
        shed = new Aedes();
        shedServer = net.createServer(shed.handle);
        await new Promise((resolve) => shedServer.listen(0, resolve));
        shedPort = shedServer.address().port;
        latePort = await freePort();
        shedMqtt = Mqtt.connect(`mqtt://127.0.0.1:${shedPort}`);
        shedMqtt.on('message', (topic, payload, packet) => {
            if (shedSubscriptions[topic]) {
                shedSubscriptions[topic].forEach((callback) => callback(payload.toString(), packet));
            }
        });
        await new Promise((resolve) => shedMqtt.on('connect', resolve));
        await new Promise((resolve) => shedMqtt.publish('tele/preset', '42', { retain: true }, resolve));
        tmpConfigFile = path.join(os.tmpdir(), `she-integration-test-${Date.now()}-${process.pid}.json`);
        fs.writeFileSync(
            tmpConfigFile,
            JSON.stringify({
                url: `mqtt://127.0.0.1:${brokerPort}`,
                // Aedes accepts any credentials; they are here so the redacted config line can be checked
                mqttUsername: 'she',
                mqttPassword: 'Sup3rSecretPw',
                verbosity: 'debug',
                port: 0,
                statsInterval: 2,
                brokers: {
                    shed: {
                        url: `mqtt://127.0.0.1:${shedPort}`,
                        mirror: [
                            { dir: 'in', from: 'tele/#', to: 'shed/tele/#' },
                            { dir: 'out', from: 'shed/set/#', to: 'set/#' },
                            // a cycle on purpose: what comes in must never go back out
                            { dir: 'in', from: 'loop/#' },
                            { dir: 'out', from: 'loop/#' },
                        ],
                    },
                    late: { url: `mqtt://127.0.0.1:${latePort}` },
                },
            }),
        );
        // Own data dir: the spawned daemon must not write logs, db or the safe-mode
        // marker into the developer's real ~/.she.
        tmpDataDir = path.join(os.tmpdir(), `she-integration-test-data-${Date.now()}-${process.pid}`);
        msArgs = ['-d', path.join(__dirname, '../testscripts'), '--config', tmpConfigFile, '--data-dir', tmpDataDir];
        mqtt = Mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`);
        mqtt.on('message', (topic, payload) => {
            if (mqttSubscriptions[topic]) {
                mqttSubscriptions[topic].forEach((callback) => callback(payload.toString()));
            }
        });
        mqtt.on('connect', () => done());
    });
});

afterAll((done) => {
    if (ms) ms.kill();
    if (shedMqtt) shedMqtt.end(true);
    if (shedServer) shedServer.close(() => shed.close());
    if (lateMqtt) lateMqtt.end(true);
    if (lateServer) lateServer.close(() => late.close());
    mqtt.end(true, {}, () => {
        brokerServer.close(() => {
            broker.close(() => {
                if (tmpConfigFile)
                    try {
                        fs.unlinkSync(tmpConfigFile);
                    } catch {
                        // ignore
                    }
                if (tmpDataDir)
                    try {
                        fs.rmSync(tmpDataDir, { recursive: true, force: true });
                    } catch {
                        // ignore
                    }
                done();
            });
        });
    });
});

describe('start daemon', () => {
    it('should start without error', (done) => {
        subscribe('ms', /she \d+\.\d+\.\d+\S* starting/, () => done());
        startMs();
    }, 20000);
    it('should connect to the mqtt broker', (done) => {
        subscribe('ms', /mqtt connected/, () => done());
    }, 20000);
    it('should subscribe to #', (done) => {
        subscribe('ms', /mqtt subscribe #/, () => done());
    }, 20000);
    it('should publish 2 on she/connected', (done) => {
        mqttSubscribe('she/connected', (payload) => {
            if (payload > 0) {
                mqtt.unsubscribe('she/connected');
                done();
            }
        });
    }, 20000);
});

describe('script loading', () => {
    it('should load test1.js script file', (done) => {
        subscribe('ms', /test1\.js: loading/, () => done());
    }, 20000);
    it('should execute test1.js script file', (done) => {
        subscribe('ms', /test1\.js: running/, () => done());
    }, 20000);
    it('should catch a syntax error', (done) => {
        subscribe('ms', /test3\.js: SyntaxError/, () => done());
    }, 20000);
});

describe('argument checks', () => {
    it('should throw on wrong arguments for she.mqttsub() - missing callback', (done) => {
        subscribe('ms', /test4\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong arguments for she.mqttsub() - wrong callback', (done) => {
        subscribe('ms', /test5\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong arguments for she.mqttsub() - missing topic', (done) => {
        subscribe('ms', /test16\.js: TypeError: argument topic missing/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for she.mqttsub()', (done) => {
        subscribe('ms', /test6\.js: Error: wrong number of arguments/, () => done());
    }, 20000);
    it('should throw on wrong options.condition for she.mqttsub()', (done) => {
        subscribe('ms', /test17\.js: Error: options.condition/, () => done());
    }, 20000);
    it('should throw on unknown suncalc event for she.schedule()', (done) => {
        subscribe('ms', /test8\.js: TypeError: unknown suncalc event/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for she.schedule()', (done) => {
        subscribe('ms', /test9\.js: Error: wrong number of arguments/, () => done());
    }, 20000);
    it('should throw on wrong callback type for she.schedule() (sun) #1', (done) => {
        subscribe('ms', /test10\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong callback type for she.schedule() (sun) #2', (done) => {
        subscribe('ms', /test11\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on out-of-range shift for she.schedule()', (done) => {
        subscribe('ms', /test15\.js: Error: options.shift out of range/, () => done());
    }, 20000);
    it('should throw on wrong callback type for she.schedule() #1', (done) => {
        subscribe('ms', /test12\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong callback type for she.schedule() #2', (done) => {
        subscribe('ms', /test13\.js: TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for she.schedule()', (done) => {
        subscribe('ms', /test14\.js: Error: wrong number of arguments/, () => done());
    }, 20000);
});

describe('testscripts/test1.js execution', () => {
    it('should log a msg', (done) => {
        subscribe('ms', /test1\.js: test log/, () => done());
    }, 20000);
    it('should return true on getValue()', (done) => {
        subscribe('ms', /test1\.js: test1 true/, () => done());
    }, 20000);
});

describe('require()', () => {
    it('should load a lib file', (done) => {
        subscribe('ms', /require test/, () => done());
    }, 60000);
    it('should load a module', (done) => {
        subscribe('ms', /Dummy Module/, () => done());
    }, 60000);
    it('should throw on invalid module and attribute it to the requiring script', (done) => {
        subscribe('ms', /test-require-error\.js: ReferenceError: thisDoesNotExist is not defined/, () => done());
    }, 60000);
});

describe('she.mqttsub(), she.setValue()', () => {
    it('should increase a number', (done) => {
        mqttSubscribe('test/set/incr', (payload) => {
            if (payload === '5') {
                done();
            }
        });
        mqtt.publish('test/status/incr', '4');
    }, 20000);
});

describe('she.mqttsub()', () => {
    it("should respect condition val=='muh'", (done) => {
        subscribe('ms', /test1\.js: test\/condition (.*)$/, (line, m) => {
            done(m[1] === 'muh' ? undefined : new Error('wrong value'));
        });
        mqtt.publish('test/condition', 'blub');
        mqtt.publish('test/condition', 'muh');
    }, 20000);
    it('should respect change==true', (done) => {
        let count = 0;
        subscribe('ms', /test1\.js: test\/change 0/, () => {
            count += 1;
        });
        subscribe('ms', /test1\.js: test\/change 1/, () => {
            count += 1;
            if (count >= 2) done();
        });
        setTimeout(() => {
            mqtt.publish('test/change', '0');
            mqtt.publish('test/change', '0');
            mqtt.publish('test/change', '0');
            mqtt.publish('test/change', '1');
            mqtt.publish('test/change', '1');
        }, 1000);
    }, 20000);
    it('should do randomshift', (done) => {
        let early = true;
        setTimeout(() => {
            early = undefined;
        }, 9000);
        subscribe('ms', /randomshift muh/, () => done(early));
        mqtt.publish('test/randomshift', 'muh');
    }, 21000);
});

describe('link()', () => {
    it('should link one topic to another', (done) => {
        mqttSubscribe('test/target', (payload) => {
            if (payload === 'test') done();
        });
        mqtt.publish('test/src', 'test');
    }, 20000);
    it('should link multiple topics to other topics', (done) => {
        mqttSubscribe('test/target2', (payload) => {
            if (payload === 'test') done();
        });
        mqtt.publish('test/src1', 'test');
    }, 20000);
    it('should link one topic to another with given value', (done) => {
        mqttSubscribe('test/target3', (payload) => {
            if (payload === '1337') done();
        });
        mqtt.publish('test/src3', 'test');
    }, 20000);
    it('should link one topic to another with transformation function', (done) => {
        mqttSubscribe('test/target4', (payload) => {
            if (payload === '4') done();
        });
        mqtt.publish('test/src4', '2');
    }, 20000);
});

describe('age()', () => {
    it('should return an age of 5s', (done) => {
        subscribe('ms', /test\/target age ([0-9]+)/, (line, m) => {
            const age = parseInt(m[1]);
            if (age >= 1 && age <= 20) done();
        });
    }, 20000);
});

describe('getProp(), now()', () => {
    it('should return a lastchange and a timestamp with ~5000ms difference', (done) => {
        subscribe('ms', /test\/target lc ([0-9]+) ([0-9]+)/, (line, m) => {
            const elapsed = parseInt(m[2]) - parseInt(m[1]);
            if (elapsed > 1000 && elapsed < 20000) done();
        });
    }, 20000);
});

describe('schedule()', () => {
    it("should execute a schedule callback for '* * * * *'", (done) => {
        subscribe('ms', /schedule callback/, () => done());
    }, 180000);
    it("should execute a schedule callback for '0 0 * * *'", (done) => {
        subscribe('ms', /midnight/, () => done());
    }, 180000);
    it('should re-schedule sun events', (done) => {
        subscribe('ms', /re-scheduled [0-9]+ sun events/, () => done());
    }, 180000);
    it('should execute a schedule callback for Date', (done) => {
        subscribe('ms', /schedule date/, () => done());
    }, 180000);
    it('should execute a schedule callback for multi schedule', (done) => {
        let count = 0;
        subscribe('ms', /multi schedule 1/, () => {
            count += 1;
        });
        subscribe('ms', /multi schedule 2/, () => {
            count += 1;
            if (count >= 2) done();
        });
    }, 180000);
});

describe('exception', () => {
    it('should catch an exception occuring in a script', (done) => {
        subscribe('ms', /test1\.js: Error: test exception/, () => done());
    }, 180000);
});

describe('setting variables', () => {
    it('should publish a number', (done) => {
        mqttSubscribe('var/status/testnumber', (payload) => {
            const state = JSON.parse(payload);
            if (state.val === 1) {
                mqtt.unsubscribe('var/status/testnumber');
                done();
            }
        });
        setTimeout(() => mqtt.publish('var/set/testnumber', '1'), 1000);
    }, 20000);
    it('should publish a string', (done) => {
        mqttSubscribe('var/status/teststring', (payload) => {
            const state = JSON.parse(payload);
            if (state.val === 'test') {
                mqtt.unsubscribe('var/status/teststring');
                done();
            }
        });
        setTimeout(() => mqtt.publish('var/set/teststring', 'test'), 2000);
    }, 20000);
    it('should publish a boolean true', (done) => {
        mqttSubscribe('var/status/testbool1', (payload) => {
            const state = JSON.parse(payload);
            if (state.val === true) {
                mqtt.unsubscribe('var/status/testbool1');
                done();
            }
        });
        setTimeout(() => mqtt.publish('var/set/testbool1', 'true'), 3000);
    }, 20000);
    it('should publish a boolean false', (done) => {
        mqttSubscribe('var/status/testbool2', (payload) => {
            const state = JSON.parse(payload);
            if (state.val === false) {
                mqtt.unsubscribe('var/status/testbool2');
                done();
            }
        });
        setTimeout(() => mqtt.publish('var/set/testbool2', 'false'), 4000);
    }, 20000);
    it('should publish an array', (done) => {
        mqttSubscribe('var/status/array', (payload) => {
            const state = JSON.parse(payload);
            if (Array.isArray(state.val) && state.val.length === 3) {
                mqtt.unsubscribe('var/status/array');
                done();
            }
        });
        setTimeout(() => mqtt.publish('var/set/array', '[1,2,3]'), 5000);
    }, 20000);
});

describe('mqtt connection', () => {
    it('should log mqtt disconnect', (done) => {
        let pending = 2;
        const check = () => {
            if (--pending === 0) done();
        };
        subscribe('ms', /mqtt closed/, check);
        brokerSockets.forEach((s) => s.destroy());
        brokerServer.close(check);
    }, 20000);
    it('should reconnect mqtt', (done) => {
        subscribe('ms', /mqtt connected/, () => done());
        brokerSockets = new Set();
        const newServer = net.createServer(broker.handle);
        newServer.on('connection', (socket) => {
            brokerSockets.add(socket);
            socket.on('close', () => brokerSockets.delete(socket));
        });
        newServer.listen(brokerPort, () => {
            brokerServer = newServer;
        });
    }, 20000);
});

describe('script file changes', () => {
    const test1Path = path.join(__dirname, '../testscripts/test1.js');
    // Strip any accumulated "she.info('appended!');" lines so the restore is idempotent.
    const APPEND_MARKER = "\nshe.info('appended!');\n";

    function cleanTest1() {
        const src = fs.readFileSync(test1Path, 'utf8');
        const idx = src.indexOf(APPEND_MARKER);
        if (idx !== -1) {
            fs.writeFileSync(test1Path, src.slice(0, idx));
        }
    }

    afterAll(() => {
        cleanTest1();
    });

    it('should hot-reload when a script file changes', (done) => {
        subscribe('ms', /change detected\. hot-reloading/, () => done());
        setTimeout(() => {
            fs.appendFileSync(test1Path, "\nshe.info('appended!');\n");
        }, 1000);
    }, 10000);
});

describe('she.mqtt.* namespace', () => {
    it('she.mqtt.sub + she.mqtt.pub round-trip should add 1 to published value', (done) => {
        mqttSubscribe('ns/pong', (payload) => {
            if (payload === '11') done();
        });
        mqtt.publish('ns/ping', '10');
    }, 20000);

    it('she.mqtt.get() returns the last received value', (done) => {
        subscribe('ms', /ns\/source via mqtt\.get hello/, () => done());
        mqtt.publish('ns/source', 'hello');
    }, 20000);
});

describe('script file changes — subscription cleanup', () => {
    const reloadScriptPath = path.join(__dirname, '../testscripts/test-reload-cleanup.js');

    beforeAll((done) => {
        fs.writeFileSync(
            reloadScriptPath,
            "/* global she */\n'use strict';\nshe.info('test-reload-cleanup.js running');\nshe.mqtt.sub('ns/cleanup-test', (t, v) => { she.info('cleanup-fired ' + v); });\n",
        );
        subscribe('ms', /test-reload-cleanup\.js running/, () => done());
    }, 20000);

    afterAll(() => {
        try {
            fs.unlinkSync(reloadScriptPath);
        } catch {
            // ignore
        }
    });

    it('new subscriptions work after hot-reload', async () => {
        const reloaded = new Promise((resolve) => {
            subscribe('ms', /test-reload-cleanup\.js running/, resolve);
        });
        fs.appendFileSync(reloadScriptPath, '\n// reload trigger\n');
        await reloaded;

        const logSeen = new Promise((resolve) => {
            subscribe('ms', /cleanup-fired after-reload/, resolve);
        });
        mqtt.publish('ns/cleanup-test', 'after-reload');
        await logSeen;
    }, 20000);

    it('old subscriptions are cancelled on hot-reload — no leak', async () => {
        // Wait for reload to complete before registering the leak-check subscribers.
        // This avoids calling subscribe() inside a subscribe() callback, which would
        // trigger re-entrant matchSubscriptions() and overflow the call stack.
        const reloaded = new Promise((resolve) => {
            subscribe('ms', /test-reload-cleanup\.js running/, resolve);
        });
        fs.appendFileSync(reloadScriptPath, '\n// reload trigger 2\n');
        await reloaded;

        let fired = 0;
        subscribe('ms', /cleanup-fired leak-check/, () => {
            fired++;
        });
        subscribe('ms', /cleanup-fired leak-check/, () => {
            fired++;
        });
        mqtt.publish('ns/cleanup-test', 'leak-check');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(fired).toBe(1);
    }, 20000);
});

describe('she.global — shared mutable object across scripts', () => {
    it('value written by one script is visible to another script', (done) => {
        mqttSubscribe('test/global/result', (payload) => {
            if (payload === 'shared-value-42') {
                mqtt.unsubscribe('test/global/result');
                done();
            }
        });
        mqtt.publish('test/global/set', 'shared-value-42');
        // Wait for the daemon log confirming script-a has processed the set
        // before publishing the get trigger, so she.global is guaranteed to be
        // populated when script-b reads it.
        subscribe('ms', /test-global-a\.js: global-set: shared-value-42/, () => {
            mqtt.publish('test/global/get', '');
        });
    }, 10000);
});

describe('require of a missing module throws and stops the script', () => {
    it('logs the error with script attribution and a normalized path', (done) => {
        subscribe('ms', /test-require-missing\.js: Error: Cannot find module/, () => done());
    }, 20000);

    it('does not execute code after the failing require', async () => {
        let leaked = false;
        subscribe('ms', /unreachable-after-(missing|failing)-require/, () => {
            leaked = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(leaked).toBe(false);
    }, 20000);
});

describe('async callback errors are attributed to the script (S1)', () => {
    it('logs a rejected async subscription callback with the script label', (done) => {
        subscribe('ms', /test-async-error\.js: async callback error: Error: async-muh/, () => done());
        mqtt.publish('test/async-error', '1');
    }, 20000);
});

describe('she.mqtt.age survives repeated identical values (B5)', () => {
    it('returns a finite age after the same value was published twice', (done) => {
        subscribe('ms', /test-age\.js: age-result (\S+)/, (line, m) => {
            expect(Number.isFinite(Number(m[1]))).toBe(true);
            done();
        });
        mqtt.publish('test/age/value', '42');
        mqtt.publish('test/age/value', '42'); // repeat — used to wipe lc from the stored state
        mqtt.publish('test/age/trigger', '1');
    }, 20000);
});

describe('empty payload clears the topic from the state store (B2)', () => {
    // Note: callbacks still firing for empty-payload triggers is covered by the
    // she.global test above (it publishes an empty payload on test/global/get).
    it('removes the topic from the state store', (done) => {
        subscribe('ms', /empty payload, removed topic from state store: test\/retained\/gone/, () => done());
        mqtt.publish('test/retained/gone', '13', { retain: true });
        mqtt.publish('test/retained/gone', '', { retain: true });
    }, 20000);
});

describe('timing helpers (debounce, throttle, timeout) and the sub/pub options', () => {
    it('a debounced subscription bundles the events of several topics into one callback', async () => {
        const seen = [];
        const first = new Promise((resolve) => {
            subscribe('ms', /test-timing\.js: timing-debounced (.+)$/, (line, m) => {
                seen.push(m[1]);
                resolve();
            });
        });
        mqtt.publish('timing/a', '1');
        await new Promise((resolve) => setTimeout(resolve, 100));
        mqtt.publish('timing/b', '2');
        await new Promise((resolve) => setTimeout(resolve, 100));
        mqtt.publish('timing/a', '3');
        await first;
        // the last event's topic and value, objPrev from before the first one (timing/a had no state: {})
        expect(seen).toEqual(['timing/a 3 prev=undefined']);
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(seen).toHaveLength(1);
    }, 20000);

    it('pub with changed: true sends the same payload once', async () => {
        const published = [];
        mqttSubscribe('timing/changed-out', (payload) => published.push(payload));
        const done = (v) =>
            new Promise((resolve) => {
                subscribe('ms', new RegExp(`test-timing\\.js: timing-pub-done ${v}$`), resolve);
            });
        let d = done(1);
        mqtt.publish('timing/pub-trigger', '1');
        await d;
        d = done(1);
        mqtt.publish('timing/pub-trigger', '1');
        await d;
        d = done(2);
        mqtt.publish('timing/pub-trigger', '2');
        await d;
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(published).toEqual(['1', '2']);
    }, 20000);

    it('a bad setTimeout delay is reported with the script name and the timer runs at once', (done) => {
        let warned = false;
        subscribe('ms', /test-timing\.js: setTimeout: delay is not a number of milliseconds \(got "5m"\), using 0/, () => {
            warned = true;
        });
        subscribe('ms', /test-timing\.js: timing-bad-delay-fired/, () => {
            expect(warned).toBe(true);
            done();
        });
        mqtt.publish('timing/bad-delay', '1');
    }, 20000);

    it('she.setTimeout is the tracked sandbox setTimeout', (done) => {
        // both subscriptions up front: a subscribe() inside a subscribe() callback re-enters the matcher
        let idSeen = false;
        subscribe('ms', /test-timing\.js: timing-alias-id object/, () => {
            idSeen = true;
        });
        subscribe('ms', /test-timing\.js: timing-alias-fired/, () => {
            expect(idSeen).toBe(true);
            done();
        });
        mqtt.publish('timing/alias', '1');
    }, 20000);

    it('she.mqtt.timer with swapped arguments throws a TypeError naming the signature', (done) => {
        subscribe('ms', /test-timing-swapped\.js: TypeError: she\.mqtt\.timer\(src, ms, target\): ms must be a number of milliseconds \(got "timing\/presence"\)/, () => done());
        mqtt.publish('timing/swap', '1');
    }, 20000);

    it('a hot reload clears an armed timeout and flushes a debounce with flushOnUnload once', async () => {
        const scriptPath = path.join(__dirname, '../testscripts/test-timing.js');
        const armed = new Promise((resolve) => subscribe('ms', /test-timing\.js: timing-armed pending=true/, resolve));
        mqtt.publish('timing/arm', '1');
        await armed;
        mqtt.publish('timing/flush-later', 'bye');
        await new Promise((resolve) => setTimeout(resolve, 300));

        let fired = 0;
        let flushed = 0;
        subscribe('ms', /test-timing\.js: timing-timeout-fired/, () => fired++);
        subscribe('ms', /test-timing\.js: timing-flushed bye/, () => flushed++);
        subscribe('ms', /test-timing\.js: timing-flushed bye/, () => flushed++);
        const reloaded = new Promise((resolve) => subscribe('ms', /change detected\. hot-reloading/, resolve));
        const original = fs.readFileSync(scriptPath, 'utf8');
        try {
            fs.appendFileSync(scriptPath, '\n// reload trigger\n');
            await reloaded;
            await new Promise((resolve) => setTimeout(resolve, 3500));
            expect(fired).toBe(0);
            expect(flushed).toBe(1);
        } finally {
            fs.writeFileSync(scriptPath, original);
        }
    }, 20000);
});

describe('she.mqtt.command — confirmation, timeout, offline, zigbee2mqtt echo, lint', () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    it('warns at load about a literal publish to a status topic', (done) => {
        subscribe(
            'ms',
            /test-command\.js: she\.mqtt\.pub \(line 8\): "lint\/status\/lamp\/STATE" is a status topic — adapters publish there; a command goes to "lint\/set\/lamp\/STATE"/,
            () => done(),
        );
    }, 20000);

    it('resolves when the status topic echoes the value', async () => {
        const seen = new Promise((resolve) => subscribe('ms', /test-command\.js: command echo ok (\{.*\})/, (line, m) => resolve(JSON.parse(m[1]))));
        const sent = new Promise((resolve) => mqttSubscribe('cmd/set/lamp/STATE', (payload) => resolve(payload)));
        mqtt.publish('cmdtest/trigger/echo', '1');
        expect(await sent).toBe('1');
        mqtt.publish('cmd/status/lamp/STATE', JSON.stringify({ val: true }), { retain: true });
        const r = await seen;
        expect(r).toMatchObject({ val: true, tries: 1 });
        expect(r.ms).toBeGreaterThanOrEqual(0);
    }, 20000);

    it('a command whose status is already at the target resolves at once with already: true', async () => {
        const seen = new Promise((resolve) => subscribe('ms', /test-command\.js: command already ok (\{.*\})/, (line, m) => resolve(JSON.parse(m[1]))));
        mqtt.publish('cmdtest/trigger/already', '1');
        expect(await seen).toMatchObject({ val: true, ms: 0, tries: 1, already: true });
    }, 20000);

    it('fails with reason timeout after the retries and warns with the script name, topic and payload', async () => {
        const warned = new Promise((resolve) =>
            subscribe('ms', /test-command\.js: she\.mqtt\.command cmd\/set\/lamp\/LEVEL ← 0\.5: no confirmation within 1 s \(2 attempts\)/, () => resolve()),
        );
        const failed = new Promise((resolve) => subscribe('ms', /test-command\.js: command timeout failed timeout cmd\/set\/lamp\/LEVEL 0\.5 2/, () => resolve()));
        let sent = 0;
        mqttSubscribe('cmd/set/lamp/LEVEL', () => sent++);
        mqtt.publish('cmdtest/trigger/timeout', '1');
        await warned;
        await failed;
        expect(sent).toBe(2);
    }, 20000);

    it('fails fast with reason offline when <inst>/connected is below 2', async () => {
        mqtt.publish('offline/connected', '1', { retain: true });
        await wait(300);
        const failed = new Promise((resolve) => subscribe('ms', /test-command\.js: command offline failed offline offline\/set\/lamp\/STATE 1 1/, () => resolve()));
        const warned = new Promise((resolve) =>
            subscribe('ms', /test-command\.js: she\.mqtt\.command offline\/set\/lamp\/STATE ← 1: device offline \(offline\/connected = 1\)/, () => resolve()),
        );
        mqtt.publish('cmdtest/trigger/offline', '1');
        await failed;
        await warned;
    }, 20000);

    it('zigbee2mqtt: the device state object confirms the field', async () => {
        const seen = new Promise((resolve) => subscribe('ms', /test-command\.js: command z2m ok (\{.*\})/, (line, m) => resolve(JSON.parse(m[1]))));
        const sent = new Promise((resolve) => mqttSubscribe('z2m/lamp/set', (payload) => resolve(payload)));
        mqtt.publish('cmdtest/trigger/z2m', '1');
        expect(await sent).toBe('{"state":"ON"}');
        mqtt.publish('z2m/lamp', JSON.stringify({ state: 'ON', brightness: 120, linkquality: 60 }), { retain: true });
        expect(await seen).toMatchObject({ val: 'ON', tries: 1 });
    }, 20000);

    it('a pending command is listed as a timer and a hot reload rejects it with reason unloaded', async () => {
        const started = new Promise((resolve) => mqttSubscribe('cmd/set/lamp/LONG', () => resolve()));
        mqtt.publish('cmdtest/trigger/pending', '1');
        await started;
        const unloaded = new Promise((resolve) => subscribe('ms', /test-command\.js: command pending failed unloaded cmd\/set\/lamp\/LONG 1 1/, () => resolve()));
        const reloaded = new Promise((resolve) => subscribe('ms', /test-command\.js: registered/, () => resolve()));
        const file = require('path').join(__dirname, '../testscripts/test-command.js');
        const src = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, src + '\n');
        await unloaded;
        await reloaded;
        fs.writeFileSync(file, src);
    }, 20000);
});

describe('she.time in the sandbox', () => {
    it('iso carries the offset of the configured zone and parses back to the instant', (done) => {
        subscribe('ms', /test-time\.js: time-iso (\d+) (\S+) zone=(\S+)/, (line, match) => {
            const [, ts, iso, zone] = match;
            expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
            expect(Date.parse(iso)).toBe(Math.floor(Number(ts) / 1000) * 1000); // iso is to the second
            expect(Intl.supportedValuesOf('timeZone').concat('UTC')).toContain(zone);
            done();
        });
        mqtt.publish('time/iso', '1');
    }, 20000);

    it('a 22:00–06:00 window is one call, and the sun events come from the daemon', (done) => {
        subscribe('ms', /test-time\.js: time-window night=(\w+) day=(\w+) sunset=(\w+) sunsetDay=(\w+)/, (line, match) => {
            const [, night, day, sunset, sunsetDay] = match;
            expect(night).toBe('true');
            expect(day).toBe('false');
            expect(sunset).toBe('true');
            expect(sunsetDay).toBe('true');
            done();
        });
        mqtt.publish('time/window', '1');
    }, 20000);

    it('isHoliday without a holiday config is false and warns once with the script name', (done) => {
        let warned = 0;
        subscribe('ms', /test-time\.js: she\.time: no holidays configured/, () => {
            warned += 1;
        });
        subscribe('ms', /test-time\.js: time-holiday first=false second=false workdayIsBoolean=true/, () => {
            expect(warned).toBe(1);
            done();
        });
        mqtt.publish('time/holiday', '1');
    }, 20000);
});

describe("additional brokers: she.mqtt('<name>'), mirror rules, offline behaviour", () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * Poll until fn() returns a truthy value. The daemon's own MQTT client receives a message independently of the
     * test's subscriber, so its state store and status may lag the test by a few milliseconds — a one-shot read races.
     */
    const until = async (fn, timeoutMs = 5000, everyMs = 50) => {
        const t0 = Date.now();
        for (;;) {
            const v = await fn();
            if (v) return v;
            if (Date.now() - t0 > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
            await wait(everyMs);
        }
    };
    const getJson = async (urlPath) => (await fetch(`http://127.0.0.1:${httpPort}${urlPath}`)).json();

    it('the daemon started with the shed connected and the late broker not — healthy, scripts running', async () => {
        await new Promise((resolve) => subscribe('ms', /brokers: 2 additional broker\(s\): shed, late/, () => resolve()));
        await new Promise((resolve) => subscribe('ms', /mqtt@shed connected mqtt:\/\/127\.0\.0\.1:\d+/, () => resolve()));
        await new Promise((resolve) => subscribe('ms', /mqtt@late not connected \(.*ECONNREFUSED.*\) — retrying in the background/, () => resolve()));
        httpPort = await new Promise((resolve) => subscribe('ms', /http server listening on :(\d+)/, (line, m) => resolve(Number(m[1]))));
        const health = await fetch(`http://127.0.0.1:${httpPort}/she/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: 'ok', mqtt: 'connected' });
        const status = await (await fetch(`http://127.0.0.1:${httpPort}/she/status`)).json();
        expect(status.brokers.map((b) => [b.name, b.connected])).toEqual([
            ['shed', true],
            ['late', false],
        ]);
        expect(status.brokers[1].error).toMatch(/ECONNREFUSED/);
        expect(status.brokers[0].rules).toBe(4);
    }, 20000);

    it('she.mqtt is callable and keeps its methods; an unknown name is a TypeError at load', async () => {
        await new Promise((resolve) => subscribe('ms', /test-brokers\.js: brokers typeof function function shed null true true/, () => resolve()));
        await new Promise((resolve) => subscribe('ms', /test-brokers-unknown\.js: TypeError: she\.mqtt\("nope"\): no such broker — configured: shed, late/, () => resolve()));
    }, 20000);

    it('a retained value of the shed reaches the subscription and she.on with the mqtt@shed:: key', async () => {
        await new Promise((resolve) => subscribe('ms', /test-brokers\.js: shed retained tele\/preset 42/, () => resolve()));
        await new Promise((resolve) => subscribe('ms', /test-brokers\.js: shed on 42/, () => resolve()));
    }, 20000);

    it('sub, pub and get work on the shed and do not touch the primary', async () => {
        const pong = new Promise((resolve) => shedSubscribe('pong', (payload) => resolve(payload)));
        let primaryPong = 0;
        mqttSubscribe('pong', () => primaryPong++);
        shedMqtt.publish('ping', '1');
        expect(await pong).toBe('2');
        const got = new Promise((resolve) => subscribe('ms', /test-brokers\.js: shed get 1 primary get undefined age true/, () => resolve()));
        mqtt.publish('brokers/trigger/get', '1');
        await got;
        await wait(200);
        expect(primaryPong).toBe(0);
    }, 20000);

    it("the brokers' subscriptions are separate: only/# on each side", async () => {
        const lines = [];
        subscribe('ms', /test-brokers\.js: (primary|shed) only only\/a (\d)/, (line, m) => lines.push(m[1] + ':' + m[2]));
        subscribe('ms', /test-brokers\.js: (primary|shed) only only\/b (\d)/, (line, m) => lines.push(m[1] + ':' + m[2]));
        mqtt.publish('only/a', '1');
        shedMqtt.publish('only/b', '2');
        await until(() => lines.length >= 2);
        await wait(200); // a third line (a leaked subscription) would have to show up by now
        expect(lines.sort()).toEqual(['primary:1', 'shed:2']);
    }, 20000);

    it('a helper works within its broker: shed.link publishes on the shed', async () => {
        const dst = new Promise((resolve) => shedSubscribe('link/dst', (payload) => resolve(payload)));
        shedMqtt.publish('link/src', '7');
        expect(await dst).toBe('7');
    }, 20000);

    /** one delivery of a topic on the primary test client, with its retain flag */
    const onceOnPrimary = (topic) =>
        new Promise((resolve) => {
            const handler = (t, payload, packet) => {
                if (t === topic) {
                    mqtt.removeListener('message', handler);
                    mqtt.unsubscribe(topic);
                    resolve([payload.toString(), packet.retain]);
                }
            };
            mqtt.on('message', handler);
            mqtt.subscribe(topic);
        });

    it('mirror in: tele/# of the shed appears as shed/tele/# on the primary; the retained burst stays retained', async () => {
        // tele/preset was retained on the shed before the daemon started: it arrived in the retained burst and was
        // mirrored retained — a fresh subscriber on the primary gets it as a retained message
        expect(await onceOnPrimary('shed/tele/preset')).toEqual(['42', true]);
        // a live publish arrives at the daemon without the retain flag (MQTT 3.1.1 clears it for established
        // subscriptions), so it is mirrored as a live message; the broker's retained copy comes with the next burst
        const seen = onceOnPrimary('shed/tele/temp');
        shedMqtt.publish('tele/temp', '21.5', { retain: true });
        expect(await seen).toEqual(['21.5', false]);
        // the primary's state store has it like any other topic — polled: the daemon's client gets the message
        // independently of the test's subscriber above
        const entry = await until(async () => (await getJson('/she/mqtt/state')).find((e) => e.topic === 'shed/tele/temp'));
        expect(entry).toMatchObject({ val: 21.5 });
        // and the shed's own view is served by ?broker=
        const shedState = await until(async () => {
            const s = await getJson('/she/mqtt/state?broker=shed');
            return s.find((e) => e.topic === 'tele/temp') && s;
        });
        expect(shedState.find((e) => e.topic === 'tele/temp')).toMatchObject({ val: 21.5 });
        expect(shedState.find((e) => e.topic === 'shed/tele/temp')).toBeUndefined();
        expect((await fetch(`http://127.0.0.1:${httpPort}/she/mqtt/state?broker=nope`)).status).toBe(404);
    }, 20000);

    it('mirror out: shed/set/# of the primary reaches the shed as set/#', async () => {
        const seen = new Promise((resolve) => shedSubscribe('set/lamp', (payload) => resolve(payload)));
        mqtt.publish('shed/set/lamp', '1');
        expect(await seen).toBe('1');
    }, 20000);

    it('loop protection: two rules that form a cycle deliver a message once on each side', async () => {
        let onShed = 0;
        let onPrimary = 0;
        shedSubscribe('loop/x', () => onShed++);
        mqttSubscribe('loop/x', () => onPrimary++);
        await wait(200);
        mqtt.publish('loop/x', 'once');
        await wait(1500);
        expect(onPrimary).toBe(1); // the test client's own publish
        expect(onShed).toBe(1); // mirrored out once, its echo not mirrored back in
        shedMqtt.publish('loop/x', 'twice');
        await wait(1500);
        expect(onShed).toBe(2);
        expect(onPrimary).toBe(2); // mirrored in once, its echo not mirrored back out
    }, 20000);

    it('command on the shed confirms through the shed; on the late broker it fails at once with offline', async () => {
        const sent = new Promise((resolve) => shedSubscribe('dev/set/lamp/STATE', (payload) => resolve(payload)));
        const ok = new Promise((resolve) => subscribe('ms', /test-brokers\.js: shed command ok (\{.*\})/, (line, m) => resolve(JSON.parse(m[1]))));
        mqtt.publish('brokers/trigger/shed-command', '1');
        expect(await sent).toBe('1');
        shedMqtt.publish('dev/status/lamp/STATE', JSON.stringify({ val: true }), { retain: true });
        expect(await ok).toMatchObject({ val: true, tries: 1 });

        const failed = new Promise((resolve) =>
            subscribe('ms', /test-brokers\.js: late command failed offline she\.mqtt\.command dev\/set\/lamp\/STATE ← 1: broker "late" not connected/, () => resolve()),
        );
        mqtt.publish('brokers/trigger/late-command', '1');
        await failed;
    }, 20000);

    it('a publish to the late broker is queued; when the broker comes up it is delivered and the retained values arrive', async () => {
        const queued = new Promise((resolve) => subscribe('ms', /test-brokers\.js: late pub queued/, () => resolve()));
        mqtt.publish('brokers/trigger/late-pub', '1');
        await queued;
        // the broker appears on the late port, with a retained value waiting
        late = new Aedes();
        lateServer = net.createServer(late.handle);
        await new Promise((resolve) => lateServer.listen(latePort, '127.0.0.1', resolve));
        lateMqtt = Mqtt.connect(`mqtt://127.0.0.1:${latePort}`);
        await new Promise((resolve) => lateMqtt.on('connect', resolve));
        const fromShe = new Promise((resolve) => {
            lateMqtt.on('message', (topic, payload) => {
                if (topic === 'from/she') resolve(payload.toString());
            });
            lateMqtt.subscribe('from/she');
        });
        await new Promise((resolve) => lateMqtt.publish('tele/late', '7', { retain: true }, resolve));
        const connected = new Promise((resolve) => subscribe('ms', /mqtt@late connected/, () => resolve()));
        const flushed = new Promise((resolve) => subscribe('ms', /mqtt@late: sent 1 message\(s\) queued while offline/, () => resolve()));
        const retained = new Promise((resolve) => subscribe('ms', /test-brokers\.js: late retained 7/, () => resolve()));
        await connected;
        await flushed;
        expect(await fromShe).toBe('queued');
        await retained;
        // the status flips a moment after the "connected" log line — polled
        const lateStatus = await until(async () => {
            const b = (await getJson('/she/status')).brokers.find((x) => x.name === 'late');
            return b && b.connected && b.queued === 0 && b;
        });
        expect(lateStatus).toMatchObject({ connected: true, error: null, queued: 0 });
    }, 30000);

    it('POST /she/mqtt/publish with "broker" publishes on that broker', async () => {
        const seen = new Promise((resolve) => shedSubscribe('api/pub', (payload) => resolve(payload)));
        const res = await fetch(`http://127.0.0.1:${httpPort}/she/mqtt/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ topic: 'api/pub', payload: 'hi', broker: 'shed' }),
        });
        expect(res.status).toBe(200);
        expect(await seen).toBe('hi');
        const bad = await fetch(`http://127.0.0.1:${httpPort}/she/mqtt/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ topic: 'api/pub', payload: 'hi', broker: 'nope' }),
        });
        expect(bad.status).toBe(404);
    }, 20000);
});

describe("the daemon's own reporting: the redacted config line, maintenance/stats", () => {
    it('logs the configuration as JSON with the secrets masked', async () => {
        const line = await new Promise((resolve) => subscribe('ms', /loaded config: (\{.*\})\s*$/, (l, m) => resolve(m[1])));
        expect(line).not.toContain('Sup3rSecretPw');
        expect(line).not.toContain('[object Object]');
        const cfg = JSON.parse(line);
        expect(cfg.mqttPassword).toBe('***');
        expect(cfg.mqttUsername).toBe('she');
        expect(cfg.statsInterval).toBe(2);
        expect(cfg.brokers.shed.mirror).toHaveLength(4);
        expect(cfg).not.toHaveProperty('_');
        expect(cfg).not.toHaveProperty('data-dir');
    }, 20000);

    it('publishes she/maintenance/stats retained in the mqtt-smarthome shape, with her own fields after it', async () => {
        const payload = await new Promise((resolve) => {
            const handler = (t, p, packet) => {
                if (t === 'she/maintenance/stats') {
                    mqtt.removeListener('message', handler);
                    resolve([JSON.parse(p.toString()), packet.retain]);
                }
            };
            mqtt.on('message', handler);
            mqtt.subscribe('she/maintenance/stats');
        });
        const [stats, retain] = payload;
        expect(retain).toBe(true); // retained on the broker: a fresh subscriber gets the last sample
        expect(Object.keys(stats).slice(0, 7)).toEqual(['rss', 'heapUsed', 'heapTotal', 'cpu', 'eventLoopLag', 'uptime', 'ts']);
        for (const v of Object.values(stats)) expect(typeof v).toBe('number');
        expect(stats.rss).toBeGreaterThan(0);
        expect(stats.heapUsed).toBeGreaterThan(0);
        expect(stats.scripts).toBeGreaterThan(0);
        expect(stats.topics).toBeGreaterThan(0);
        const status = await (await fetch(`http://127.0.0.1:${httpPort}/she/status`)).json();
        expect(status.statsTopic).toBe('she/maintenance/stats');
        expect(status.statsInterval).toBe(2);
        expect(status.stats).toMatchObject({ rss: expect.any(Number), heapUsed: expect.any(Number) });
        expect(status.memory).toMatchObject({ rss: expect.any(Number), heapUsed: expect.any(Number), heapTotal: expect.any(Number), external: expect.any(Number) });
        expect(typeof status.resources).toBe('object');
        expect(typeof status.schedules).toBe('number');
    }, 20000);
});
