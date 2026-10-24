# Analysis console

## Analysis console in a map

Open **View → Analysis console** or **Processing → Analysis console**. The
console docks below the map; **Ctrl+`** opens or closes it. Choose JavaScript,
Python or Bash, select the input Layers, and press **Run**. **Stop** cancels a
running script. Review output before selecting **Add result to map**, which
creates a local derived Layer with execution and input provenance. Original
Layers and Catalog records remain intact. Download a script to keep it; editor
buffers last only for the open workspace.

Select at most 16 fully loaded vector Layers, with a combined 16 MiB input limit.
Tiled displays and live viewport subsets are not console inputs. Scripts cap at
64 KiB, logs at 128 KiB and GeoJSON results at 8 MiB.

## Browser JavaScript

The Browser profile runs JavaScript in an isolated worker with networking
disabled and a 10-second deadline. It provides `opengeo.layers`,
`opengeo.emit(geojson)` and `console.log`. Browser memory has no hard heap limit.
Only successful, validated GeoJSON results can be added to a map.

## Local Python, JavaScript and Bash

Use the existing loopback [development environment](community-development.md).
Supply `--analysis-profile profile.json` alongside `--development` and
`--state-directory`. The operator profile identifies reviewed, installed immutable
Podman images and their interpreters:

```json
{
  "profiles": {
    "python": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/usr/local/bin/python3"},
    "javascript": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/usr/local/bin/node"},
    "bash": {"image": "sha256:<64 lowercase hexadecimal characters>", "interpreter": "/bin/bash"}
  },
  "timeoutSeconds": 10,
  "memoryMiB": 256
}
```

Replace each image placeholder with a reviewed local image ID containing the
chosen interpreter and packages. Execution never pulls an image. The optional
timeout is 1–30 seconds and memory is 256 or 512 MiB. Each run uses a nonroot,
network-disabled container with read-only inputs, bounded temporary storage,
one CPU and 32 processes. Cancellation removes the exact container and staged
inputs; a cleanup failure prevents further execution until resolved. Launching
without the profile flag disables the retained opt-in configuration.

Local scripts read `/input/layers.json`, an array of `{id, title, path}` records
pointing to GeoJSON files. To return a Layer, print one line beginning
`OPEN_GEO_GEOJSON:` followed by compact GeoJSON. The Python example in the editor
demonstrates this protocol.

Browser and local execution have selected local acceptance. Managed execution
defaults off; the complete managed browser/API/host workflow, independent
installation, current runtime image security and configured cloud cleanup remain
unverified. This guide covers the existing console profiles. See
[processing data](user-guide/processing.md) for the separate browser tools and
conversion workflow.
