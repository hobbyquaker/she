'use strict';

/**
 * The functions the home model seeds when it is switched on: a purpose per entity, independent of
 * the room ("all lighting on the ground floor", "every window contact"). Ids are English and stable;
 * the name is taken in the language of the moment and is the user's from then on, like the rules.
 *
 * A rule is `{component, device_class?, entity_category?, not?}`. Each field is a value or a list
 * of values, `null` standing for "not set"; `not` is a rule (or a list) that must not match. An
 * entity belongs to a function when one of its rules matches.
 */

const DEFAULT_FUNCTIONS = [
    {
        id: 'lighting',
        name: { en: 'Lighting', de: 'Licht' },
        icon: 'mdi:lightbulb',
        rules: [{ component: 'light' }],
    },
    {
        id: 'shading',
        name: { en: 'Shading', de: 'Beschattung' },
        icon: 'mdi:window-shutter',
        rules: [{ component: 'cover', device_class: ['shutter', 'blind', 'awning', 'curtain', 'shade', null] }],
    },
    {
        id: 'heating',
        name: { en: 'Heating', de: 'Heizung' },
        icon: 'mdi:radiator',
        rules: [{ component: ['climate', 'water_heater'] }],
    },
    {
        id: 'climate',
        name: { en: 'Indoor climate', de: 'Raumklima' },
        icon: 'mdi:thermometer',
        // a device's own diagnostic temperature is not the room's climate
        rules: [
            {
                component: 'sensor',
                device_class: [
                    'temperature',
                    'humidity',
                    'carbon_dioxide',
                    'pm25',
                    'volatile_organic_compounds',
                    'volatile_organic_compounds_parts',
                    'pressure',
                    'atmospheric_pressure',
                ],
                entity_category: null,
            },
        ],
    },
    {
        id: 'openings',
        name: { en: 'Windows and doors', de: 'Fenster und Türen' },
        icon: 'mdi:window-open-variant',
        rules: [
            { component: 'binary_sensor', device_class: ['window', 'door', 'opening', 'garage_door'] },
            { component: 'cover', device_class: ['garage', 'door', 'gate', 'window'] },
        ],
    },
    {
        id: 'security',
        name: { en: 'Security', de: 'Sicherheit' },
        icon: 'mdi:shield-home',
        rules: [
            { component: ['lock', 'alarm_control_panel'] },
            { component: 'binary_sensor', device_class: ['smoke', 'gas', 'moisture', 'tamper', 'safety', 'motion', 'occupancy'] },
        ],
    },
    {
        id: 'energy',
        name: { en: 'Energy', de: 'Energie' },
        icon: 'mdi:lightning-bolt',
        rules: [{ component: 'sensor', device_class: ['power', 'energy'] }],
    },
    {
        id: 'presence',
        name: { en: 'Presence', de: 'Anwesenheit' },
        icon: 'mdi:home-account',
        rules: [{ component: 'device_tracker' }, { component: 'binary_sensor', device_class: 'presence' }],
    },
    {
        id: 'media',
        name: { en: 'Media', de: 'Medien' },
        icon: 'mdi:television',
        // discovery has no media player: what plays media is assigned by hand
        rules: [{ component: 'media_player' }],
    },
    {
        id: 'maintenance',
        name: { en: 'Maintenance', de: 'Wartung' },
        icon: 'mdi:wrench',
        rules: [{ component: 'sensor', device_class: 'battery' }, { component: 'binary_sensor', device_class: ['battery', 'problem', 'update'] }, { component: 'update' }],
    },
];

const LANGUAGES = ['en', 'de'];

/** `de-DE`, `de`, `DE_de` → `de`; anything unknown → `en`. */
function normaliseLanguage(language) {
    const short = String(language || '')
        .trim()
        .toLowerCase()
        .slice(0, 2);
    return LANGUAGES.includes(short) ? short : 'en';
}

module.exports = { DEFAULT_FUNCTIONS, LANGUAGES, normaliseLanguage };
