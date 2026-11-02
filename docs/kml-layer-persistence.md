# KML style exchange

KML `IconStyle`, `LabelStyle`, `LineStyle` and `PolyStyle` retain their
`colorMode` values through native Project, KML and KMZ exchange. Point, LineString
and Polygon previews apply `normal` colors or stable per-Place `random` RGB
components within the source channel bounds. Source alpha and the original color
remain unchanged. Unknown modes are retained for export and use the source color
in previews, with a conversion report. LabelStyle color modes are retained but
are not rendered by the preview.

`IconStyle.hotSpot` retains the literal `x`, `y`, `xunits` and `yunits` attributes
through shared styles, inline styles and StyleMaps. Attribute values are bounded
and escaped on export; unknown coordinate/unit values remain literal rather than
being presented as usable alignment. Unsupported extra attributes are reported.
The map preview uses circle symbols and does not apply icon anchoring or fetch
remote icon references. ListStyle rendering remains unsupported.

These fields extend the existing bounded KML document representation. They do not
grant source access, establish hosted persistence, or claim full KML conformance.
