/* global she */
'use strict';

// she.time: the daemon-side wiring of the time library (zone, sun events, holiday config).

she.mqtt.sub('time/iso', () => {
    const ts = she.now();
    she.info('time-iso ' + ts + ' ' + she.time.iso(ts) + ' zone=' + she.time.zone);
});

she.mqtt.sub('time/window', () => {
    const day = she.now();
    const night = she.time.between('22:00', '06:00', she.time.at('23:30', day));
    const noon = she.time.between('22:00', '06:00', she.time.at('12:00', day));
    const sunset = she.time.at('sunset', day);
    const sunsetDay = sunset >= she.time.startOfDay(day) && sunset <= she.time.endOfDay(day);
    she.info('time-window night=' + night + ' day=' + noon + ' sunset=' + (typeof sunset === 'number' && !Number.isNaN(sunset)) + ' sunsetDay=' + sunsetDay);
});

she.mqtt.sub('time/holiday', () => {
    const first = she.time.isHoliday();
    const second = she.time.isHoliday(Date.UTC(2026, 11, 25, 12));
    she.info('time-holiday first=' + first + ' second=' + second + ' workdayIsBoolean=' + (typeof she.time.isWorkday() === 'boolean'));
});
