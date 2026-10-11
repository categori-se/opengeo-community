import assert from "node:assert/strict";
import {it} from "node:test";
import {App} from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {StudioWebStack} from "../lib/studio-web-stack.js";
import {DemoWebStack} from "../lib/demo-web-stack.js";
import {RENDERER_FRAME_PATH, RENDERER_FRAME_CSP} from "../lib/renderer-frame.js";

for (const StackType of [StudioWebStack, DemoWebStack]) {
  it(`${StackType.name} permits embedding only the exact renderer host document`, () => {
    const stack = new StackType(new App(), "FrameCheck", {
      env: {account: "111111111111", region: "us-east-1"}
    });
    const template = Template.fromStack(stack).toJSON();
    const resources = template.Resources;
    const distribution = Object.values(resources).find((r: any) => r.Type === "AWS::CloudFront::Distribution") as any;
    const config = distribution.Properties.DistributionConfig;
    const behaviors = config.CacheBehaviors;
    const host = behaviors.find((b: any) => b.PathPattern === RENDERER_FRAME_PATH);
    assert.ok(host);
    assert.deepEqual(host.AllowedMethods, ["GET", "HEAD"]);
    assert.equal(host.TargetOriginId, config.DefaultCacheBehavior.TargetOriginId);
    const headerConfig = (behavior: any) => resources[behavior.ResponseHeadersPolicyId.Ref].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    assert.equal(headerConfig(host).ContentSecurityPolicy.ContentSecurityPolicy, RENDERER_FRAME_CSP);
    assert.equal(headerConfig(host).FrameOptions.FrameOption, "SAMEORIGIN");
    for (const behavior of [config.DefaultCacheBehavior, ...behaviors.filter((b: any) => b !== host)]) {
      assert.equal(headerConfig(behavior).FrameOptions.FrameOption, "DENY");
      assert.match(headerConfig(behavior).ContentSecurityPolicy.ContentSecurityPolicy, /frame-ancestors 'none'/);
    }
    assert.match(RENDERER_FRAME_CSP, /connect-src 'self' https:\/\/gibs.earthdata.nasa.gov https:\/\/basemap.nationalmap.gov https:\/\/services.arcgisonline.com;/);
    assert.match(RENDERER_FRAME_CSP, /frame-src 'none';/);
    assert.doesNotMatch(RENDERER_FRAME_CSP, /script-src[^;]*'unsafe-inline'/);
  });
}
