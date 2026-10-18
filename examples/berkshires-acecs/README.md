# Berkshire conservation designations

This small real-data study counts historical conservation designations and their
municipality attributes. The 284,185-byte MassGIS-derived GeoJSON is retained
unchanged. It contains 16 records, five distinct `ACECID` values and eleven
distinct `TOWN` values. The page and analysis use local files without a remote
data dependency; the source and rights links provide references for readers.

From the repository root, reproduce the calculation with Node.js 24:

```bash
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {summarizeArchive} from './examples/berkshires-acecs/analysis.js';

const bytes = readFileSync('examples/berkshires-acecs/data/acecs.geojson');
const checksum = createHash('sha256').update(bytes).digest('hex');
if (checksum !== '1a436462c200365cce9235e79815e1458aabb22d4add893057172817d2e9663f') {
  throw new Error('The retained input has changed.');
}
console.log(JSON.stringify(summarizeArchive(JSON.parse(bytes)), null, 2));
JS
```

`index.md` is an Observable Framework publication page. Keep `analysis.js`,
`provenance.json` and `data/acecs.geojson` beside it when placing these files in an
existing Framework source project. No dependency installation or remote dataset
download is needed for the calculation. Framework compilation and delivery use
the installation's existing publication workflow. The current native compiler
and actual browser render its map, legend and calculated tables locally. The
editable map also passes actual backup import, opacity revision, Save and reload
with its geometry and category styles preserved. These checks reuse cached
software and do not establish real sign-in, independent installation or hosted
delivery. The Publication ZIP also passes import, Save draft and reopening in a
fresh public-source workspace, with all four saved file hashes unchanged.

## Open and revise the map

After the repository's normal `npm ci --prefix app`, create the two supported
Studio packages without a network request:

```bash
node examples/berkshires-acecs/package-study.mjs /tmp/opengeo-berkshires-study
```

Choose a new output directory; existing output files are never replaced. In the
browser workspace, open **On this device → Import Project backup**, choose
`berkshires-acecs.opengeo-project.zip`, review it, and **Save imported Project**.
Open the saved Project. All 16 records start visible, with distinct designation
colors, transparent fills and restrained outlines. The blank background needs
no provider service. Choose **Layer → Layer properties** to change colors,
opacity or the categorization field, then save and reopen the Project. Download
an updated backup to carry your revision to another device.

In an authored Publication's **Files** editor, expand the **Files** tray, then
**Import files or a project folder**. Choose **OpenGeo Studio source project ZIP** and review
`berkshires-acecs.publication-source.zip`. **Use imported source** loads the working
draft. Review rights, choose **Save draft**, then reopen the Publication to continue
editing. Publishing is a separate action. The bundle
includes the original input, method and provenance, with no hosted dependency
binding or credentials. Native Framework rendering uses the compiler's pinned
D3 cache for the map. Compiler and Studio software are not bundled in these input
packages; having the input files offline does not install those applications.

In Studio, use **Files** in the Publication source editor and the existing
**Catalog file** connection to select the already registered **Areas of Critical
Environmental Concern** Layer and its retained source version. Use the attachment
path `data/acecs.geojson`, preserving the local import `./analysis.js`. Do not
upload the same Layer again or replace the existing production map. The source
example is portable; the hosted identifiers in `provenance.json` are references,
not access grants. An external-reference Layer requires an eligible retained
data object before it can supply a pinned native file; its Catalog registration
alone does not prove that attachment path is available. An installation without
that retained object can compile the included files through its existing source
files workflow without changing the hosted Catalog.

Preserve the MassGIS source credit and the separate provider/archive rights
facts in `provenance.json`. The provider states that its data is public domain
and allows redistribution with source credit. The historical archive has no
separate file-level license statement and is not labeled CC0. Export/capture
dates remain unknown. Do not sum the repeated designation-level area fields or
use this planning inventory as a current regulatory boundary determination.
