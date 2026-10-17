FROM ghcr.io/osgeo/gdal:ubuntu-full-3.13.1@sha256:aff1d5515aa0e9b50be34ab11d6c0c2cfabc23cdcb7a2e0bc5748101eedb3e4a AS exr-builder

ARG DEBIAN_FRONTEND=noninteractive
ARG OPENEXR_VERSION=3.4.15
ARG OPENEXR_SHA256=445ed5b0ea4d9cf98be3a4f219e419628b123b61dec65ccb743ab9b07fbebdaa
ARG GDAL_VERSION=3.13.1
ARG GDAL_SOURCE_SHA256=8023c9a6e08f151f4723f08982cc73d2bc95095df65e5c1ea563cafafb864ec6

COPY scripts/verify-gdal-runtime.py /build/verify-gdal-runtime.py
RUN python3 /build/verify-gdal-runtime.py snapshot /build/gdal-driver-baseline.json
RUN apt-get update \
    && apt-get install --assume-yes --no-install-recommends \
      build-essential ca-certificates cmake curl libdeflate-dev libimath-dev ninja-build pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output openexr.tar.gz \
      "https://github.com/AcademySoftwareFoundation/openexr/archive/refs/tags/v${OPENEXR_VERSION}.tar.gz" \
    && echo "${OPENEXR_SHA256}  openexr.tar.gz" | sha256sum --check --strict \
    && mkdir openexr \
    && tar --extract --gzip --file openexr.tar.gz --directory openexr \
      --strip-components=1 --no-same-owner --no-same-permissions \
    && cmake -S openexr -B openexr-build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/opengeo-openexr \
      -DCMAKE_INSTALL_LIBDIR=lib -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
      -DOPENEXR_BUILD_EXAMPLES=OFF -DBUILD_TESTING=OFF \
    && cmake --build openexr-build --parallel 2 \
    && cmake --install openexr-build

COPY scripts/gdal-exr /build/gdal-exr
RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output gdal.tar.gz \
      "https://github.com/OSGeo/gdal/archive/refs/tags/v${GDAL_VERSION}.tar.gz" \
    && echo "${GDAL_SOURCE_SHA256}  gdal.tar.gz" | sha256sum --check --strict \
    && mkdir gdal \
    && tar --extract --gzip --file gdal.tar.gz --directory gdal \
      --strip-components=1 --no-same-owner --no-same-permissions \
    && cmake -S gdal-exr -B gdal-exr-build -G Ninja \
      -DGDAL_SOURCE=/build/gdal -DCMAKE_BUILD_TYPE=Release \
      -DOpenEXR_ROOT=/opt/opengeo-openexr \
    && cmake --build gdal-exr-build --parallel 2 \
    && install -D gdal-exr-build/exr/gdal_EXR.so /opt/opengeo-gdal/gdal_EXR.so \
    && install -D openexr/LICENSE.md /opt/opengeo-openexr/share/licenses/OpenEXR/LICENSE.md \
    && install -D gdal/LICENSE.TXT /opt/opengeo-gdal/LICENSE.TXT

COPY scripts/package-openexr.py /build/package-openexr.py
RUN python3 /build/package-openexr.py

FROM ghcr.io/osgeo/gdal:ubuntu-full-3.13.1@sha256:aff1d5515aa0e9b50be34ab11d6c0c2cfabc23cdcb7a2e0bc5748101eedb3e4a AS exr-runtime

COPY --from=exr-builder /build/opengeo-openexr.deb /tmp/opengeo-openexr.deb
COPY --from=exr-builder /opt/opengeo-gdal /opt/opengeo-gdal
COPY --from=exr-builder /build/gdal-driver-baseline.json /opt/opengeo-gdal/driver-baseline.json
COPY scripts/verify-gdal-runtime.py /opt/opengeo-gdal/verify-gdal-runtime.py
# The GDAL EXR plugin is the only consumer of this distro library in the pinned
# base. apt removal must fail rather than removing any additional package.
RUN test "$(apt-get --simulate remove libopenexr-3-1-30 | grep '^Remv ' | wc -l)" -eq 1 \
    && apt-get remove --assume-yes libopenexr-3-1-30 \
    && dpkg --install /tmp/opengeo-openexr.deb \
    && rm /tmp/opengeo-openexr.deb \
    && test "$(find /usr/lib -path '*/gdalplugins/gdal_EXR.so' | wc -l)" -eq 1 \
    && find /usr/lib -path '*/gdalplugins/gdal_EXR.so' \
      -exec install -m 0644 /opt/opengeo-gdal/gdal_EXR.so '{}' \; \
    && python3 /opt/opengeo-gdal/verify-gdal-runtime.py verify /opt/opengeo-gdal/driver-baseline.json

