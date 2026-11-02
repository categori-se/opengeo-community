# Print Studio

Print Studio arranges Project map frames, text and supporting information into saved layouts for export.

## Saved 3D framing — November 2, 2026

Print Studio can capture the existing MapLibre globe and perspective views.
Choose **Edit selected map frame**, adjust its map, then **Capture map frame**.
Each saved frame retains its projection and camera, including roll, target
elevation and ground clamping. Reopening the frame applies that saved view even
when the Project's main map uses another projection. Print templates use their
destination Project's camera and projection rather than copying the source view.

These scenes export as captured images. Paper SVG retains the actual camera,
projection, image hash and pixel dimensions in its metadata. A 3D view omits the
compass, measured scale and latitude/longitude grid with a visible note, including
when **Source notes** is off. Source credits and recorded licenses remain in the
output. Vector and geospatial PDF require a flat Earth Mercator view.

Local acceptance covers a real rendered globe with Point/LineString content,
frame editing, one fixture save, fresh-context reopening and Paper SVG export.
It does not establish terrain/provider reconstruction, independent Google Earth
comparison, standalone PNG metadata or real-account/hosted acceptance.

## Selected feature descriptions — November 2, 2026

In the Print map, select a feature in **Table** or **Search**, then choose
**Add selected feature description**. A feature needs a text `description`
property (`Description` is accepted when the lowercase property is absent).
The new editable text frame includes its name, description, Layer identity and
known dataset/version, source revision, feature generation and feature identity.
It copies the current loaded selection without requesting provider data. Changed
Layers, replaced data and stale source pins require a new selection.

This is a deliberate text snapshot: later feature changes do not rewrite it.
Use **Text content**, sizing and alignment controls, then **Save layout** to keep
it with the existing account or browser Project. Reopening and existing Print
outputs use the saved text. Markup, entities and URLs remain literal text. CRLF
and CR become LF; tabs become four spaces. The existing 4,000-character text,
eight-frame and layout-size limits apply. Missing or oversized descriptions leave
the layout intact; overflowing text asks for a larger frame or smaller font.
Local fixture persistence is distinct from real-account and hosted acceptance.
