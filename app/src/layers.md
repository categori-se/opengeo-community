```js
import {loadBrowserAuthConfig} from "./lib/authConfig.js";
import {createCognitoBrowserAuth} from "./lib/cognitoAuth.js";
import {createPlatformAdapter} from "./lib/platform.js";
import {layerRouteTarget} from "./lib/applicationRoutes.js";
import {LayerResourcePage} from "./components/LayerResourcePage.js";
```

```js
const catalog = await FileAttachment("./data/catalog.json").json();
const query = new URL(location.href).searchParams;
const runtimeAuthConfig = query.get("adapter") === "fixture"
  ? null : await loadBrowserAuthConfig().catch(() => null);
const platform = createPlatformAdapter({catalog, capabilities: runtimeAuthConfig?.capabilities});
const auth = createCognitoBrowserAuth({configLoader: runtimeAuthConfig ? async () => runtimeAuthConfig : null});
const resourcePage = LayerResourcePage({adapter: platform, target: layerRouteTarget(query), auth});
```

```js
resourcePage
```

```js
invalidation.then(() => resourcePage.dispose?.());
```
