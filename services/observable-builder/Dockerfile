ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590
ARG DISTROLESS_NODE_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:b1fc33242cc74151f50c62b4a03d48afd759dccf81279b5f8e401db4546479c1
FROM ${NODE_IMAGE} AS dependencies

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_IGNORE_SCRIPTS=true \
    OBSERVABLE_TELEMETRY_DISABLE=true

WORKDIR /srv/opengeo
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY scripts/notebook-assets.mjs scripts/build-notebook-assets.mjs ./scripts/
COPY src/notebook-runtime.mjs src/legacy-notebook-runtime.mjs src/portable-map-view.mjs ./src/
RUN node scripts/build-notebook-assets.mjs

FROM dependencies AS cache-seed

WORKDIR /tmp/opengeo-framework-seed
COPY seed ./
RUN /srv/opengeo/node_modules/.bin/observable build \
      --root . --config observablehq.config.mjs \
    && test -s .observablehq/cache/_observablehq/client.js \
    && test -s .observablehq/cache/_npm/geotiff@3.1.0-beta.0/_esm.js \
    && test -d .observablehq/cache/_npm/react-dom@* \
    && test -d .observablehq/cache/_npm/react@*

FROM ${DISTROLESS_NODE_IMAGE} AS distroless-runtime

FROM ${NODE_IMAGE} AS runtime-root

COPY --from=distroless-runtime / /opt/distroless-root

RUN set -eux; \
    runtime_root=/opt/distroless-root; \
    find "$runtime_root/usr/lib" -type f \
      \( -name afalg.so -o -name loader_attic.so -o -name padlock.so \
      -o -name libcrypto.so.3 -o -name libssl.so.3 \) -delete; \
    rm -rf \
      "$runtime_root/usr/share/doc/libssl3t64" \
      "$runtime_root/usr/share/lintian/overrides/libssl3t64"; \
    rm -f \
      "$runtime_root/var/lib/dpkg/status.d/libssl3t64" \
      "$runtime_root/var/lib/dpkg/status.d/libssl3t64.md5sums"; \
    if find "$runtime_root/usr/lib" -type f \
      \( -name afalg.so -o -name loader_attic.so -o -name padlock.so \
      -o -name libcrypto.so.3 -o -name libssl.so.3 \) | grep -q .; then \
      exit 1; \
    fi; \
    ! grep -R -Fq 'Package: libssl3t64' "$runtime_root/var/lib/dpkg/status.d"; \
    # Node bundles zlib and uses c-ares/libc rather than libresolv's deprecated \
    # DNS-printing API. Hesiod is not configured and links to libresolv; remove \
    # that unused NSS module too, not the retained libc package inventory. \
    if test -f "$runtime_root/etc/nsswitch.conf"; then \
      ! grep -Eq '^[^#]*\bhesiod\b' "$runtime_root/etc/nsswitch.conf"; \
    fi; \
    find "$runtime_root/usr/lib" \( -type f -o -type l \) \
      \( -name 'libz.so*' -o -name 'libresolv.so*' -o -name 'libnss_hesiod.so*' \) -delete; \
    rm -rf "$runtime_root/usr/share/doc/zlib1g"; \
    rm -f "$runtime_root/var/lib/dpkg/status.d/zlib1g" \
      "$runtime_root/var/lib/dpkg/status.d/zlib1g.md5sums"; \
    if find "$runtime_root/usr/lib" \( -name 'libz.so*' -o -name 'libresolv.so*' -o -name 'libnss_hesiod.so*' \) | grep -q .; then exit 1; fi; \
    test -s "$runtime_root/var/lib/dpkg/status.d/libc6"; \
    ! grep -Eq '(^|:)10001:' "$runtime_root/etc/passwd"; \
    ! grep -Eq '(^|:)10001:' "$runtime_root/etc/group"; \
    printf 'opengeo:x:10001:\n' >> "$runtime_root/etc/group"; \
    printf 'opengeo:x:10001:10001::/nonexistent:/usr/sbin/nologin\n' \
      >> "$runtime_root/etc/passwd"; \
    install --directory --owner=10001 --group=10001 --mode=0700 \
      "$runtime_root/workspace" "$runtime_root/result"; \
    /usr/sbin/chroot "$runtime_root" /nodejs/bin/node --version \
      | grep -Fx 'v24.21.0'; \
    /usr/sbin/chroot "$runtime_root" /nodejs/bin/node -e \
      "require('node:tls').createSecureContext(); require('node:crypto').createHash('sha256'); const z=require('node:zlib'); if(z.gunzipSync(z.gzipSync('compiler')).toString()!=='compiler'||process.config.variables.node_shared_zlib) process.exit(1)"

COPY --from=dependencies --chown=0:0 \
  /srv/opengeo/node_modules /opt/distroless-root/srv/opengeo/node_modules
COPY --from=dependencies --chown=0:0 \
  /srv/opengeo/notebook-assets.json /opt/distroless-root/srv/opengeo/notebook-assets.json
COPY --from=cache-seed --chown=0:0 \
  /tmp/opengeo-framework-seed/.observablehq/cache \
  /opt/distroless-root/opt/opengeo-framework-cache
COPY --chown=0:0 src /opt/distroless-root/srv/opengeo/src
COPY --chown=0:0 package-lock.json /opt/distroless-root/srv/opengeo/package-lock.json
COPY --chown=0:0 scripts/verify-toolchain.mjs \
  /opt/distroless-root/srv/opengeo/scripts/verify-toolchain.mjs

RUN chmod --recursive a-w \
      /opt/distroless-root/srv/opengeo \
      /opt/distroless-root/opt/opengeo-framework-cache \
    && OPEN_GEO_FRAMEWORK_CACHE_ROOT=/opt/opengeo-framework-cache \
      /usr/sbin/chroot /opt/distroless-root /nodejs/bin/node \
      /srv/opengeo/scripts/verify-toolchain.mjs

FROM scratch

COPY --from=runtime-root /opt/distroless-root /

ENV NODE_ENV=production \
    OBSERVABLE_TELEMETRY_DISABLE=true \
    OPEN_GEO_FRAMEWORK_PROJECT_CONFIG=isolated \
    OPEN_GEO_FRAMEWORK_CACHE_ROOT=/opt/opengeo-framework-cache \
    PATH=/srv/opengeo/node_modules/.bin:/nodejs/bin:/usr/local/bin:/usr/bin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /srv/opengeo

USER 10001:10001
VOLUME ["/workspace", "/result"]
ENTRYPOINT ["/nodejs/bin/node", "/srv/opengeo/src/cli.mjs", "--observable-cli", "/srv/opengeo/node_modules/.bin/observable", "--framework-cache", "/opt/opengeo-framework-cache"]
CMD ["--contract", "/contract/invocation.json", "--input", "/input", "--workspace", "/workspace/job", "--report", "/result/compiler-report.json"]
