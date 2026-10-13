# Deploying TestCraft Evals to AWS

This guide describes the deployment implemented in this repository. Use the [operations runbook](aws-operations.md) for operator commands, acceptance checks, and teardown. Reviewed against the source and provider documentation on October 6, 2026; this is not a verification of live AWS resources or GitHub settings.

The app runs as one Node.js container with persistent SQLite storage. Anyone can sign in with GitHub as a collaborator; numeric GitHub IDs designate administrators. Collaborators can view TestCraft and run its evaluations privately, or manage their personal workspace. They supply their own OpenAI key. Administrators use server credentials. There is no application-wide model-call budget; configure spending controls with the providers.

## 1. Prerequisites and scope

- Local tooling: Node.js 22.13 or newer, PowerShell, and AWS CLI v2. CI and the container use Node.js 24.
- The provisioner targets Endava account `419466290453`, profile `endava`, region `us-east-1`, and stack `testcraft-evals-workshop`. It is not a generic multi-account script. Do not use the unrelated `default` profile. The SSO region can differ from the resource region.
- Review costs, resource ownership, quotas, retention, and teardown date before creating resources. Do not reuse another project's network or addresses to bypass quotas.
- An approved GitHub Actions OIDC provider must already exist in AWS with audience `sts.amazonaws.com`. The provisioner checks it; it does not create or modify this shared provider.
- Create or identify the application runtime secret before provisioning. Its exact ARN is a template input. Keep values out of source control, terminal commands, chat, GitHub variables, and artifacts.
- Verify administration access to `TestCraft-App/evals-framework`. Working Git SSH access alone does not grant repository-settings/API permissions.

For an existing stack, inspect its resources and outputs and proceed to configuration/release. `provision.ps1` refuses to update or overwrite an existing stack. Infrastructure changes need a separately reviewed CloudFormation update; the workflow only updates the application.

