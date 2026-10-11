# OpenGeo Studio AWS infrastructure

Deploy OpenGeo Studio into your AWS account using the
[community AWS guide](../docs/community-aws.md) and
[deployment command](../scripts/community-aws.py).

Read the [component architecture](../docs/community-architecture.md#runtime-boundaries)
for the responsibilities and authority boundaries of each service.

The standalone profile reuses the maintained Foundation, Serverless API,
Studio Web, private endpoints and worker stacks. It supplies an independent
Cognito pool, account-qualified storage, operator-selected budget notifications,
and retained durable resources.

```bash
npm ci --prefix infrastructure
mkdir -p .opengeo
cp infrastructure/community.example.json .opengeo/aws-config.json
# Edit the account, profile, installation name and notification address.
python3 scripts/community-aws.py plan --config .opengeo/aws-config.json
python3 scripts/community-aws.py synth --config .opengeo/aws-config.json
```

Synthesis is local. Each deployment step requires `--apply` and verifies the
caller account. Use one installation per AWS account with this first profile,
in `us-east-1`. The guide covers image architectures, deployment order,
permissions, operating costs, backup, upgrades and acceptance.

`bin/opengeo-community.ts` is the community entrypoint. `bin/opengeo.ts` preserves
the original application's configurable stack assembly for maintainers working
on its existing integrations. The community command selects the independent
profile explicitly.
