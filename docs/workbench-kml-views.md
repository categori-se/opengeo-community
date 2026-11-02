# KML Camera and LookAt views

Select a KML item and expand **KML view** in its editor to inspect or change its
retained Camera or LookAt. Longitude, latitude, heading, tilt and roll use degrees;
altitude and LookAt range use metres. Optional blank fields remain unspecified,
and zero remains an explicit value. Camera exposes roll; LookAt exposes range.
The altitude-mode selector preserves standard and supported gx modes. Choose
**None** to remove the retained view, then **Apply place edits**. Invalid values
preserve the document and draft, announce a correction and focus the affected field.
Use ordinary Project Save to retain the edit; KML export carries the same view.
**Fly to** now opens a supported retained Camera or LookAt before considering
geometry, including views on documents and folders. **Frame geometry** is a
separate deliberate action that leaves the retained view unchanged. Native camera
capture, named views and browser Project files retain roll, target elevation and
ground-clamping state; incompatible engine switches or recalls disclose the limit.
Marked per-Layer browser Projects retain one occurrence per saved KML Layer;
their legacy top-level alias does not create another Layer on reopen.

This local path uses Earth/Mercator in MapLibre 6.4.1, with its configured zoom
limits and pitch up to 85 degrees. Absolute heights use metres above sea level.
With terrain disabled, standard ground modes use the map's zero-height plane;
Camera ground-clamping retains the authored relative height, whereas LookAt
ground-clamping ignores target altitude. These follow the
[KML view semantics](https://developers.google.com/kml/documentation/kmlreference#camera)
and the [native camera API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#calculatecameraoptionsfromcameralnglataltrotation).
Active terrain, sea-floor modes, globe views, zero LookAt range, below-ground eyes
and views the map would constrain are refused with a reason, preserving the current
camera and saved record. Native coercion is checked and rolled back.

See [KML geometry settings](workbench-kml-geometry-controls.md) for per-geometry
altitude, extrusion and tessellation preservation and native Project compatibility.
