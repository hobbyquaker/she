// Port of https://github.com/hobbyquaker/mqtt-wildcard (MIT)

/**
 * Test whether `topic` matches an MQTT `wildcard` pattern.
 * Returns an array of matched wildcard segments on success, or `null` if no match.
 */
export function mqttWildcard(topic: string, wildcard: string): string[] | null {
    if (topic === wildcard) return [];
    if (wildcard === '#') return [topic];

    const res: string[] = [];
    const t = topic.split('/');
    const w = wildcard.split('/');

    let i = 0;
    for (const lt = t.length; i < lt; i++) {
        if (w[i] === '+') {
            res.push(t[i]);
        } else if (w[i] === '#') {
            res.push(t.slice(i).join('/'));
            return res;
        } else if (w[i] !== t[i]) {
            return null;
        }
    }

    if (w[i] === '#') i += 1;
    return i === w.length ? res : null;
}