Use [AWS Pricing Calculator](https://calculator.aws/) with current [EC2](https://aws.amazon.com/ec2/pricing/on-demand/), [VPC](https://aws.amazon.com/vpc/pricing/), and [EBS](https://aws.amazon.com/ebs/pricing/) prices. Include NAT hours/traffic, public IPv4, EC2, both disks, CloudFront, ECR/S3, Secrets Manager, backups, and model calls. Stopping EC2 does not stop all those charges. Budget alerts do not automatically cap spending.

## 2. Infrastructure created by the template

Use [infrastructure.mjs](../scripts/aws/infrastructure.mjs) through [provision.ps1](../scripts/aws/provision.ps1), rather than manually creating duplicate resources.

| Component | Implemented configuration |
| --- | --- |
| Network | Dedicated VPC, public subnet for one NAT Gateway/Elastic IP, private subnet for EC2, internet gateway. No public IP on EC2. |
| Host | Amazon Linux 2023 x86_64, `t3.small`, Standard CPU credits, encrypted 16 GiB root disk. IMDSv2 required, hop limit 2. |
| Data | Separate encrypted 20 GiB gp3 volume, retained on stack deletion or volume replacement. |
| Administration | Systems Manager, no SSH ingress. Bootstrap installs Docker, AWS CLI and `jq`, and enables Docker/SSM. |
| Origin access | TCP 3000 only from the CloudFront origin-facing prefix list. Outbound TCP 443 for AWS, GitHub, TestCraft, and OpenAI. |
| ECR | Generated repository name, immutable tags, AES-256 encryption, removal of contents on stack deletion. No explicit scanning or lifecycle policy in the template. |
| S3 | Generated private artifact bucket, encryption, versioning, public-access blocking, HTTPS-only policy. Scripts/non-secret manifests use `releases/`. |
| HTTPS | CloudFront default `cloudfront.net` certificate and private EC2 VPC origin on HTTP port 3000. |
| IAM | Dedicated instance and deployment roles; deployment trust references the existing GitHub OIDC provider. |

Bootstrap identifies the data disk by EBS volume ID, rejects unexpected layouts, and only formats a blank disk. It mounts ext4 by UUID at `/var/lib/testcraft-evals`. The `data/` directory belongs to UID/GID 1000 with mode 700; `backups/` belongs to root with mode 700. Deployment refuses to run without the mount.

The instance role can use SSM, pull this ECR repository, read this bucket's `releases/*`, and read this secret. A customer-managed secret encryption key may need additional scoped `kms:Decrypt` permissions; these are not included. Do not attach AdministratorAccess. The metadata hop limit allows container access to instance-role credentials; do not run unrelated containers on this host. See [EC2 metadata options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html).

The template does not create an ALB, RDS, WAF, custom domain, backup schedule, cost alerts, retention policies, or automatic teardown.

## 3. Network and CloudFront checks

CloudFront VPC origins require an attached internet gateway and available private-subnet IPv4 addresses for service-managed interfaces. NAT supplies the application's outbound connectivity independently. In `us-east-1`, avoid physical zone ID `use1-az3`. The provisioner specifically checks `us-east-1a` and rejects it if it maps to that zone; it does not automatically choose another. Changing the selection requires a reviewed script change. Also check security-group quota capacity for the CloudFront prefix list's rule weight. See [VPC origin requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).

The template redirects HTTP to HTTPS, allows all seven HTTP methods, applies **CachingDisabled** and **AllViewer**, and sets error-cache TTLs for 500/502/503/504 to zero. Forwarding cookies, query strings, `Origin`, and `X-CSRF-Token` is essential for OAuth, sessions, and mutations. Do not add API caching or convert API errors into `index.html` responses. See [cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html) and [origin request policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html).

Use the exact `AppOrigin` stack output without a trailing slash for `APP_ORIGIN`. Do not use an instance address. CloudFormation completion does not mean bootstrap has finished or the app is installed. CloudFront errors are expected until the first healthy application release.

## 4. Runtime secret and GitHub sign-in

GitHub sign-in uses an **OAuth App**. Actions deployment uses **OIDC to AWS**. These are separate integrations.

For a new installation, create the runtime secret with administrator model credentials first. Provision the stack to obtain `AppOrigin`, then register the production OAuth App and add its client secret before the first release. This avoids needing the CloudFront hostname before it exists.

| OAuth App setting | Production value |
| --- | --- |
| Homepage URL | Exact `AppOrigin` output |
| Authorization callback URL | `AppOrigin` followed by `/api/auth/github/callback` |
| Client ID | Actions variable `OAUTH_GITHUB_CLIENT_ID` |
| Client secret | Field `GITHUB_CLIENT_SECRET` in the AWS runtime secret |

Use a separate OAuth App for local development. For `APP_ORIGIN=http://127.0.0.1:3000`, use callback `http://127.0.0.1:3000/api/auth/github/callback` and open that same hostname. See [GitHub OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

The app does not request email or repository access. It uses state, PKCE, and a temporary HttpOnly SameSite=Lax correlation cookie; normal production sessions remain HttpOnly, Secure, and SameSite=Strict. Allow outbound HTTPS to `github.com` and `api.github.com`.

The secret must be a JSON object containing only these supported fields. Enter real values privately in Secrets Manager; these placeholders are not credentials:

```json
{
  "GITHUB_CLIENT_SECRET": "PRODUCTION_OAUTH_CLIENT_SECRET",
  "OPENAI_API_KEY": "ADMIN_OPENAI_GRADING_KEY",
  "TESTCRAFT_OPENAI_API_KEY": "OPTIONAL_ADMIN_TESTCRAFT_GENERATION_KEY"
}
```

`OPENAI_API_KEY` is the administrator's OpenAI grading credential. `TESTCRAFT_OPENAI_API_KEY` goes to TestCraft for administrator generation; omit it if TestCraft should use its own generation credentials. `GITHUB_CLIENT_SECRET` is only for the OAuth exchange. Do not add URLs or settings to this JSON. Unknown fields or invalid values fail startup.

Collaborators enter a separate OpenAI key in the dashboard, explicitly forwarded to TestCraft for generation and OpenAI for grading. It stays in tab memory and the accepted job's isolated server memory, not SQLite or Secrets Manager. Refresh/logout clears the browser key; already accepted jobs continue. Collaborator runs never fall back to administrator credentials.

The app reads `AWSCURRENT` using the instance role at startup. Redeploy/restart to apply secret changes. Missing fields become empty values: readable JSON and healthy startup do **not** verify OAuth configuration or provider access. Missing OAuth configuration disables sign-in rather than enabling anonymous access. See [Secrets Manager retrieval](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-javascript.html).

## 5. GitHub Actions identity and permissions

The generated role restricts `sts:AssumeRoleWithWebIdentity` to the existing provider, audience `sts.amazonaws.com`, and this exact subject:

```text
repo:TestCraft-App@139815958/evals-framework@1360313670:ref:refs/heads/main
```

This is the template configuration, not a fresh live verification. Verify owner/repository IDs and the emitted OIDC subject before provisioning. GitHub's immutable format includes IDs; older repositories may use another format. Do not resolve mismatches with wildcards. The workflow has no GitHub Environment; adding one changes the subject and needs a trust-policy review. See [immutable subjects](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/) and [OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

| Deployment permission | Resource scope |
| --- | --- |
| `ecr:GetAuthorizationToken` | `*`, required by ECR |
| Layer upload, `ecr:PutImage`, `ecr:DescribeImages` | App repository only |
| `s3:PutObject` | App bucket's `releases/*` only |
| `ssm:SendCommand` | App instance and `AWS-RunShellScript` document only |
| `ssm:GetCommandInvocation` | `*`, without individual supported resource scope |

The role does not need secret-read or infrastructure-provisioning access. However, deploying code or running root commands grants practical control of application data. Review workflow changes and restrict repository access. Require PR review, the `test` check, and protection against direct pushes where the plan permits. The workflow also triggers on direct pushes to `main`; PR convention alone does not enforce review.

## 6. Configure and release

In **GitHub → Settings → Secrets and variables → Actions → Variables**, configure:

| Variable | Source/value |
| --- | --- |
| `AWS_ACCOUNT_ID` | Verified account `419466290453` |
| `AWS_REGION` | `us-east-1` |
| `AWS_ROLE_ARN` | Output `DeployRoleArn` |
| `AWS_INSTANCE_ID` | Output `InstanceId` |
| `AWS_ARTIFACT_BUCKET` | Output `ArtifactBucket` |
| `ECR_REPOSITORY_URI` | Output `EcrRepositoryUri`, no tag |
| `AWS_SECRET_ARN` | Output `SecretArn`, never its contents |
| `APP_ORIGIN` | Output `AppOrigin`, no trailing slash |
| `OAUTH_GITHUB_CLIENT_ID` | Production OAuth App client ID; same name in local and runtime configuration |
| `ADMIN_GITHUB_IDS` | Numeric GitHub user IDs, comma-separated without spaces; release validation requires at least one |
| `WORKSHOP_ID` | `workshop`, or the existing installation's stable scope |
| `AWS_DEPLOY_ENABLED` | Absent/`false` until ready; `true` enables releases |

GitHub reserves the `GITHUB_` prefix for Actions configuration variable names. `OAUTH_GITHUB_CLIENT_ID` is used consistently in Actions, local configuration, and the container environment.

Get an administrator's numeric ID with `gh api users/USERNAME --jq .id`. Do not use a username as the ID. Keep `WORKSHOP_ID` stable: changing it selects another storage scope rather than moving existing workspaces.

Once infrastructure, SSM, the mount, OAuth, secrets, and variables are ready, merge the reviewed change. Enable releases and select **Actions → Test and deploy → Run workflow → main**. Subsequent pushes/merges to `main` test and deploy while the flag is `true`. PRs test without deploying. CI uses no personal SSO session or permanent AWS keys.

## 7. Release sequence and recovery limits

The [workflow](../.github/workflows/ci-deploy.yml) runs Node tests, Bash syntax checks, mocked browser tests, and a Docker build/health smoke test without secrets. Deployment validates configuration/account identity, publishes a unique commit/run tag, resolves an immutable image digest, uploads non-secret artifacts, and invokes SSM. The host verifies artifact hashes and locks against concurrent releases.

[deploy-host.sh](../scripts/aws/deploy-host.sh) then:

1. Tests the image with an empty in-memory database and the runtime secret, without touching user data or calling models.
2. Stops admission of new runs and waits up to ten minutes for accepted runs. On timeout it aborts and attempts to reopen admission.
3. Stops the old container and archives the entire `data/` directory to `backups/predeploy-...tar.gz` on the data volume.
4. Starts the new container against persistent data and checks local health/release identity.
5. Removes the previous container after local success. The workflow separately checks public `/healthz`, `Cache-Control: no-store`, and the expected commit SHA.

There is a brief single-instance outage. A failed host cutover attempts to restart the previous container **without restoring SQLite**; verify health after failure. The previous container is not retained after success. A later public CloudFront health failure does not automatically roll back the host. Inspect the SSM command and running release before retrying an uncertain outcome.

There is no general one-command rollback or database restore. Review schema and authentication compatibility before releasing a code rollback through the normal protected process. An old anonymous-session build may restore old access behavior even if its schema remains readable. A database restore is a deliberate recovery operation: it excludes later writes and must never replay paid calls.

Forced restart marks unfinished runs Interrupted without replay. Account sessions persist with default 24-hour expiry; pending OAuth transactions and collaborator job credentials are memory-only. Retry sign-in if a release interrupts the callback.

## 8. Migration and acceptance

Before upgrading an anonymous installation, verify the consistent pre-release backup and keep a recoverable copy outside the data volume. Additive migrations preserve legacy records/snapshots without assigning them to new accounts. Old cookies no longer authenticate. New TestCraft and personal workspaces start empty; an administrator can populate TestCraft through Actions. Anonymous-workspace recovery is not provided. Collaborators can submit evaluation contribution requests; admins review them through the user menu. The additive request tables and admin-only review runs use the same durable SQLite database and backup process, with no additional secrets or infrastructure.

`ADMIN_GITHUB_IDS` changes require a new process with updated configuration. Roles synchronize at startup and login, including authorization for existing sessions. Editing an Actions variable alone does not change a running container. Removing an ID demotes that account on synchronization.

Complete the runbook acceptance checks before inviting users. Automated tests mock OAuth/models; health checks do not verify their live configuration. Loading, saving, and inspecting examples needs no model calls. **Executing a run generates content and can consume credits even with rule-only grading.**

Configure external health/disk/cost monitoring, encrypted off-volume backups, and retention. Test restoration on an isolated volume without replaying jobs. Local backups do not protect against losing EBS. During teardown inventory images, artifact versions, snapshots, volumes, and secrets: the data volume is retained and the external secret survives stack deletion.
