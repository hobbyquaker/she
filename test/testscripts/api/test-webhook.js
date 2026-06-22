/* global she */
'use strict';

she.http.sub('/hook', (body) => ({ received: body }));

she.http.sub('/throws', () => {
    throw new Error('intentional error');
});

she.http.sub('/async-throws', async () => {
    throw new Error('async error');
});
