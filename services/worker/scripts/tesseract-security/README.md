# Tesseract security backports

These patches apply in filename order to upstream Tesseract 5.5.3, commit
`db0ec62f81b0737fbbe184d8fea40af5738f8eef`. `manifest.json` binds the source archive,
upstream commits, original patch hashes and applied patch hashes; `SHA256SUMS`
checks the applied files. The downstream package records its custom build version
while preserving the actual upstream runtime version, 5.5.3.

| Patch | Upstream fix |
| --- | --- |
| 01 | [CVE-2026-88052: unicharset counts and duplicate inserts](https://github.com/tesseract-ocr/tesseract/commit/2d04d640db2e8c7e3bab2369d599343b5a8b8443) |
| 02 | [CVE-2026-88048: connected-layer dimensions](https://github.com/tesseract-ocr/tesseract/commit/103dc134eb36411ddc6833ec20aa2c76795bd0ff) |
| 03 | [CVE-2026-88053: integer-template bounds and failure propagation](https://github.com/tesseract-ocr/tesseract/commit/8b0574680f3b22f246ade6a4c8e3029104255c63) |
| 04 | [CVE-2026-88047: bounded normproto tokens](https://github.com/tesseract-ocr/tesseract/commit/1bda5079b1c8a7e25f523486837426903d29ce84) |
| 05 | [CVE-2026-88051: vector counts](https://github.com/tesseract-ocr/tesseract/commit/56e09ca12e751623fe796ce1554ce704bffd2ef0) |

Patch 03 removes three expected deletion lines for an old initialization loop
absent from stable 5.5.3 and recounts the hunk lengths. Every upstream runtime
addition and regression test remains unchanged. Its replacement header supplies
the value-initialized arrays used by the new constructor.

Patch application does not establish binary or release acceptance. Preserve the
worker's full toolchain/model checks and independent image security gates.
