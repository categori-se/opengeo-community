```js
import {StartPage} from "./components/StartPage.js";
import {createPlatformAdapter} from "./lib/platform.js";
import {mapFontAttachments} from "./lib/mapFontAttachments.js";
import {publicStudioEntryDestination} from "./lib/authNavigation.js";
const entryDestination = publicStudioEntryDestination();
if (entryDestination) location.replace(entryDestination);
```

```js
const catalog = await FileAttachment("./data/catalog.json").json();
```

```js
const library = await FileAttachment("./data/public-library.json").json();
```

```js
const platform = createPlatformAdapter({catalog});
```

```js
if (!entryDestination) {
  const startSurface = StartPage({catalog, library, adapter: platform, mapFontAttachments});
  display(startSurface);
  invalidation.then(() => startSurface.dispose?.());
}
```
