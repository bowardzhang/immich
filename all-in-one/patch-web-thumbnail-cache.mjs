import fs from 'node:fs/promises';

const marker = 'remote-storage-repair-20260908';

// Timeline thumbnails: invalidate the stale failed thumbnail URLs once.
const thumbnailFile = 'web/src/lib/components/assets/thumbnail/Thumbnail.svelte';
let thumbnailSource = await fs.readFile(thumbnailFile, 'utf8');
const thumbnailBefore = 'cacheKey: asset.thumbhash';
const thumbnailAfter = `cacheKey: \`${'${asset.thumbhash ?? \'\'}'}-${marker}\``;
const thumbnailMatches = thumbnailSource.split(thumbnailBefore).length - 1;
if (thumbnailMatches < 2) {
  throw new Error(
    `Unable to apply thumbnail cache repair patch: expected at least 2 cacheKey occurrences, found ${thumbnailMatches}`,
  );
}
thumbnailSource = thumbnailSource.replaceAll(thumbnailBefore, thumbnailAfter);
await fs.writeFile(thumbnailFile, thumbnailSource);
console.log(`[aio-build] thumbnail cache-bust patch applied to ${thumbnailMatches} media URLs (${marker})`);

// Memory Lane does not render through Thumbnail.svelte. Upstream currently calls
// getAssetMediaUrl({ id }) directly, so it has neither an explicit thumbnail size
// nor a thumbhash cache key. Force it onto the same repaired thumbnail path as the
// timeline and give it a one-time cache version so browsers/service workers cannot
// reuse an old failed Memory Lane image response.
const photosPageFile = 'web/src/routes/(user)/photos/[[assetId=id]]/+page.svelte';
let photosPageSource = await fs.readFile(photosPageFile, 'utf8');

const sdkImportBefore = "import { AssetVisibility } from '@immich/sdk';";
const sdkImportAfter = "import { AssetMediaSize, AssetVisibility } from '@immich/sdk';";
if (!photosPageSource.includes(sdkImportBefore)) {
  throw new Error('Unable to apply Memory Lane repair: AssetVisibility import marker not found');
}
photosPageSource = photosPageSource.replace(sdkImportBefore, sdkImportAfter);

const memoryBefore = 'src: getAssetMediaUrl({ id: memory.assets[0].id }),' ;
const memoryAfter = `src: getAssetMediaUrl({ id: memory.assets[0].id, size: AssetMediaSize.Thumbnail, cacheKey: \`${'${memory.assets[0].thumbhash ?? \'\'}'}-${marker}-memory\` }),`;
const memoryMatches = photosPageSource.split(memoryBefore).length - 1;
if (memoryMatches !== 1) {
  throw new Error(`Unable to apply Memory Lane repair: expected 1 media URL occurrence, found ${memoryMatches}`);
}
photosPageSource = photosPageSource.replace(memoryBefore, memoryAfter);
await fs.writeFile(photosPageFile, photosPageSource);
console.log(`[aio-build] Memory Lane thumbnail URL repair applied (${marker}-memory)`);
