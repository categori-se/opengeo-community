# Print Studio

Print Studio arranges Project map frames, text and supporting information into saved layouts for export.

## Current Print additions — source preparation

Published editions offer **Download all PNG pages**, using their exact sealed
page order and edition identity. A browser stream downloads each PNG in turn
into a stored ZIP with manifest, actual dimensions and locally calculated
SHA-256 checksums. Cancellation stops later pages. The limits remain 64 pages,
20 megapixels and 64 MiB per PNG, 3 GiB per ZIP, 45 seconds per page and one hour
per download. Server checksums are verified when exposed; their absence is
recorded honestly. No payload is stored in the offline shell cache.

GeoMoose 3.15.2 import can retain supported rectangles and ellipses in source
order. Width and geometry rounding, unsupported bounds/styles, inherited fill
state and asynchronous legend order are reported rather than silently changed.
The default converter contract stays 1.1; the governed import selects opt-in
layout 1.3 to preserve text point size, RGB color and native baseline geometry.
Older 1.0/1.1/1.2 layouts remain readable, with the empty default still 1.1.
Visible text size/color controls deliberately upgrade a draft; adding a shape
does not downgrade 1.3. Source font family and face substitution remain explicit.
API, Studio and forward migration 0189 require coherent rollout; source
qualification does not establish deployment or hosted persistence.

Project Print literal text also offers real **Regular**, **Bold**, **Italic**
and **Bold italic** Open Sans faces. The optional `fontFace` field is preserved
in Project layouts and source-free JSON templates; untouched Regular text keeps
its existing representation. Math uses its typesetter rather than this selector.
Exact pinned font bytes supply preview measurement, self-contained SVG/HTML/PNG
and embedded vector PDF. Standalone font payloads retain Apache-2.0 licensing and
source notices. Glyph coverage is checked again after text edits even when the
font assets are cached. Unknown faces and unsupported glyphs fail explicitly.
QGIS interchange retains supported authored faces and reports remaining losses.
Custom families, complex shaping and whole Print-family fidelity remain open.

## Positioned shapes — local acceptance

Positioned Publications support line, rectangle and ellipse frames through the
opt-in `opengeo.print-layout.1.2.0` schema. Existing 1.0/1.1 layouts and seals
remain valid; the empty default stays 1.1. Adding a shape upgrades that draft.
The editor supports stroke/fill, transparent interiors, 1–12 point outlines,
ordering, drag/resize, rotation and clipping. Lines cross the frame centre;
positive rotation is counterclockwise and clipping retains the original bounds.

The API and migration 0188 validate exact inert fields and retain existing rich
media edition checks. PDF uses vector paths marked as artifacts; PNG paints
shapes directly over existing content. Shapes introduce no assets, URLs or
grants. Focused local API, persistence/isolation/sealing and compiled editor
edit/save/reopen acceptance pass. This is source preparation; migration 0188,
production deployment and hosted acceptance remain open. Wider Print-family
fidelity and layout requirements remain open.

## Office document layout — local acceptance

Processed ODT document blocks reuse the exact-version PDF print companion.
Original packages remain private, semantic previews and their page counts remain
unchanged, and physical pagination is recorded separately. Old editions are not
rebound. Conversion uses one-shot LibreOffice Writer with a fresh profile,
private process, device and bounded temporary filesystems, Landlock and seccomp.
System fonts may be substituted; unsupported conversion keeps semantic access.
Conversion copies preserve nested namespace declarations and formula bindings.

One local CC0 two-page case passes with LibreOffice 25.8.7.3 and the retained
pypdf 7 runtime: portrait/landscape geometry, selectable text, table, image and font
resources remain, with unchanged original bytes and no annotations. Six local
filesystem/socket controls pass. The same worker PDF passes the actual API
description/composition path with equal text, geometry and per-page Poppler
pixels at 60 DPI. Thirteen focused worker/runner cases and strict types on two
changed modules pass; earlier API/fallback and namespace evidence is reused.

This is scoped local acceptance. Exact worker-image, kernel/UID/cgroup/runtime,
dependency/security/SBOM and hosted scanner/storage/authorization/publication
qualification remain open, along with non-ODT Office, wider fidelity and the
remaining Print requirements. Hosted deployment is not established by this work.

## Imported PDF pages — November 8, 2026

A local increment keeps source fonts, vector paths, selectable text, crop and
rotation when printing processed PDFs. New editions bind prepared pages from the
same exact dataset/version to ordinary PDF file and document blocks. Users keep
the original block and resource identity. Flowing exports insert source pages at
the block position; positioned layouts append them after that sheet. Direct
selection of `print-vector.pdf` through the governed asset picker also works.
Original source bytes and existing edition seals remain unchanged. This section describes locally verified source behavior; hosted deployment
remains open.

Preparation retains the existing source safety checks, strips inert annotations
and refuses active content. Exports read only explicitly sealed object versions,
check size/checksum and recheck access and the complete source/companion binding
after retrieval. Shared companions use one storage read. Parsing remains isolated
and bounded. Supported ActualText tags retain source roles and page relationships;
general spanning tag trees remain unsupported.

Sixteen affected local cases and strict type checks on five changed modules pass,
including normal file/document binding, exact manifest readback, shared reads,
drift, revocation and limits before storage reads. Earlier Poppler text extraction
and identical source/composed rendering evidence is retained. Formatting, lint and
the dependency inventory pass. Earlier imports without prepared pages need
deliberate processing; old editions are not rebound. Hosted ingestion/publication,
release checks and wider typography/OCR/Office/native/accessibility/scale
requirements remain open. Full Print parity is not established.

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
