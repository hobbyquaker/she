/* global she */
'use strict';

// she.mqtt('<name>'): the additional brokers of the integration test — "shed" (a second test broker,
// with mirror rules) and "late" (nothing listens on its port until a test starts a broker there).

const shed = she.mqtt('shed');
const late = she.mqtt('late');
she.log(`brokers typeof ${typeof she.mqtt} ${typeof she.mqtt.sub} ${shed.broker} ${she.mqtt.broker} ${she.mqtt() === she.mqtt} ${she.mqtt('shed') === shed}`);

// the shed's retained values arrive whenever it is connected
shed.sub('tele/preset', { retain: true }, (topic, val) => she.log(`shed retained ${topic} ${val}`));
she.on('mqtt@shed::tele/preset', (val) => she.log(`shed on ${val}`));

// a round trip on the shed only
shed.sub('ping', (topic, val) => shed.pub('pong', Number(val) + 1));
she.mqtt.sub('brokers/trigger/get', () => she.log(`shed get ${shed.get('ping')} primary get ${she.mqtt.get('ping')} age ${shed.age('ping') <= 5}`));

// the brokers' subscriptions do not see each other's topics
she.mqtt.sub('only/#', (topic, val) => she.log(`primary only ${topic} ${val}`));
shed.sub('only/#', (topic, val) => she.log(`shed only ${topic} ${val}`));

// a helper works within its broker
shed.link('link/src', 'link/dst');

// commands on the two additional brokers
function report(name, p) {
    p.then(
        (r) => she.log(`${name} command ok`, r),
        (e) => she.log(`${name} command failed`, e.reason, e.message),
    );
}
she.mqtt.sub('brokers/trigger/shed-command', () => report('shed', shed.command('dev/set/lamp/STATE', 1, { timeout: 2 })));
she.mqtt.sub('brokers/trigger/late-command', () => report('late', late.command('dev/set/lamp/STATE', 1, { timeout: 1 })));

// the late broker: a publish while it is down is queued, its retained values come when it connects
late.sub('tele/late', { retain: true }, (topic, val) => she.log(`late retained ${val}`));
she.mqtt.sub('brokers/trigger/late-pub', () => {
    late.pub('from/she', 'queued');
    she.log('late pub queued');
});