FROM ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG TIPPECANOE_VERSION=2.79.0
ARG TIPPECANOE_SHA256=b0fd9df49b6efc988288ea48774822c6de19eb48428017f27ee0b3b01d44f05d

RUN apt-get update \
    && apt-get install --assume-yes --no-install-recommends \
      build-essential ca-certificates curl libsqlite3-dev python3-pip zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output tippecanoe.tar.gz \
      "https://github.com/felt/tippecanoe/archive/refs/tags/${TIPPECANOE_VERSION}.tar.gz" \
    && echo "${TIPPECANOE_SHA256}  tippecanoe.tar.gz" | sha256sum --check --strict \
    && mkdir tippecanoe \
    && tar --extract --gzip --file tippecanoe.tar.gz --directory tippecanoe \
      --strip-components=1 --no-same-owner --no-same-permissions \
    && make --directory tippecanoe --jobs=2 \
    && make --directory tippecanoe install

COPY requirements.lock ./requirements.lock
RUN python3 -m pip install --break-system-packages --no-cache-dir --require-hashes \
      --target /opt/opengeo-python --requirement requirements.lock

RUN curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output /tmp/aws-rds-global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && echo '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /tmp/aws-rds-global-bundle.pem' \
      | sha256sum --check --strict

FROM exr-runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/opengeo-python:/srv/opengeo/src \
    PATH=/opt/opengeo-python/bin:/usr/local/gdal-internal/bin:/usr/local/bin:/usr/bin:/bin \
    PROJ_NETWORK=OFF \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    OPEN_GEO_WORKSPACE_ROOT=/tmp/opengeo-worker

RUN apt-get update \
    && apt-get upgrade --assume-yes --no-install-recommends \
    && apt-get install --assume-yes --no-install-recommends \
      clamav poppler-utils tesseract-ocr tesseract-ocr-eng \
      tesseract-ocr-script-arab tesseract-ocr-script-beng \
      tesseract-ocr-script-cyrl tesseract-ocr-script-deva \
      tesseract-ocr-script-ethi tesseract-ocr-script-grek \
      tesseract-ocr-script-hang tesseract-ocr-script-hans \
      tesseract-ocr-script-hant tesseract-ocr-script-hebr \
      tesseract-ocr-script-jpan tesseract-ocr-script-latn \
      tesseract-ocr-script-thai \
    && freshclam --stdout \
    && find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) \
      -size +1c -print -quit | grep --quiet . \
    && chmod --recursive a+rX /var/lib/clamav \
    && rm -rf /var/lib/apt/lists/* /var/log/clamav/*

# ECS runs the Python worker directly; the inherited Pebble supervisor is unused.
RUN rm -f /usr/bin/pebble

RUN ! grep -Eq '(^|:)10001:' /etc/passwd \
    && ! grep -Eq '(^|:)10001:' /etc/group \
    && printf 'opengeo:x:10001:\n' >> /etc/group \
    && printf 'opengeo:x:10001:10001::/nonexistent:/bin/false\n' >> /etc/passwd \
    && install --directory --owner=10001 --group=10001 --mode=0700 /tmp/opengeo-worker

COPY --from=builder /opt/opengeo-python /opt/opengeo-python
COPY --from=builder /usr/local/bin/tippecanoe* /usr/local/bin/
COPY --from=builder /usr/local/bin/tile-join /usr/local/bin/tile-join
COPY --from=builder /tmp/aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem

WORKDIR /srv/opengeo
COPY src ./src
COPY scripts/verify-toolchain.py ./scripts/verify-toolchain.py

RUN PYTHONDONTWRITEBYTECODE=1 python3 scripts/verify-toolchain.py \
    && chmod 0444 /etc/ssl/certs/aws-rds-global-bundle.pem \
    && chown --recursive 10001:10001 /srv/opengeo

USER 10001:10001
VOLUME ["/tmp/opengeo-worker"]
CMD ["python3", "-m", "opengeo_worker"]
