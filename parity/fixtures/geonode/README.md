# GeoNode publication source fixtures

The GeoNode publication fixtures retain source from MapStore2 under the exact
upstream copyright notice, redistribution conditions and disclaimer in
[MapStore2-LICENSE.txt](MapStore2-LICENSE.txt). That notice applies to the copied
upstream fixture and the extracted source content in the local import profile.
No MapStore runtime dependency is installed by these fixtures.

[geonode-5.1-authored-publication.json](geonode-5.1-authored-publication.json)
contains an original local acceptance narrative with explicit CC-BY-4.0 rights
and attribution. Its native GeoStory shape is checked against the pinned source
below; it copies no upstream narrative text or media and is not a live GeoNode
export. It exercises the existing publication rights gate without changing the
upstream fixture, its BSD notice or the application's allowed-license policy.

- Upstream repository: https://github.com/geosolutions-it/MapStore2
- Exact commit: `0f3518737f29f4049b131247ce981e94519d9ab0`
- License source: https://github.com/geosolutions-it/MapStore2/blob/0f3518737f29f4049b131247ce981e94519d9ab0/LICENSE.txt
- License Git blob: `31b15b949d3e91fae5bb8ab8d8718a2241e0e934`
- Fixture source: https://github.com/geosolutions-it/MapStore2/blob/0f3518737f29f4049b131247ce981e94519d9ab0/web/client/test-resources/geostory/sampleStory_1.json
- Fixture Git blob: `9beb011604ddea3888e1691b2dd34b035a120610`
- Fixture SHA256: `b75dacd96e4e7173dac7a414eb92a05344532d6556f32b0abd22f842de40cf70`
- Retained exact file: [mapstore-0f351873-sampleStory_1.json](mapstore-0f351873-sampleStory_1.json), 4,328 bytes.

[geonode-5.1-publication.json](geonode-5.1-publication.json) is a local GeoNode
import request envelope containing a native GeoStory title/text profile extracted
from that retained source. It is not a live GeoNode export. The title section is
copied from `sections[2]`; the paragraph section and first column wrappers come
from `sections[0]`, retaining only `contents[0].contents[0]`. The title section
precedes the paragraph in the extracted profile. Exact extraction and omission
paths remain in the resource's `source_fixture` field. Unsupported source media,
maps and layouts remain available in the full retained upstream file.

GeoNode commit `a1db97e81dfc26c16bb4ee1a5d2b408877af66c9` pins
`django-geonode-mapstore-client==5.1.0`; client release commit
`7ca4822125b67999c97cb4aa1faa84b8a28eee9b` pins the MapStore2 submodule commit
above. This source chain establishes fixture provenance, not GeoNode runtime or
whole-product parity acceptance.
