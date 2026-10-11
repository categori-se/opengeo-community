// Pinned optional ESM SDK; packaged workers avoid blob script imports.
export const CESIUM_RUNTIME = Object.freeze({
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

// Application-owned host; kept outside the pinned upstream file inventory.
export const CESIUM_FRAME_PATH = `${CESIUM_RUNTIME.basePath}opengeo-host.html`;
