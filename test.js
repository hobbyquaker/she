#!/usr/bin/env node

const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const Aedes = require('aedes');
const Mqtt = require('mqtt');

const msCmd = path.join(__dirname, '/mockdate.js');

let msArgs;
let ms;
let broker;
let brokerServer;
let brokerPort;
let brokerSockets = new Set();
let mqtt;

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
        Object.keys(subs).forEach((key) => {
            const sub = subs[key];
            let m;
            if ((m = line.match(sub.rx))) {
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

function startMs() {
    ms = cp.spawn(process.execPath, [msCmd, ...msArgs]);
    const rlOut = readline.createInterface({ input: ms.stdout, crlfDelay: Infinity });
    const rlErr = readline.createInterface({ input: ms.stderr, crlfDelay: Infinity });
    rlOut.on('line', (data) => {
        console.log('ms', data.toString());
        matchSubscriptions('ms', data.toString());
    });
    rlErr.on('line', (data) => {
        console.log('ms', data.toString());
        matchSubscriptions('ms', data.toString());
    });
}

beforeAll((done) => {
    broker = new Aedes();
    brokerServer = net.createServer(broker.handle);
    brokerServer.on('connection', (socket) => {
        brokerSockets.add(socket);
        socket.on('close', () => brokerSockets.delete(socket));
    });
    brokerServer.listen(0, () => {
        brokerPort = brokerServer.address().port;
        msArgs = ['-d', path.join(__dirname, 'testscripts'), '-v', 'debug', '-u', `mqtt://127.0.0.1:${brokerPort}`];
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
    mqtt.end(true, () => {
        brokerServer.close(() => {
            broker.close(done);
        });
    });
});

describe('start daemon', () => {
    it('should start without error', (done) => {
        subscribe('ms', /mqtt-scripts [0-9.]+ starting/, () => done());
        startMs();
    }, 20000);
    it('should connect to the mqtt broker', (done) => {
        subscribe('ms', /mqtt connected/, () => done());
    }, 20000);
    it('should subscribe to #', (done) => {
        subscribe('ms', /mqtt subscribe #/, () => done());
    }, 20000);
    it('should publish 2 on logic/connected', (done) => {
        mqttSubscribe('logic/connected', (payload) => {
            if (payload > 0) {
                mqtt.unsubscribe('logic/connected');
                done();
            }
        });
    }, 20000);
});

describe('script loading', () => {
    it('should load test1.js script file', (done) => {
        subscribe('ms', /testscripts\/test1\.js loading/, () => done());
    }, 20000);
    it('should execute test1.js script file', (done) => {
        subscribe('ms', /testscripts\/test1\.js running/, () => done());
    }, 20000);
    it('should catch a syntax error', (done) => {
        subscribe('ms', /testscripts\/test3\.js SyntaxError/, () => done());
    }, 20000);
});

describe('argument checks', () => {
    it('should throw on wrong arguments for subscribe() - missing callback', (done) => {
        subscribe('ms', /testscripts\/test4\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong arguments for subscribe() - wrong callback', (done) => {
        subscribe('ms', /testscripts\/test5\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong arguments for subscribe() - missing topic', (done) => {
        subscribe('ms', /testscripts\/test16\.js.*TypeError: argument topic missing/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for subscribe()', (done) => {
        subscribe('ms', /testscripts\/test6\.js.*Error: wrong number of arguments/, () => done());
    }, 20000);
    it('should throw on wrong options.condition for subscribe()', (done) => {
        subscribe('ms', /testscripts\/test17\.js.*Error: options.condition/, () => done());
    }, 20000);
    it('should throw on unknown suncalc event for sunSchedule()', (done) => {
        subscribe('ms', /testscripts\/test8\.js.*TypeError: unknown suncalc event/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for sunSchedule()', (done) => {
        subscribe('ms', /testscripts\/test9\.js.*Error: wrong number of arguments/, () => done());
    }, 20000);
    it('should throw on wrong callback type for sunSchedule() #1', (done) => {
        subscribe('ms', /testscripts\/test10\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong callback type for sunSchedule() #2', (done) => {
        subscribe('ms', /testscripts\/test11\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on out-of-range shift for sunSchedule()', (done) => {
        subscribe('ms', /testscripts\/test15\.js.*Error: options.shift out of range/, () => done());
    }, 20000);
    it('should throw on wrong callback type for schedule() #1', (done) => {
        subscribe('ms', /testscripts\/test12\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong callback type for schedule() #2', (done) => {
        subscribe('ms', /testscripts\/test13\.js.*TypeError: callback is not a function/, () => done());
    }, 20000);
    it('should throw on wrong number of arguments for schedule()', (done) => {
        subscribe('ms', /testscripts\/test14\.js.*Error: wrong number of arguments/, () => done());
    }, 20000);
});

describe('testscripts/test1.js execution', () => {
    it('should log a msg', (done) => {
        subscribe('ms', /testscripts\/test1\.js: test log/, () => done());
    }, 20000);
    it('should return true on getValue()', (done) => {
        subscribe('ms', /testscripts\/test1\.js: test1 true/, () => done());
    }, 20000);
});

describe('require()', () => {
    it('should load a lib file', (done) => {
        subscribe('ms', /require test/, () => done());
    }, 60000);
    it('should load a module', (done) => {
        subscribe('ms', /Dummy Module/, () => done());
    }, 60000);
    it('should throw on invalid module', (done) => {
        subscribe('ms', /ReferenceError: thisDoesNotExist is not defined/, () => done());
    }, 60000);
});

describe('subscribe(), setValue()', () => {
    it('should increase a number', (done) => {
        mqttSubscribe('test/set/incr', (payload) => {
            if (payload === '5') {
                done();
            }
        });
        mqtt.publish('test/status/incr', '4');
    }, 20000);
});

describe('subscribe()', () => {
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
            if (m[1] === '5') done();
        });
    }, 20000);
});

describe('getProp(), now()', () => {
    it('should return a lastchange and a timestamp with ~5000ms difference', (done) => {
        subscribe('ms', /test\/target lc ([0-9]+) ([0-9]+)/, (line, m) => {
            const elapsed = parseInt(m[2]) - parseInt(m[1]);
            if (elapsed > 4800 && elapsed < 5200) done();
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
        subscribe('ms', /testscripts\/test1\.js Error: test exception/, () => done());
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
        const check = () => { if (--pending === 0) done(); };
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
    it('should quit when a script file changes', (done) => {
        subscribe('ms', /change detected\. exiting/, () => done());
        setTimeout(() => {
            fs.appendFileSync(path.join(__dirname, 'testscripts/test1.js'), "\nlog.info('appended!');\n");
        }, 1000);
    }, 10000);
});
