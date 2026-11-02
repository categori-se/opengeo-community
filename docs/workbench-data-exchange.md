# Working with imported data

## MapInfo archives

In the managed upload dialog, select **MapInfo ZIP (TAB or MIF/MID)** for a ZIP
containing one native TAB table or MIF/MID pair. ZIP inference still defaults to
Shapefile. A native TAB table needs matching DAT/MAP/ID companions; an optional
IND index and safe metadata files remain preserved. Linked tables, unsafe DAT
references, incomplete companions and ambiguous datasets fail explicitly.

The original ZIP remains downloadable. Working Parquet retains attributes,
geometry and CRS; the existing geographic preview supplies Catalog inspection
and exact-version map composition. Add the saved version to the map and save the
Project to retain its dataset/version identity. A truncated preview is disclosed
and refused as a complete Layer. Inspection never downloads the original ZIP as
browser GeoJSON. Native styles remain in the original; reusable Style translation
and MapInfo working export are not provided. Generic geometry or unnamed/missing
catalog CRS labels are retained without inventing a more precise classification.

Migration 0185 and compatible worker consumers must precede API/Studio admission.
Existing account permissions, original-download authority and opt-in processing
limits apply. Hosted persistence and release-image qualification need their own
acceptance; local source publication does not establish them.

## KML Place properties

The Place editor supports altitude mode, extrusion, eligible edge tessellation,
direct Point altitude and TimeStamp/TimeSpan values. Mixed imported controls stay
unchanged until deliberately edited. Invalid input keeps the draft and focuses
its inline error. KML export and native Project files preserve these properties;
older readers reject representations they cannot retain.

Leap-second source text remains preserved. Ordering around leap seconds retains
a one-second uncertainty without a leap table; full KML conformance is not implied.

## Editable GPS and delimited copies

Create an editable copy to change coordinates while retaining the imported GPX,
NMEA, OziExplorer or delimited source metadata and original bytes. GPX working
export retains source time, extensions and track gaps for supported coordinate
edits with unchanged feature, type and vertex identity. Unsupported structural
edits fail explicitly. Original downloads retain the imported bytes.

For a GPX Layer, open **Advanced** and choose **Download working GPX** to download
its current coordinates as GPX. This remains separate from the original download.
Temporary local imports remain scoped to their browser map and are excluded from
account Save; download the required source and working data deliberately.
Device transfer and general native-format authoring remain separate capabilities.
