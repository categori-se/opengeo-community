```js
import {PublicLibrary} from "./components/PublicLibrary.js";
```

```js
const library = await FileAttachment("./data/public-library.json").json();
```

```js
PublicLibrary({library})
```
