# KML geometry settings

KML import recovers altitude mode, extrusion and tessellation from supported Point,
LineString and Polygon leaves, including nested MultiGeometry and multiple direct
geometries. Uniform controls keep their existing Placemark representation. Mixed
controls attach a complete `kmlControls` object to every supported leaf, preserving
coordinate heights and each setting through ordinary edits, KML export/reimport and
native Project files. One preservation summary covers each mixed Placemark; it does
not grow with the number of successful leaves. Unsupported Models retain explicit
losses. Existing byte, position, nesting and saved-report limits still apply.

Native Projects carrying leaf controls keep one document per Layer, omit the legacy
active-document copy, and use map definition **1.7.0**; older native-file
readers reject that version before editing. Updated Studio and API reject controls
mislabeled as an older definition and validate all three fields. Managed Save and
local drafts retain each Layer's own KML document and identity. Older deployed
managed clients did not check definition versions; coordinated client/API delivery
remains necessary before enabling this format there. Local account-adapter acceptance
does not establish hosted persistence. This preserves source settings without
asserting 3D terrain, extrusion or tessellation rendering.
