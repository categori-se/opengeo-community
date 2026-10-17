# People and access

Manage account membership and roles. Share individual content from its own access settings.

```js
import {TeamAdministration} from "./components/TeamAdministration.js";
import {loadBrowserAuthConfig} from "./lib/authConfig.js";
import {createCognitoBrowserAuth} from "./lib/cognitoAuth.js";
import {createPlatformAdapter} from "./lib/platform.js";
```

```js
const catalog = await FileAttachment("./data/catalog.json").json();
```

```js
const query = new URL(location.href).searchParams;
const runtimeAuthConfig = query.get("adapter") === "fixture"
  ? null
  : await loadBrowserAuthConfig().catch(() => null);
const platform = await createPlatformAdapter({catalog, capabilities: runtimeAuthConfig?.capabilities, previewOrigins: runtimeAuthConfig?.previewOrigins});
const auth = createCognitoBrowserAuth({
  configLoader: runtimeAuthConfig ? async () => runtimeAuthConfig : null
});
```

```js
TeamAdministration({adapter: platform, auth})
```
