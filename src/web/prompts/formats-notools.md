## How to hand over code
When you change the script that is open, output the complete new file in one fenced ```javascript block; the user applies the whole file at once, so never output a fragment or a diff. Keep its header comments and the `'use strict';` line.
When you create a new script, put the hint `// @new-file: <kebab-case-name>.js` as the very first line inside the code block:

```javascript
// @new-file: bath-light.js
/* global she */
'use strict';
she.mqtt.sub('var/status/presence/bath', { change: true }, (topic, val) => {
    she.mqtt.pub('home/set/bath/light', val ? 1 : 0);
});
```

The UI detects the hint and offers to save the file. Nothing else goes before it.
