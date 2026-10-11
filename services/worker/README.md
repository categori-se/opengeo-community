# OpenGeo Studio GIS worker

The GIS worker validates registered inputs and produces bounded working data,
map tiles, document previews and rendered derivatives. Exact input versions and
checksums connect each result to its source; the worker uses a limited job lease
rather than general database table access.

Read the [processing architecture](../../docs/community-architecture.md#processing-and-deployment)
and [local development guide](../../docs/community-development.md) first.
The [AWS guide](../../docs/community-aws.md) covers optional worker deployment,
permissions and costs. The detailed notes below retain their stated check and
release limits.

## Implementation notes

Working vector conversion preserves source geometry without `MakeValid`; previews and
tiles keep their separate display repair path. Measured working Parquet enables GDAL's
`OGR_PARQUET_ALLOW_ALL_DIMS` extension. Quality observations disclose that ordinary
GeoParquet reader compatibility is not established and display derivatives omit M.
Use retained originals for interchange unless the chosen reader has been verified.
This does not retroactively repair older working derivatives or claim topology validity.

The worker consumes versioned S3 creation events from SQS, claims the exact completed upload through the function-only `opengeo_worker` database role, inspects the local object with network-disabled GDAL, writes KMS-encrypted derivatives, and atomically finalizes catalog metadata. It also accepts an identity-only governed render command, claims the exact versioned GeoJSON preview and immutable render snapshot from PostgreSQL, and writes a deterministic SVG or RGB/RGBA PNG derivative through a separate function-only lease boundary.

An identity-only `opengeo.coverage-derivative.command.v1` message uses the same activation-only process to claim an explicit immutable coverage job. The worker downloads and rechecks the exact sealed COG, verifies the canonical request digest, then runs fixed absolute `gdalwarp` and `gdalsrsinfo` commands with no shell, one GDAL thread, and PROJ networking disabled. Supported work is one within-source 2D subset, sorted one-based source bands, either target width/ height with `EPSG:` reprojection or materialized source-CRS resolution, and nearest/bilinear/cubic COG output. Completion is accepted only after the exact output key/version/checksum and COG/grid/extent/CRS/band metadata are verified; upload requests the configured KMS key. An ordinary coverage read never emits this message. Queued cancellation is a database-only transition; it never deletes bytes.

An identity-only `opengeo.coverage-derivative-reclamation.command.v1` message activates the same worker only after a separate shared-auth preview and manager confirmation. Function-only claim data supplies one sealed bucket/key/storage version/ETag/media/size/SHA-256 target. The worker first HEAD-verifies that exact version and KMS key, durably marks that deletion has started, then calls exact version deletion under prefix-scoped `s3:DeleteObjectVersion` authority. It has no list or unversioned-delete permission. Missing bytes are accepted only when a previous attempt crossed the durable delete boundary; later ambiguity stays queued and hidden. Successful completion removes the object catalog association but retains immutable derivative, reclamation, and activity history. No schedule, ordinary read, or warm worker starts reclamation.

The runtime pins the official OSGeo GDAL 3.13.1 `ubuntu-full` multi-architecture image by digest (the `small` variant does not contain the required Parquet driver). Its hash-locked Python toolchain includes GeoPandas, Rasterio, Shapely, PyArrow, DuckDB, rio-cogeo, and psycopg; Tippecanoe 2.79.0 is built from a checksum-pinned official source archive. The image build fails unless the required vector/raster drivers and binaries are present.

The inherited OpenEXR 3.1 library is replaced with checksum-pinned upstream OpenEXR 3.4.15. Only the EXR plugin is rebuilt from matching, unchanged GDAL source using GDAL's own standalone-plugin build rules. Its new library ABI is preserved, not disguised through old-version symlinks. A local Debian package records the actual source version; the private installation also retains source provenance, licenses, and a CycloneDX inventory including bundled OpenJPH 0.31.0. No Ubuntu Pro subscription or runtime download is required.

The dependency repair must preserve the base image's complete driver/capability inventory. Sixty synthetic EXR read/write cases cover ten compression modes, three pixel types, tiled and scanline layouts, pixels, CRS, and geotransform. These checks run during the image build and again through the ordinary toolchain verifier under read-only, network-disabled runtime constraints. Local x86-64 success is not native ARM64 acceptance or permission to deploy: the exact release image must still pass both fresh local and ECR High/Critical gates.

Run local checks with the existing API development environment:

```bash
../api/.venv/bin/ruff format --check src tests scripts
../api/.venv/bin/ruff check src tests scripts
../api/.venv/bin/mypy src
../api/.venv/bin/pytest
```

Build and exercise the production boundary with:

```bash
docker build --tag opengeo-worker:local .
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 4g --cpus 2 --pids-limit 256 \
  --tmpfs /tmp/opengeo-worker:rw,noexec,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700 \
  opengeo-worker:local python3 /srv/opengeo/scripts/verify-toolchain.py
```

The verifier mounts `/tmp/opengeo-worker` with UID/GID `10001` and mode `0700`. The image-declared volume preserves the same ownership for an ordinary anonymous Docker volume. Production supplies the separately bounded ephemeral task volume; do not make the root filesystem writable to compensate for a mis-owned scratch mount.

### Source-built library security

Trivy's full-image inventory does not include the statically bundled OpenJPH codec. CI and the native build controller therefore also run `scripts/scan-native-libraries.py` before publication. This host-side check resolves an immutable image ID, reads the actual library version and binary fingerprints under non-root/network-disabled constraints, and scans the embedded native inventory with checksum-pinned Grype. It requires both OpenEXR and OpenJPH to remain in the scanner's inventory, a database built within 24 hours, no exclusions or waivers, and zero High/Critical matches.

A metadata-only affected-version control must trigger the upstream OpenEXR/HTJ2K advisories and fail the same severity gate. No vulnerable library is built or executed. CPE matching remains heuristic, and an OpenEXR advisory control does not prove a standalone OpenJPH advisory match. This supplements, rather than replaces, the full-image Trivy and independent ECR gates. The scanner and its database are not added to the worker image.

From this directory, use new output directories for each run:

```bash
bash scripts/install-native-scanner.sh /tmp/opengeo-native-scanner
python3 scripts/scan-native-libraries.py \
  --image opengeo-worker:local --grype /tmp/opengeo-native-scanner/grype \
  --cache-dir /tmp/opengeo-native-scanner/cache --update-db \
  --output /tmp/opengeo-worker-native-scan
```

The report binds the image, native binaries, inventory, scanner, database, and positive control. Failed runs retain diagnostics without writing a passing receipt. Omit `--update-db` only when reusing a still-fresh local database. For rootless Podman, use `--engine podman` with repeated `--engine-arg=...` values for its isolated storage configuration.

The verifier requires CSV, Shapefile, GeoJSON, GeoPackage, Parquet, PMTiles, COG, GTiff, PNG, JPEG, and EXR drivers plus every locked Python GIS package, Poppler PDF binaries, `gdalwarp`, `gdalsrsinfo`, Tesseract 5 plus the closed English/Arabic/Bengali/Cyrillic/Devanagari/Ethiopic/Greek/Hangul/HanS/HanT/Hebrew/Japanese/Latin/Thai model set, ClamAV binary/signature database, and command-line tool. Its active EICAR control must be detected. The CI definition repeats this on native ARM64, rejects High and Critical vulnerabilities, and publishes a CycloneDX SBOM. `freshclam` runs only while the immutable image is built; no scanner, OCR, or update daemon exists in the deployed task.

Production configuration is entirely `OPEN_GEO_*` environment variables. The database identity must be `opengeo_worker`, TLS hostname verification and the AWS RDS root bundle are mandatory, and the workspace must be an absolute dedicated directory. The ECS task mounts ephemeral storage at `/tmp/opengeo-worker`; no input is opened over a GDAL network virtual filesystem.

## Processing Contract

S3 messages are bounded and untrusted. Only a canonical original key with lower- case UUID segments, the configured bucket/region, a non-null version id, bounded size, hexadecimal ETag, and sequencer can reach the database. Worker-generated derivative notifications are ignored; all other malformed keys fail closed. The database then reconciles the exact bucket/key/version to an already completed upload and its unique `dataset.ingest` job. An event cannot create a dataset, version, or job.

Claims use a tokenized lease. Heartbeats renew both the database lease and SQS visibility. Terminal events are acknowledged idempotently; a live claim remains busy; expired work can be reclaimed; transient failures release with exponential backoff and become terminal after three attempts. Successful artifacts use UUIDv5 identities derived from the logical version and relative key, and metadata, artifact facts, job state, dataset-version state, dataset state, and activity commit in one database function.

Source downloads stream and recheck size, SHA-256, version, ETag, content type, and KMS identity. The inspector verifies file magic and the selected GDAL driver. It rejects unsafe ZIP paths, links, encryption, excessive entries, expansion, or compression ratio. GIS commands use an absolute binary allowlist, no shell, a minimal environment, disabled PROJ networking/GDAL directory scanning, and process-level CPU, address-space, output-file, process, descriptor, wall-clock, and diagnostic-output limits.

Every exact source first passes a network-disabled ClamAV signature, heuristic, archive, and document scan using the signature database baked into the immutable worker image; a missing scanner/database is retryable and never activates data, while a detection records only a stable blocked code. Valid vectors produce normalized GeoParquet, a bounded GeoJSON preview when spatial, PMTiles, and a generated SVG thumbnail. Valid COGs produce a smaller COG preview and PNG thumbnail. Valid PNG/JPEG project media are capped at 16 MiB, 20,000 pixels per axis, 40 million pixels, and four bands; bounded structure and selected-driver checks precede an orientation-aware GDAL decode. The worker emits at most 900-pixel and 320-pixel 8-bit PNGs and removes non-render ancillary chunks. PDFs are capped at 32 MiB/200 pages, reject encryption, embedded files, active actions/forms/JavaScript, and oversized page geometry, and run through bounded network-disabled Poppler processes. Only metadata-stripped first-page and thumbnail PNGs plus a bounded all-page semantic JSON and an adaptive all-page baseline-RGB-JPEG visual/semantic JSON are generated. The visual artifact hides annotations and caps each image, aggregate image bytes, decoded pixels, and total JSON size. Pages with embedded text retain Poppler output. Only text-empty pages enter declared-language Tesseract OCR, capped at the first 32 such pages, 32 million rendered pixels, a 300–1,600-pixel adaptive axis, 8 MiB per temporary image, and 1 MiB total raw OCR text. The semantic/visual artifacts record exact engine version, model, attempted pages, pixels, per-page `embedded`/`ocr`/`none` provenance, and truncation. OCR and reading order are heuristic and may be wrong; no language detection, searchable index, PDF/UA, or OCR-accuracy claim is made. Originals remain private and any separate public original-PDF delivery is attachment-only.

ODT is likewise capped at 32 MiB and always passes ClamAV first. A standard- library ODF 1.2–1.4 inspector enforces the uncompressed first `mimetype` member, manifest/media consistency, bounded ZIP entry/expanded/ratio work, safe unique paths, bounded XML, and a closed package-member set. It rejects encryption, entities/DTD, macros/scripts/forms, objects/plugins/applets, unsafe references, and structural/content expansion. Successful input produces one deterministic at-most-512-KiB semantic JSON preview with bounded pages, headings, paragraphs, lists, and tables. It omits embedded media and makes no page-layout claim. LibreOffice is exercised only as a disposable development peer; it is not present in the production worker. The database records schema, CRS, geometry type, feature count, extent, and bounded quality checks. Validation failures record only a stable error code and structured quality result; raw source names and GIS stderr are not persisted.

Governed rendering accepts the declared versioned `opengeo.deterministic-svg` v1/v2 subset: one fill, line, circle, or Gaussian heatmap geometry layer, optional labels with collision suppression, exact classification rules, scale visibility, and a legend. Version 2 requires the repository-pinned closed font and the exact MapServer-inspired Gaussian/normalization/quantization contract; version 1 remains byte-compatible. It caps the source at 16 MiB, 5,000 features, 200,000 coordinates, 500,000 JSON nodes, and the output at 20 MiB. Output dimensions span 1 through 2,048 pixels per axis under the shared pixel-work cap. GeoJSON geometry structure is validated; labels/XML are escaped; no URL, script, shell, or external resource is allowed. Background color and transparency are immutable job inputs: transparent SVG omits its background and transparent PNG uses deterministic non-premultiplied RGBA composition. Identical frozen inputs produce checked byte-identical fixtures, including exact dataset/ style/profile lineage metadata. Unsupported cartography is rejected by the API compiler rather than silently approximated.

Sealed composition jobs add two through sixteen exact layer snapshots. The worker downloads every lease-authorized preview version, verifies every configuration checksum, applies the existing source/feature/coordinate/raster limits in aggregate, draws geometry bottom-to-top, and records ordered per-layer lineage. Version-2 compositions reserve the consolidated legend before placing labels and give top layers first claim on one shared collision cache. Label and legend totals are recorded globally and per layer. Version-1 single-layer golden output remains byte-identical.

## Operations

The optional CDK worker service starts at zero and scales from visible queue messages. Investigate the oldest-message alarm for unavailable dependencies, lease churn, or unexpectedly expensive files. Any DLQ message requires operator review: preserve its message id and safe error code, determine whether it is a poison event or a fixed dependency failure, then redrive only after the cause is understood. Never copy source contents, credentials, signed headers, database DSNs, or raw parser output into an incident ticket.

Deployment configuration, image review and operating limits are in the [AWS guide](../../docs/community-aws.md). Review the exact worker image and its security evidence before enabling live processing; local and CI evidence alone does not authorize live parsing.

Working vector files are reopened with bounded read-only `ogrinfo` after conversion.
Known source/working count differences stop ingestion before artifacts are returned.
Unknown counts remain unavailable, with per-layer evidence and a quality warning.
This checks reported counts, not every feature's identity or geometry. It adds one
local metadata command per working layer; representative-volume latency is unmeasured.
