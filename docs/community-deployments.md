# Choose an OpenGeo Studio installation

OpenGeo Studio is the software: an open workspace for geospatial analysis and
publishing. OpenGeo.Tools brings together Studio and our public methods and
knowledge library.

Try the browser Demo, use our operated Studio or run the community stack with
your own configuration. The full suite is available under Apache-2.0 in the
[public source repository](https://github.com/categori-se/opengeo-community).
Hosting and implementation services use the same software.

## Compare the paths

| Path | Operator | Data and account management | Prerequisites | Updates and support |
| --- | --- | --- | --- | --- |
| [Browser Demo](https://demo.studio.opengeo.tools/) | Maintainer | Personal saves in your browser; no Studio account. Remote services retain their own data and terms. | A supported browser and permitted inputs; [small exercise](community-examples.md#try-it-community-facilities). | Maintainer updates the Demo; you retain browser backups. |
| [Hosted Studio](https://studio.opengeo.tools/) | Maintainer | Account-backed work and permitted resources in the operated installation; access is arranged with the maintainer. | Existing access or [request hosted Studio access](https://www.linkedin.com/in/akdennis/). | Hosting, usage, data handling and support follow agreed terms. |
| [Community installation](community-development.md) | You or your chosen operator | Your configured database, storage, identity and resource permissions. | Connected local services or an [AWS account and deployment configuration](community-aws.md). | Your operator manages updates and recovery; community help is available as time allows. |
| [Assisted company deployment](../SUPPORT.md#hosting-and-enterprise-support) | Agreed during implementation and handover | Organizational infrastructure, connections and account administration defined in the scope. | An agreed environment, workflow and implementation scope. | Scoped installation, integration, training and handover; ongoing operation is agreed separately. |
| [Managed organizational deployment](../SUPPORT.md#hosting-and-enterprise-support) | Maintainer under an agreement | An organizational installation with agreed hosting, data access and account responsibilities. | Agreed infrastructure access, workflows, usage and responsibilities. | Maintenance, upgrades, backup/recovery and support only as agreed for that installation. |

An access inquiry does not create an account, grant resource access or activate a
subscription. A service discussion establishes scope and availability; the
software license establishes no hosting entitlement or service guarantee.

## Try the browser Demo

Inspect, modify and export the [facilities study](community-examples.md#try-it-community-facilities),
or open a supported local file or public web layer. **Save on this device** creates
a personal Project, separate from samples and account storage. Personal Projects
have no daily expiry and survive sample resets. Browser storage can be cleared or
evicted, so download a backup. Older sample drafts use separate storage with daily
expiry; follow the selected workflow's notice.

Local files in the anonymous Demo are not managed uploads, and publication
demonstrations do not release a live website. Referenced services may receive
browser requests. Exports may still depend on remote data; another website cannot
read your Demo browser storage. See the [workflow guide](community-workflow.md#choose-a-workspace).

## Use hosted Studio or request access

Existing users can [open Studio](https://studio.opengeo.tools/) and sign in to
work within their account and resource permissions. To discuss access,
[request hosted Studio access](https://www.linkedin.com/in/akdennis/)
with your intended workflow, team size, source types, approximate volumes and
publishing destination. Access and services are arranged with the maintainer.

## Run the full community stack

The [connected development guide](community-development.md) runs Studio, the API,
PostGIS and selected worker functionality together. Its local identity and
transport substitutes support development. Use its upload, save, restart and
reopen exercise; frontend development alone does not run the connected platform.

The [AWS guide](community-aws.md) describes the cloud deployment profile. Your
operator configures identity, database, storage, queues, enabled processing and
publication delivery, and manages accounts, upgrades, monitoring, recovery and
workload charges. Inspect the [architecture](community-architecture.md) and
[capabilities](community-capabilities.md) before enabling services.

Clean installation, independent AWS deployment and the complete native
Notebook/Framework build, preview and publication journey still need acceptance;
see the [release status](../RELEASE_NOTES.md). Existing local checks and
our hosted outputs do not establish a fresh installation's complete journey.

## Commission or manage an organizational installation

An assisted deployment can cover configuration, private integrations, training
and handover. Managed operation adds responsibilities agreed for the installation.
Specify who administers accounts and infrastructure, where data resides, how
updates are approved, and which retention, backup, recovery and support
arrangements apply. No schedule, hosting region or service-level commitment is
implied before agreement. [Discuss a deployment](https://www.linkedin.com/in/akdennis/)
through the [support guide](../SUPPORT.md#hosting-and-enterprise-support).

## Shared core, separate configured deployments

The community edition provides working Studio software, supporting services and
local/AWS deployment guidance. A deployment owner can configure its own domains,
routes, branding, styles, data connections, team permissions and supported usage
limits. The generic tools and deployment source remain part of the community
edition; OpenGeo's tenant data, credentials and private deployment configuration
do not become community defaults.

`demo.studio.opengeo.tools` is a deliberate public reference deployment, similar
to an example client implementation. It has its own build profile, public example
Catalog, presentation and resource limits. Demo-specific navigation and sample
controls belong to that deployment. They must not appear simply because someone
is authoring a local map in another deployment.

`studio.opengeo.tools` is our managed commercial deployment, with its own account
services, private connections and organizational configuration. Managed hosting,
retention, delivery and support are distinct from the community software license.
The demo's anonymous operation and current limits do not define the full community
edition or impose the commercial deployment's policies on self-hosted installations.
Changing quotas, enabled tools or membership limits requires the deployment's actual
configuration and authorization checks; a theme or navigation flag never grants access.

## See the software in use

| Destination | How we use it | What you can try |
| --- | --- | --- |
| [OpenGeo.Tools](https://opengeo.tools/) | Public delivery of Publications, dataset introductions, maps and analytical examples | Read published work and explore its maps, methods and source references |
| [studio.opengeo.tools](https://studio.opengeo.tools/) | Authenticated authoring and curation with persistent account permissions | Sign in to work with permitted Catalog resources, compose Projects and author Publications |
| [demo.studio.opengeo.tools](https://demo.studio.opengeo.tools/) | An isolated anonymous GIS workbench | Open local GIS files, add public web layers, style and inspect data, measure features and save a draft in the browser |

For an example of published work,
[Map Folio](https://opengeo.tools/map-folio/) shows map-based delivery and
[Accessible and Standardized Cartographic Design](https://opengeo.tools/accessible-cartographic-design/)
documents reusable cartographic choices. Dataset and provider terms remain
separate from the software license.

## Follow the source into your own installation

The hosted deployment separates the public publication origin, compiled Studio
and anonymous demo. Studio uses the API, account permissions and spatial database;
processing workers handle deliberate queued GIS jobs. Public outputs and the
demo are delivered as compiled web assets. The demo has its own delivery edge
without an account API or sign-in configuration.

- [Run the connected development environment](community-development.md) to work
  with Studio, API, PostGIS and the GIS worker locally.
- [Deploy to your own AWS account](community-aws.md) for account-owned identity,
  encrypted storage, processing and a sealed Studio release.
- Read the [resource model](../ARCHITECTURE_TERMS.md) for the relationship
  between Layers, Projects, Artifacts and Publications.
- Explore the [demo entry source](../app/demo/index.md),
  [workbench component](../app/src/components/PublicDemoWorkbench.js) and
  [Studio demo description](../app/src/public-demo.md) to see how the example is
  assembled from maintained application components.

For installation requirements and known limitations, see the
[AWS guide](community-aws.md), [development guide](community-development.md) and
[roadmap](../ROADMAP.md).

For fee-based hosting or enterprise support for your installation, contact
[Aaron Kyle Dennis](https://www.linkedin.com/in/akdennis/) through the
[support guide](../SUPPORT.md#hosting-and-enterprise-support).

Find Aaron on [LinkedIn](https://www.linkedin.com/in/akdennis/) or the [Observable forum](https://talk.observablehq.com/u/aaronkyle/activity).
