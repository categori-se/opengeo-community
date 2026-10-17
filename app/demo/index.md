---
title: Public OpenGeo Studio workbench
toc: false
---

```js
import {PublicDemoWorkbench} from "./components/PublicDemoWorkbench.js";
import {validatePublicDemoCatalog} from "./lib/publicationPolicy.js";
import {mapFontAttachments} from "./lib/mapFontAttachments.js";
import {loadStudioPage} from "./lib/studioPageBootstrap.js";
```

```js
const demoSurface = await loadStudioPage(async () => {
  const publicCatalog = validatePublicDemoCatalog(
    await FileAttachment("./data/public-demo-catalog.json").json()
  );
  const facilities = await FileAttachment("./data/sample-public-facilities.geojson").json();
  const massgis = await FileAttachment("./data/massgis-enviroscreen.json").json();
  return PublicDemoWorkbench({catalog: publicCatalog, geojson: facilities, massgis, mapFontAttachments});
});
```

```js
display(demoSurface);
invalidation.then(() => demoSurface.dispose?.());
```
