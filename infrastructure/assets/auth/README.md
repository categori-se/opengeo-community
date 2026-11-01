# Studio provider sign-in branding

Studio's local sign-in panel and its external identity-provider dialog are
separate origins. Styling Studio does not style the provider dialog.

These assets define browser-adaptive light/dark colors and OpenGeo Studio form
logos for Cognito managed login. Apply them only to your existing Studio browser
client in its configured user pool. Preserve other clients and pool defaults.

Use the existing Cognito branding editor to choose **Browser adaptive** and upload
`opengeo-studio-logo-light.svg` and `opengeo-studio-logo-dark.svg` as the corresponding
**Form logo** assets. Set colors from [managed-login-settings.json](managed-login-settings.json).
The editor does not import this JSON; it is the API `Settings` value for existing
operator tooling. New logo assets use category `FORM_LOGO`, color modes `LIGHT` and
`DARK`, extension `SVG`, and their file bytes, without a `ResourceId` selector.

Retain the exact client's existing style before editing. Read with
`DescribeManagedLoginBrandingByClient` and `ReturnMergedResources: false` to inspect
customizations without replaying built-in provider assets. Update the existing
branding ID with the settings patch and two logos; unspecified settings/assets are
preserved. Set `UseCognitoProvidedValues: false` for customization. The combined
request must remain below 2 MiB. Do not delete an existing style to change colors.

Select an existing managed-login endpoint for that pool in the next normal Studio
release's `hostedUiBaseUrl`. Keep client/pool IDs, callback/logout URLs, scopes,
capabilities, preview settings and API configuration unchanged. Never edit a sealed
release or publish its auth configuration separately. Verify the normal sign-in,
recovery and callback flow with light and dark browser preferences after delivery.
Provider identity does not itself grant Studio account or resource access.

Classic Hosted UI only supports restricted logo/CSS overrides and forbids `@media`.
If the configured endpoint is classic, use an already configured managed-login
endpoint where available. A shared-domain migration affects other clients and
needs its own reviewed scope. These assets make no domain or feature-plan changes.

Sources: [managed-login branding](https://docs.aws.amazon.com/cognito/latest/developerguide/managed-login-brandingeditor.html),
[customization readback](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_DescribeManagedLoginBrandingByClient.html),
[branding updates](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UpdateManagedLoginBranding.html),
[classic restrictions](https://docs.aws.amazon.com/cognito/latest/developerguide/hosted-ui-classic-branding.html).
