import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  KML_NETWORK_LINK_LIMITS,
  acceptKmlNetworkLinkReceipt,
  authorizeKmlNetworkLink,
  buildKmlNetworkLinkRequest,
  executeKmlNetworkLinkRequest,
  kmlNetworkLinkRefreshDecision,
  normalizeKmlNetworkLink,
  normalizeKmlNetworkLinkState,
  normalizeNetworkLinkHref,
  receiptForKmlNetworkLinkState,
  scaleKmlNetworkLinkView
} from "../src/lib/kmlNetworkLink.js";

const LINK = {
  href: "https://data.opengeo.tools/live.kml?collection=sites",
  refreshMode: "onInterval",
  refreshInterval: 30,
  viewRefreshMode: "onStop",
  viewRefreshTime: 2,
  viewBoundScale: 1.25,
  viewFormat: "BBOX=[bboxWest],[bboxSouth],[bboxEast],[bboxNorth]",
  httpQuery: "client=[clientName]&language=[language]"
};
const APPROVED_AT = "2026-08-24T12:00:00.000Z";
const EXPIRES_AT = "2026-08-24T13:00:00.000Z";

describe("governed KML NetworkLink contract", () => {
  it("normalizes standard refresh/view fields under explicit bounds", () => {
    assert.deepEqual(normalizeKmlNetworkLink(LINK), LINK);
    for (const value of [
      {...LINK, refreshInterval: KML_NETWORK_LINK_LIMITS.minimumRefreshIntervalSeconds - 1},
      {...LINK, viewRefreshTime: 61},
      {...LINK, viewBoundScale: 101},
      {...LINK, refreshMode: "continuously"},
      {...LINK, viewRefreshMode: "always"},
      {...LINK, viewFormat: "BBOX=[unknownToken]"}
    ]) assert.throws(() => normalizeKmlNetworkLink(value));
  });

  it("rejects credential-bearing and non-public-shaped targets before authorization", () => {
    for (const href of [
      "http://data.opengeo.tools/live.kml",
      "https://localhost/live.kml",
      "https://10.0.0.1/live.kml",
      "https://metadata.google.internal/latest/",
      "https://user:secret@data.opengeo.tools/live.kml",
      "https://data.opengeo.tools/live.kml?X-Amz-Signature=secret",
      "https://data.opengeo.tools:8443/live.kml",
      "../private.kml"
    ]) assert.throws(() => authorizeKmlNetworkLink({...LINK, href}, {approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT}), undefined, href);
    assert.equal(normalizeNetworkLinkHref("nested/linked.kml"), "nested/linked.kml");
  });

  it("binds approval to the exact source and expands only known view tokens", () => {
    const approval = authorizeKmlNetworkLink(LINK, {approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT});
    const request = buildKmlNetworkLinkRequest(LINK, approval, {
      linkId: "live-sites",
      reason: "view-stop",
      now: "2026-08-24T12:05:00Z",
      view: {west: 13, south: 52, east: 14, north: 53, language: "en-US"},
      etag: '"revision-1"'
    });
    assert.equal(request.securityContract, "public-https-dns-pinned-no-redirect-no-credentials-v1");
    assert.deepEqual(request.transport, {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store"
    });
    assert.match(request.requestUrl, /collection=sites/);
    assert.match(request.requestUrl, /BBOX=12.875%2C51.875%2C14.125%2C53.125/);
    assert.match(request.requestUrl, /client=OpenGeo/);
    assert.match(request.requestUrl, /language=en-US/);
    assert.equal(request.conditional.etag, '"revision-1"');
    assert.throws(() => buildKmlNetworkLinkRequest({...LINK, href: "https://other.opengeo.tools/live.kml"}, approval, {
      linkId: "live-sites", now: "2026-08-24T12:05:00Z"
    }), /not_authorized/);
  });

  it("accepts only closed, byte-exact, DNS-pinned, TLS-verified, no-redirect receipts", () => {
    const approval = authorizeKmlNetworkLink(LINK, {approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT});
    const request = buildKmlNetworkLinkRequest(LINK, approval, {linkId: "live-sites", reason: "manual", now: "2026-08-24T12:05:00Z"});
    const bodyText = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>';
    const base = {
      requestUrl: request.requestUrl,
      finalUrl: request.requestUrl,
      status: 200,
      redirects: 0,
      dnsPinned: true,
      allAddressesPublic: true,
      tlsVerified: true,
      credentialsSent: false,
      mediaType: "application/vnd.google-earth.kml+xml",
      byteLength: new TextEncoder().encode(bodyText).byteLength,
      fetchedAt: "2026-08-24T12:05:01Z",
      expiresAt: "2026-08-24T12:10:00Z",
      etag: '"revision-2"',
      bodyText
    };
    const receipt = acceptKmlNetworkLinkReceipt(request, base);
    assert.deepEqual(receipt.security, {dnsPinned: true, allAddressesPublic: true, tlsVerified: true, redirects: 0, credentialsSent: false});
    assert.equal(receipt.byteLength, base.byteLength);
    for (const patch of [
      {finalUrl: "https://redirect.opengeo.tools/live.kml"},
      {redirects: 1},
      {dnsPinned: false},
      {allAddressesPublic: false},
      {tlsVerified: false},
      {credentialsSent: true},
      {byteLength: base.byteLength + 1},
      {mediaType: "text/html"},
      {fetchedAt: "2026-08-24T12:04:59Z"},
      {fetchedAt: "2026-08-24T12:05:11Z"},
      {expiresAt: "2026-08-24T12:05:00Z"},
      {expiresAt: "2026-08-25T12:05:02Z"}
    ]) assert.throws(() => acceptKmlNetworkLinkReceipt(request, {...base, ...patch}));
  });

  it("scales view bounds, ignores viewFormat in never mode, and preserves antimeridian intent", () => {
    assert.deepEqual(scaleKmlNetworkLinkView({west: 13, south: 52, east: 14, north: 53}, 1.25), {
      west: 12.875,
      south: 51.875,
      east: 14.125,
      north: 53.125
    });
    assert.deepEqual(scaleKmlNetworkLinkView({west: 170, south: -10, east: -170, north: 10}, 2), {
      west: 160,
      south: -20,
      east: 200,
      north: 20
    });
    const approval = authorizeKmlNetworkLink({...LINK, viewRefreshMode: "never"}, {approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT});
    const request = buildKmlNetworkLinkRequest({...LINK, viewRefreshMode: "never"}, approval, {
      linkId: "live-sites",
      now: "2026-08-24T12:05:00Z",
      view: {west: 13, south: 52, east: 14, north: 53}
    });
    assert.doesNotMatch(request.requestUrl, /BBOX=/);
    assert.match(request.requestUrl, /client=OpenGeo/);
  });

  it("enforces cancellation and the request timeout even when an adapter ignores the signal", async () => {
    const approval = authorizeKmlNetworkLink(LINK, {approvedAt: APPROVED_AT, expiresAt: EXPIRES_AT});
    const request = buildKmlNetworkLinkRequest(LINK, approval, {linkId: "live-sites", now: "2026-08-24T12:05:00Z"});
    const cancelled = new AbortController();
    const pendingCancellation = executeKmlNetworkLinkRequest(() => new Promise(() => {}), request, {
      controller: cancelled,
      timeoutMilliseconds: 50
    });
    cancelled.abort();
    await assert.rejects(pendingCancellation, (error) => error.name === "AbortError" && error.code === "kml_network_link_cancelled");
    await assert.rejects(
      executeKmlNetworkLinkRequest(() => new Promise(() => {}), request, {timeoutMilliseconds: 5}),
      (error) => error.code === "kml_network_link_timeout"
    );
  });

  it("makes interval, expiry, view-stop, on-request, region-entry, and cancellation decisions deterministic", () => {
    const runtime = {lastSuccessAt: "2026-08-24T12:00:00Z", expiresAt: "2026-08-24T12:10:00Z", inFlight: false};
    assert.equal(kmlNetworkLinkRefreshDecision(LINK, {...runtime, contentAvailable: false}, {reason: "initial", now: "2026-08-24T12:00:01Z"}).due, true);
    assert.equal(kmlNetworkLinkRefreshDecision(LINK, {...runtime, contentAvailable: true}, {reason: "initial", now: "2026-08-24T12:00:01Z"}).due, false);
    assert.equal(kmlNetworkLinkRefreshDecision(LINK, runtime, {reason: "interval", now: "2026-08-24T12:00:29Z"}).due, false);
    assert.equal(kmlNetworkLinkRefreshDecision(LINK, runtime, {reason: "interval", now: "2026-08-24T12:00:30Z"}).due, true);
    assert.equal(kmlNetworkLinkRefreshDecision({...LINK, refreshMode: "onExpire"}, runtime, {reason: "expire", now: "2026-08-24T12:10:00Z"}).due, true);
    assert.equal(kmlNetworkLinkRefreshDecision(LINK, runtime, {reason: "view-stop", viewStoppedAt: "2026-08-24T12:00:00Z", now: "2026-08-24T12:00:02Z"}).due, true);
    assert.equal(kmlNetworkLinkRefreshDecision({...LINK, viewRefreshMode: "onRequest"}, runtime, {reason: "view-request", now: "2026-08-24T12:00:02Z"}).due, true);
    assert.equal(kmlNetworkLinkRefreshDecision({...LINK, viewRefreshMode: "onRegion"}, {...runtime, regionActive: false}, {reason: "region", regionActive: true, now: "2026-08-24T12:00:02Z"}).due, true);
    assert.deepEqual(kmlNetworkLinkRefreshDecision(LINK, {...runtime, inFlight: true}, {reason: "manual", now: "2026-08-24T12:00:02Z"}), {due: false, dueAt: null, reason: "in-flight"});
  });

  it("persists only bounded safe receipt metadata, never response bodies or approvals", () => {
    const stateReceipt = receiptForKmlNetworkLinkState({
      linkId: "live-sites",
      reason: "manual",
      sourceHref: "https://data.opengeo.tools/live.kml?collection=sites",
      requestUrl: "https://data.opengeo.tools/live.kml?collection=sites",
      fetchedAt: "2026-08-24T12:05:01Z",
      status: 200,
      mediaType: "application/vnd.google-earth.kml+xml",
      byteLength: 64,
      etag: '"revision-2"',
      lastModified: null,
      expiresAt: "2026-08-24T12:10:00Z",
      content: {result: "pass_with_declared_losses", featureCount: 3, declaredLossCount: 1},
      bodyText: "must not persist"
    });
    assert.equal(Object.hasOwn(stateReceipt, "bodyText"), false);
    assert.deepEqual(stateReceipt.content, {result: "pass_with_declared_losses", featureCount: 3, declaredLossCount: 1});
    const state = normalizeKmlNetworkLinkState({schemaVersion: "1.0.0", receipts: [stateReceipt]});
    assert.equal(state.receipts.length, 1);
    assert.equal(JSON.stringify(state).includes("must not persist"), false);
    assert.throws(() => normalizeKmlNetworkLinkState({schemaVersion: "1.0.0", receipts: Array(65).fill(stateReceipt)}));
  });
});
