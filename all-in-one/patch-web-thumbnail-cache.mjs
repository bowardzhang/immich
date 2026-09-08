import fs from 'node:fs/promises';

const file = 'web/src/lib/components/assets/thumbnail/Thumbnail.svelte';
let source = await fs.readFile(file, 'utf8');

const marker = 'remote-storage-repair-20260908';
const before = 'cacheKey: asset.thumbhash';
const after = `cacheKey: \`${'${asset.thumbhash ?? \'\'}'}-${marker}\``;

const matches = source.split(before).length - 1;
if (matches < 2) {
  throw new Error(`Unable to apply thumbnail cache repair patch: expected at least 2 cacheKey occurrences, found ${matches}`);
}

source = source.replaceAll(before, after);
await fs.writeFile(file, source);
console.log(`[aio-build] thumbnail cache-bust patch applied to ${matches} media URLs (${marker})`);
