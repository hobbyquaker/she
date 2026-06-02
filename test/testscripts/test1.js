she.info('test log');

she.mqttsub('test/status/incr', function (topic, val) {
    val += 1;
    she.setValue('test/set/incr', val);
});

she.mqttsub('test/target', () => {
    setTimeout(() => {
        she.info('test/target age', she.age('test/target'));
        she.info('test/target lc', she.getProp('test/target', 'lc'), she.now());
    }, 5000);
});

she.link('test/src', 'test/target');
she.link(['test/src1', 'test/src2'], ['test/target1', 'test/target2']);
she.link('test/src3', 'test/target3', '1337');
she.link('test/src4', 'test/target4', (val) => 2 * val);

she.schedule('* * * * *', () => {
    she.info('schedule callback');
    setTimeout(function () {
        throw new Error('test exception!');
    }, 2000);
});

she.schedule('0 0 * * *', () => {
    she.info('midnight!');
});

she.schedule({ hour: 0, minute: 0, second: 10 }, () => {
    she.info('schedule date');
});

let mscount = 1;

she.schedule(['12 0 0 * * *', '15 0 0 * * *'], { random: 2 }, () => {
    she.info('multi schedule', mscount++);
});

she.mqttsub('test/condition', 'val=="muh"', (topic, val) => {
    she.info(topic, she.getProp(topic).val);
    she.getProp(topic, 'does', 'not', 'exist');
});

she.info(she.getProp('does', 'not', 'exist'));

she.mqttsub('test/change', { change: true }, (topic, val) => {
    she.info(topic, val);
});

she.mqttsub('test/randomshift', { random: 10, shift: 10 }, (topic, val) => {
    she.info(topic, val);
});

she.mqttsub(/regexp/, (topic, val) => {
    she.info(topic, val);
});

she.info(require('./lib/libtest.js'));
she.info(require('dummy'));
require('./lib/libtest2.js');
const suncalc = require('suncalc');

she.schedule('sunrise', { shift: -1620, random: 360 }, () => {
    she.info('27-33min before sunrise');
});

she.schedule(['dawn', 'dusk'], () => {
    she.info('multiple sun events');
});

she.mqttsub('test1', (topic, val) => {
    she.info(topic, she.getValue('test1'));
});

she.mqttpub(['test1', 'test2'], { val: true });

she.set('var::testvar1', true);
she.set('var::testvar1', true);
she.setValue('var/set/testvar2', true);
she.setValue('var/set/testvar2', { val: true });
