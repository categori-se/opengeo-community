import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {WebAuthStack} from "../lib/web-auth-stack.js";

function templateForProduction(legacyWebOrigin: string | null = "https://opengeo.tools"): Template {
  const app = new App();
  return Template.fromStack(new WebAuthStack(app, "Test-WebAuth", {
    stage: "production",
    webOrigin: "https://studio.opengeo.tools",
    ...(legacyWebOrigin ? {legacyWebOrigin} : {}),
    userPoolId: "us-east-1_KXUwaZnuQ",
    cognitoRegion: "us-east-1",
    hostedUiBaseUrl: "https://auth.categori.se",
    env: {account: "111111111111", region: "us-east-1"}
  }));
}

describe("standalone OpenGeo web authentication", () => {
  it("creates only a dedicated no-secret authorization-code client in the shared pool", () => {
    const template = templateForProduction();
    template.resourceCountIs("AWS::Cognito::UserPool", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 0);
    template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      UserPoolId: "us-east-1_KXUwaZnuQ",
      ClientName: "opengeo-production-web",
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ["openid", "email", "profile"],
      CallbackURLs: [
        "https://studio.opengeo.tools/login",
        "https://opengeo.tools/login"
      ],
      LogoutURLs: [
        "https://studio.opengeo.tools/login",
        "https://opengeo.tools/login"
      ],
      DefaultRedirectURI: "https://studio.opengeo.tools/login",
      SupportedIdentityProviders: ["COGNITO"],
      PreventUserExistenceErrors: "ENABLED"
    });
    const [client] = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
    assert.ok(client);
    assert.deepEqual(client.Properties.CallbackURLs, [
      "https://studio.opengeo.tools/login",
      "https://opengeo.tools/login"
    ]);
    assert.deepEqual(client.Properties.LogoutURLs, [
      "https://studio.opengeo.tools/login",
      "https://opengeo.tools/login"
    ]);
    const body = JSON.stringify(template.toJSON());
    assert.doesNotMatch(body, /ClientSecret|ADMIN_USER_PASSWORD_AUTH|USER_PASSWORD_AUTH|\*\.opengeo/);
    template.hasOutput("BrowserAuthConfigJson", {Value: Match.anyValue()});
  });

  it("keeps the legacy callback optional and rejects any noncanonical legacy origin", () => {
    templateForProduction(null).hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: ["https://studio.opengeo.tools/login"],
      LogoutURLs: ["https://studio.opengeo.tools/login"]
    });
    const app = new App();
    assert.throws(() => new WebAuthStack(app, "Unsafe-WebAuth", {
      stage: "production",
      webOrigin: "https://studio.opengeo.tools",
      legacyWebOrigin: "https://*.opengeo.tools",
      userPoolId: "us-east-1_KXUwaZnuQ",
      cognitoRegion: "us-east-1",
      hostedUiBaseUrl: "https://auth.categori.se"
    }), /exact production/);
  });
});
