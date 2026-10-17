FROM python:3.13.15-alpine3.23@sha256:7ea3f82de8ea6d4fb7e5d2bbe3fe3c9d931700b7a529f1fe5769e42abe514ca1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/srv/opengeo/src \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OPENGEO_PRINT_UNIFONT_PATH=/srv/opengeo/fonts/unifont_all-17.0.04.hex.gz \
    OPENGEO_PRINT_UNIFONT_SHA256=c31d210962408a00de8e2ebe2f2fc26824d7a4939d4eb15d347761fb2a0b39a6 \
    OPENGEO_PRINT_UNIFONT_REQUIRED=true

WORKDIR /srv/opengeo

RUN apk add --no-cache --upgrade \
    'libcrypto3=3.5.9-r0' \
    'libssl3=3.5.9-r0'

RUN addgroup -S -g 10001 opengeo \
    && adduser -S -D -H -u 10001 -G opengeo -s /sbin/nologin opengeo

RUN python -c "from urllib.request import urlretrieve; urlretrieve('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', '/tmp/aws-rds-global-bundle.pem')" \
    && echo '90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b  /tmp/aws-rds-global-bundle.pem' | sha256sum -c - \
    && mv /tmp/aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem \
    && chmod 0444 /etc/ssl/certs/aws-rds-global-bundle.pem

COPY scripts/fetch_pinned_https_asset.py ./fetch_pinned_https_asset.py
RUN python ./fetch_pinned_https_asset.py \
      --output /tmp/unifont.hex.gz \
      --sha256 c31d210962408a00de8e2ebe2f2fc26824d7a4939d4eb15d347761fb2a0b39a6 \
      --max-bytes 2097152 \
      https://mirrors.ibiblio.org/gnu/unifont/unifont-17.0.04/unifont_all-17.0.04.hex.gz \
      https://ftp.gnu.org/gnu/unifont/unifont-17.0.04/unifont_all-17.0.04.hex.gz \
      https://ftp.uni-bayreuth.de/GNU/unifont/unifont-17.0.04/unifont_all-17.0.04.hex.gz \
    && mkdir -p /srv/opengeo/fonts \
    && mv /tmp/unifont.hex.gz /srv/opengeo/fonts/unifont_all-17.0.04.hex.gz \
    && rm ./fetch_pinned_https_asset.py
COPY assets/GNU-Unifont-LICENSE.txt /srv/opengeo/fonts/GNU-Unifont-LICENSE.txt
RUN chmod 0444 /srv/opengeo/fonts/GNU-Unifont-LICENSE.txt \
    && echo '1beb7361eeb289e022d085a0f2457bd59492cf2a49ca52956550a36d34f8408d  /srv/opengeo/fonts/GNU-Unifont-LICENSE.txt' | sha256sum -c -

COPY requirements.lock ./requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes --requirement requirements.lock

COPY src ./src

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health/live', timeout=2)"]

CMD ["python", "-m", "opengeo_api"]
