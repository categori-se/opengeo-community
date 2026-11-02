# Managed GeoTIFF import

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
