# Login

Sign in once, then continue directly to the project, team, file, or account
screen you requested.

```js
import {SessionPanel} from "./components/SessionPanel.js";
import {createCognitoBrowserAuth} from "./lib/cognitoAuth.js";
import {createPlatformAdapter} from "./lib/platform.js";
```

```js
const catalog = await FileAttachment("./data/catalog.json").json();
```

```js
const platform = createPlatformAdapter({catalog});
const browserAuth = platform.kind === "api" ? createCognitoBrowserAuth() : null;
```

```js
SessionPanel({adapter: platform, auth: browserAuth})
```
