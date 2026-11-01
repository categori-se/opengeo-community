import assert from "node:assert/strict";
import {it} from "node:test";
import {OpenGeoApiClient} from "../src/lib/apiClient.js";

it("submits account requests without bearer tokens, cookies or an account selection", async () => {
  const calls = [];
  const client = new OpenGeoApiClient({baseUrl: "https://studio.example.test/api",
    tokenProvider: () => {throw Error("request must be anonymous");},
    organizationProvider: () => {throw Error("request must not need account access");},
    fetchImplementation: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({status: "pending"}), {status: 202});
    }});
  assert.deepEqual(await client.requestAccount({displayName: " Person ", email: " PERSON@EXAMPLE.TEST ",
    purpose: " A regional geospatial analysis. "}), {status: "pending"});
  const [url, options] = calls[0];
  assert.equal(url, "https://studio.example.test/api/auth/account-requests");
  assert.equal(options.headers.has("authorization"), false);
  assert.equal(options.headers.has("X-OpenGeo-Organization"), false);
  assert.equal(options.credentials, "omit");
  assert.deepEqual(JSON.parse(options.body), {display_name: "Person", email: "person@example.test",
    purpose: "A regional geospatial analysis.", website: ""});
});

it("surfaces the server rate limit without treating a failed submission as pending", async () => {
  const client = new OpenGeoApiClient({fetchImplementation: async () => new Response(
    JSON.stringify({detail: "account_request_rate_limited"}), {status: 429})});
  await assert.rejects(client.requestAccount({displayName: "Person", email: "person@example.test",
    purpose: "A regional geospatial analysis."}), error => error.status === 429
      && error.code === "account_request_rate_limited");
});
