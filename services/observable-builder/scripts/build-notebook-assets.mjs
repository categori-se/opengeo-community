import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildNotebookAssets} from './notebook-assets.mjs';

// Runs while assembling the compiler image, never while building user source.
const root = fileURLToPath(new URL('..', import.meta.url));
await writeFile(new URL('../notebook-assets.json', import.meta.url), JSON.stringify(await buildNotebookAssets(root)));
