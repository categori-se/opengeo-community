// Original published SDK custody. Only index.js is derived below; child assets stay exact.
export const CESIUM_UPSTREAM_RUNTIME = Object.freeze({
  "version": "1.145.0",
  "basePath": "/renderer-runtime/cesium-1.145.0/",
  "fileCount": 392,
  "treeSha256": "3b047aa5bd8499c2af4e91f772daf2abbb1dddadd21c808a7395f41ee14bf54d",
  "assets": [
    {
      "name": "index.js",
      "source": "Build/Cesium/index.js",
      "sha256": "3c45aa629e5f8f359ae3aa18bb5472396c87a0ebc96556a8e99a22dc58fbcceb",
      "integrity": "sha384-7yJYRktWKoSE/AU6D6Ss/rle0gfZpmzD5ePQDibxkn4pdGbaGJOEbyiATXj7tOoq"
    },
    {
      "name": "Widgets/widgets.css",
      "source": "Build/Cesium/Widgets/widgets.css",
      "sha256": "702c5adf3d16ec7f1c03cc5fb7ecb823af6c59fa192789fb2c859ac7a11f4a0c",
      "integrity": "sha384-ghEeMdcWWzRv/BPeUcX835vcKDGrxvROXisl/Btpv3GeekBUXTSPVcFJpI1Tcrgp"
    }
  ]
});

export const CESIUM_DERIVATION = Object.freeze({
  source: "node_modules/cesium/Source/Cesium.js",
  sourceSha256: "72337c7aea503bafbde63d718a61e5a2ceb49a36824e759a0b9c6f4f79c0a6d4",
  compiler: "esbuild", compilerVersion: "0.28.2",
  sanitizerVersion: "3.4.17",
  sanitizerSha256: "60c5d5ccbb466de3de3ba863461a92bf134f8c156cef7992da43e0f659bc5cbd",
  ionSourceSha256: "c183e7ac80e97258765cd9ad6be830f44f0684f56defeb808b19fbd1316218ae",
  removedEvaluationTokenSha256: "cd471a429327b7c79a70b0c7da0af876c4790908a3c3d58fa3c925c501a5c356"
});

// Reviewed source derivation: current sanitizer and no bundled ion evaluation credential.
export const CESIUM_RUNTIME = Object.freeze({
  ...CESIUM_UPSTREAM_RUNTIME,
  treeSha256: "ae894c906177cb7d1d23e575e674db2abf96f7932845faf8f8df397b8d694010",
  assets: CESIUM_UPSTREAM_RUNTIME.assets.map(asset => asset.name === "index.js" ? {
    ...asset, source: CESIUM_DERIVATION.source,
    sha256: "49c4fa3906e066734b1c546f33af10c9aeca90380b2087477d87a37b30d58d44",
    integrity: "sha384-tjT29rlcQX7o0xyqM+VnqupQHA0W55S4ZrU9Tm/qNVM64xbPNXLSSrGV784pD4pc"
  } : asset)
});

// Application-owned host; kept outside the pinned upstream file inventory.
export const CESIUM_FRAME_PATH = `${CESIUM_RUNTIME.basePath}opengeo-host.html`;
