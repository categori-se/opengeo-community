# Managed raster imports

Managed TIFF uploads default to `geotiff`; deliberate `cog` uploads retain strict
original-COG validation. GeoTIFF ingestion preserves the original and creates one
lossless full-resolution working COG. The worker verifies its layout, dimensions,
affine grid, authoritative CRS, band types and nodata against the source. Native
extent and CRS remain unchanged; `raster.display_bounds_crs84` separately records
validated GDAL geographic display bounds. Missing georeferencing or display bounds
fails explicitly. No CRS is guessed and opening a map never starts normalization.

`raster.working_cog` binds the actual uploaded object UUID, filename, SHA256 and
size. The managed reader requires one matching working object and a passed
`geotiff_working_cog_verified` check. Partial, ambiguous or mismatched declarations
fail before a ticket. Private range reads keep their existing authorization,
immutable storage-version and request/byte limits; a range read does not verify
the whole-file checksum. Projects retain dataset/version/object pins, with no
private URL or ticket. Working provenance uses `:working:<object UUID>`; original
COG provenance retains `:original`. Original downloads remain available. Existing
MapLibre projection, latitude and bounded-view limits still apply. Ordinary GeoTIFF
WCS publication and arbitrary raster formats remain unavailable.

NITF (`.ntf`, `.nitf`) and ERDAS Imagine (`.img`) use the same upload and map
workflow. Their source formats remain `nitf` and `img`; original downloads return
the unchanged native file. A separate full-resolution working COG supplies map
reads. The reader requires an exact supported `raster.source_format`, one passed
`working_cog_verified` check and matching working-object ID, filename, size and
checksum. A version format, when exposed, must agree with the source format.
GeoTIFF retains its existing `geotiff_working_cog_verified` check.

Native source and working CRS definitions remain separate metadata. GDAL OSR
must establish semantic CRS equivalence, and data-axis mappings must match.
Source band interpretations stay recorded; undefined source color interpretation
is disclosed when a working TIFF uses GDAL's default grayscale tag. Grid,
dimensions, band types and nodata must match. Geographic display bounds are
separate from native extents.

These native formats require self-contained affine georeferencing. Multi-image
containers, external companion files and RPC/GCP-only positioning fail explicitly.
Existing browser projection and bounded-view limits still apply; this does not
add WCS publication. Opening a map starts no normalization job.

Apply migrations 0183/0184 and qualify the compatible worker before enabling the
corresponding API/Studio admission. Drain older worker consumers first. Rollback
must stop new admission while preserving originals, working objects, enum values
and compatible readers. Source publication alone does not establish deployment,
target-image qualification or real-account persistence.
