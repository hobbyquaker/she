/* global she */
'use strict';

she.api.get('/hello', () => ({ message: 'hello' }));

she.api.get('/greet/:name', (req) => ({ greeting: 'Hello, ' + req.params.name }));

she.api.post('/echo', (req, body) => ({ echo: body }));

she.api.get('/mqtt-value', () => ({ value: she.getValue('test/value') }));

she.api.get('/log', (req) => {
    she.log('log-endpoint-called', req.query.msg || '');
    return { ok: true };
});

she.api.put('/items/:id', (req, body) => ({ updated: req.params.id, data: body }));

she.api.delete('/items/:id', (req) => ({ deleted: req.params.id }));
