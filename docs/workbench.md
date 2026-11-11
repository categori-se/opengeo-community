# Reuse coordinate import settings

In the delimited-coordinate wizard, open **Reuse import settings** to download
or import a JSON template. A template contains the separator, source coordinate
system, coordinate/elevation/label column names, elevation unit and datum, and
uniform or categorized Point colors. It contains no source records, credentials,
account grants or permission to omit invalid rows.

Templates use `opengeo.delimited-import-template.1` and are limited to 16 KiB.
Supported separators are comma, tab, semicolon and pipe; source coordinate systems
are EPSG:4326 and EPSG:3857. Elevation units are meter, foot and US survey foot.
Every named column must exist in the chosen source, and coordinate/elevation
columns must be distinct. Invalid or incompatible templates leave the existing
choices intact.

Applying a template resets permission to omit invalid rows. Continue through the
normal preview, source review and Add Layer steps. Templates operate in the
browser; saving a Project retains the resulting Layer and source through the
existing save workflow. A template does not transfer source data or authorize
access to another account.

## Restoring layers after a basemap change

Studio restores already loaded layers if the new map style removes their sources or paint layers.

## Exchange a camera tour

Use the [KML camera tour guide](workbench-kml-tour.md) to import a bounded tour,
review conversion differences and download the original and converted files.
