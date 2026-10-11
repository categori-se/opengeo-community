import {
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
  aws_cognito as cognito
} from "aws-cdk-lib";
import type {Construct} from "constructs";

export interface WebAuthStackProps extends StackProps {
  readonly stage: "dev" | "staging" | "demo" | "production";
  readonly webOrigin: string;
  readonly legacyWebOrigin?: string;
  readonly userPoolId: string;
  readonly cognitoRegion: string;
  readonly hostedUiBaseUrl: string;
}

/**
 * Deploys the zero-secret browser OAuth client independently of the database/API
 * foundation. This lets OpenGeo Studio use the shared auth pool without
 * prematurely provisioning the persistent platform; production may retain the
 * legacy apex callback only for the bounded Studio cutover rollback window.
 */
export class WebAuthStack extends Stack {
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: WebAuthStackProps) {
    super(scope, id, props);

    if (props.legacyWebOrigin !== undefined
      && (props.stage !== "production"
        || props.legacyWebOrigin !== "https://opengeo.tools"
        || props.legacyWebOrigin === props.webOrigin)) {
      throw new Error("legacy web origin must be the exact production https://opengeo.tools origin");
    }
    const callbackOrigins = [
      props.webOrigin,
      ...(props.legacyWebOrigin ? [props.legacyWebOrigin] : [])
    ];

    const userPool = cognito.UserPool.fromUserPoolId(this, "SharedUserPool", props.userPoolId);
    this.userPoolClient = new cognito.UserPoolClient(this, "WebClient", {
      userPool,
      userPoolClientName: `opengeo-${props.stage}-web`,
      generateSecret: false,
      oAuth: {
        flows: {authorizationCodeGrant: true},
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE
        ],
        callbackUrls: callbackOrigins.map((origin) => `${origin}/login`),
        logoutUrls: callbackOrigins.map((origin) => `${origin}/login`),
        defaultRedirectUri: `${props.webOrigin}/login`
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true
    });

    const browserConfig = this.toJsonString({
      version: 1,
      region: props.cognitoRegion,
      userPoolId: props.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      hostedUiBaseUrl: props.hostedUiBaseUrl,
      redirectUri: `${props.webOrigin}/login`,
      logoutUri: `${props.webOrigin}/login`,
      scopes: ["openid", "email", "profile"]
    });
    new CfnOutput(this, "UserPoolClientId", {value: this.userPoolClient.userPoolClientId});
    new CfnOutput(this, "BrowserAuthConfigJson", {value: browserConfig});
    new CfnOutput(this, "ApplicationWebOrigin", {value: props.webOrigin});
    new CfnOutput(this, "CognitoHostedUiBaseUrl", {value: props.hostedUiBaseUrl});
  }
}
