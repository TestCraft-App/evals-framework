# AWS workshop operations runbook

Use this checklist with the [deployment guide](aws-deployment.md) for architecture, OAuth, permissions, and release behavior. Commands below are for an operator to run against verified targets; updating this document does not provision or deploy anything.

## 1. Confirm target and ownership

| Item | Repository configuration |
| --- | --- |
| AWS account/profile | Endava `419466290453` / `endava` |
| Resource region | `us-east-1` |
| Stack | `testcraft-evals-workshop` |
| Repository | `TestCraft-App/evals-framework` |
| Intended GitHub operator | `jfagundez-uy`, subject to current access verification |
| Release gate | Actions variable `AWS_DEPLOY_ENABLED` |

The `default` AWS profile and GitHub account `juan-fagundez_cldev` belong to another context. Do not use them here. The Endava SSO region was previously recorded as `eu-central-1`; it does not determine the resource region. Verify the current profile rather than changing unrelated profiles.

Record the responsible operator, approved budget, retention decision, and a **new teardown date/time**. The previous September 10, 2026 workshop deadline has passed and is not an active shutdown schedule. This repository has no automated teardown.

From PowerShell in the repository root:

```powershell
aws sso login --profile endava
aws sts get-caller-identity --profile endava --region us-east-1
gh auth status --hostname github.com
```

Confirm account `419466290453` and the intended GitHub identity. If needed, select the correct existing login or use `gh auth login --hostname github.com --web --git-protocol ssh --skip-ssh-key`, then verify again. Working Git SSH access does not establish repository administration rights.

Inspect whether the stack already exists:

```powershell
aws cloudformation describe-stacks --stack-name testcraft-evals-workshop --profile endava --region us-east-1 --query 'Stacks[0].{StackId:StackId,Status:StackStatus,Outputs:Outputs}' --output json
```

Only a confirmed stack-not-found response means absence. Authentication, permission, or network errors do not. For an existing stack, inspect its status/resources and skip creation. The provisioner cannot update it.

## 2. Prepare the runtime secret privately

In the Endava console, select **N. Virginia (`us-east-1`) → Secrets Manager**. Identify the existing app secret before creating another. A historical reference appears at the end of this runbook; verify its ownership and active status before reuse.

Use **Other type of secret** with JSON fields `OPENAI_API_KEY`, optional `TESTCRAFT_OPENAI_API_KEY`, and `GITHUB_CLIENT_SECRET`. The deployment guide explains their distinct destinations. Use default Secrets Manager encryption unless a reviewed customer-managed KMS policy is required. Do not enable automatic rotation without an integration that actually rotates those credentials.

For a new stack, add the production OAuth client secret after CloudFront provides `AppOrigin`, before releasing sign-in to users. Secret existence/format does not validate provider keys, model access, or credit balances. Do not add unrelated settings to the JSON.

Record only its exact ARN. The secret is external to the stack and survives deletion. Credentials load at startup; redeploy/restart after changing them.

## 3. Provision a new installation

Review the account-specific constants and resources in [provision.ps1](../scripts/aws/provision.ps1) and [infrastructure.mjs](../scripts/aws/infrastructure.mjs). The script checks identity, secret metadata, zone, VPC/Elastic IP quotas, CloudFront prefix list, the existing OIDC provider, and absence of an active stack with the same name. It does not read the secret value.

Replace the placeholder with the verified ARN. Run preflight without `-Create`:

```powershell
$taskSecretArn = 'REPLACE_WITH_VERIFIED_RUNTIME_SECRET_ARN'
./scripts/aws/provision.ps1 -RuntimeSecretArn $taskSecretArn
```

Preflight generates `.aws-deploy/infrastructure.json` locally and asks CloudFormation to validate it, but creates no cloud resources. It is not a complete guarantee of provisioning success. Investigate failed checks rather than borrowing another project's network/address or bypassing validation.

Once the resource plan and costs are approved, request creation:

```powershell
./scripts/aws/provision.ps1 -RuntimeSecretArn $taskSecretArn -Create
```

This creates paid resources and returns a StackId before creation finishes. Record it and monitor:

```powershell
aws cloudformation describe-stack-events --stack-name testcraft-evals-workshop --profile endava --region us-east-1 --output table
aws cloudformation describe-stacks --stack-name testcraft-evals-workshop --profile endava --region us-east-1 --query 'Stacks[0].{StackId:StackId,Status:StackStatus,Outputs:Outputs}' --output json
```

For an uncertain result or rollback, inspect events and retained resources before retrying. Failed creation can retain the data volume. The template creates a dedicated deployment role referencing the shared OIDC provider; it does not reuse an existing deployment role or alter the provider.

After `CREATE_COMPLETE`, confirm the host is Online in Systems Manager. CloudFormation does not wait for bootstrap to finish. Use the actual `InstanceId` output:

```powershell
$taskInstanceId = 'REPLACE_WITH_INSTANCE_ID_OUTPUT'
aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$taskInstanceId" --profile endava --region us-east-1 --query 'InstanceInformationList[].{InstanceId:InstanceId,PingStatus:PingStatus}' --output table
```

Through an authorized SSM session, check `/var/log/cloud-init-output.log`, Docker, and `findmnt /var/lib/testcraft-evals`. Verify the disk matches `DataVolumeId`. Never format a guessed device or release against an unmounted directory.

Keep an inventory of StackId and all outputs: `AppOrigin`, `DistributionId`, `InstanceId`, `DataVolumeId`, `ArtifactBucket`, `EcrRepositoryUri`, `SecretArn`, `DeployRoleArn`, `NatGatewayId`, and `NatAllocationId`. These are identifiers, not secret values.

## 4. Configure GitHub and publish

1. Register the production OAuth App with Homepage URL equal to `AppOrigin` and callback `AppOrigin/api/auth/github/callback`. Use a separate localhost registration. Add its client secret to the AWS secret.
2. Verify the Actions OIDC subject against the template's exact owner/repository IDs and `main` ref. OAuth credentials do not fix OIDC trust failures.
3. Set Actions variables using the deployment guide's output-to-variable table, including `OAUTH_GITHUB_CLIENT_ID` and numeric `ADMIN_GITHUB_IDS`. GitHub reserves the `GITHUB_` prefix; `OAUTH_GITHUB_CLIENT_ID` is also the local/runtime name. Keep `WORKSHOP_ID` stable and `AWS_DEPLOY_ENABLED=false` until ready.
4. Review and merge through a PR. Verify current branch-protection capabilities and permissions; the workflow also triggers on direct pushes to `main`.
5. Set `AWS_DEPLOY_ENABLED=true`, then select **Actions → Test and deploy → Run workflow → main**. Follow both jobs. Record the commit SHA and SSM command ID.
6. Check public health using the actual output:

```powershell
$taskAppOrigin = 'REPLACE_WITH_APP_ORIGIN_OUTPUT'
Invoke-WebRequest -Uri "$taskAppOrigin/healthz"
```

Expect HTTP 200, `Cache-Control: no-store`, and the intended release SHA. This verifies process readiness/routing, not OAuth validity or model credentials. Complete browser acceptance before inviting participants.

For an existing anonymous installation, verify its pre-release backup before migration. Legacy data remains preserved but inaccessible through new accounts. Sign in as an administrator and use Actions to populate the initially empty TestCraft workspace; accounts do not claim anonymous data.

## 5. Acceptance rehearsal

Use synthetic inputs. Loading, editing, saving, inspecting, and deleting examples needs no model calls. Actual runs can consume credits; use controlled provider budgets for live checks.

1. Sign in with an allowlisted administrator. Confirm role, TestCraft write access, and My workspace access. Load examples/workshop content into the intended workspace.
2. Sign in with a different, non-allowlisted GitHub account in another browser profile. Confirm TestCraft is readable, editing is unavailable, and personal content is writable. Collaborator loader actions in TestCraft should target My workspace.
3. Test personal isolation with two **different GitHub accounts**. The same account across profiles/devices intentionally sees the same workspace. Neither account, including an administrator, should access the other's personal data.
4. Confirm a collaborator cannot run without a key. Enter a dedicated OpenAI key and run a small TestCraft evaluation. Its result should open in My workspace, retain its TestCraft source label, and leave official TestCraft latest results unchanged.
5. Run a small TestCraft evaluation as administrator and confirm its official result appears in TestCraft. Use a model-graded evaluation to exercise both generation and OpenAI grading credentials. These are paid provider checks, separate from mocked CI tests.
6. Refresh and confirm the collaborator key must be entered again. Log out/in: data persists and the browser key is empty. Check separate tabs retain their workspace routes and switching with unsaved edits prompts for confirmation.
7. During an approved release rehearsal, keep a small run active and confirm draining lets it finish, data/sessions survive, and paid calls are not replayed. Use synthetic/mocked jobs for restart-recovery testing where practical.
8. Verify API responses are not cached across accounts and public access goes through CloudFront HTTPS. Do not open the origin port or SSH to the internet for troubleshooting.
9. Verify health/disk/cost monitoring and restore an off-volume backup into an isolated recovery environment. Do not automatically execute restored runs.

## 6. Troubleshooting and routine operation

| Symptom | Check before retrying |
| --- | --- |
| Provisioner rejects account, zone, quota, or stack | Selected profile and exact condition. It supports its configured target and cannot update a stack. |
| OIDC `AccessDenied` | Actual subject, audience, provider, role trust, repository, and `main` ref. Do not use a wildcard. |
| SSM missing/offline | Bootstrap log, instance role, SSM agent, private routing/NAT, DNS, outbound HTTPS. |
| Missing mount or leftover container blocks release | Actual data volume and previous/check containers from earlier attempts. Do not blindly remove containers or recreate storage. |
| Startup secret check fails | Exact ARN/region, instance permissions, network, JSON field names/types, and custom KMS access. Do not print secrets. |
| Healthy but sign-in unavailable/failing | Client ID/secret, exact origin/callback, GitHub connectivity, fresh attempt after restart. Missing OAuth can coexist with healthy startup. |
| API 401/403 | Session, current role/workspace permission, exact origin, forwarded CSRF header/cookies. Do not relax protections. |
| CloudFront 502/503 | Host health, VPC origin readiness, security groups/port 3000. Draining deliberately reports non-ready health. |
| SSM outcome unknown or public health fails after host success | Inspect that command and running release before another dispatch. Public-check failure does not automatically roll back. |
| Run fails | Collaborator key or separate admin generation/grading keys, provider/model permissions, budgets, connectivity. There is no collaborator fallback. |
| Disk fills | SQLite/evidence, local archives, root-disk Docker images, logs. Apply reviewed retention while preserving recovery material. |

A successful host release removes the previous container but retains its database backup. Restart of the previous container is only attempted during failed host cutover, without restoring SQLite. Review code/schema/authentication compatibility before a later rollback through the release process. There is no automated database restore.

Local pre-deploy archives share the SQLite EBS volume. Arrange encrypted snapshots or external backups and test restoration; the template configures neither. Restrict backup access because they contain account data/evidence. Define retention for archives, images, and artifact versions.

## 7. Teardown checklist

Teardown removes the app from the internet and can destroy evaluations, runs, backups, and images. Confirm exact targets and retention first, using outputs, resource IDs, account/region, and tags. Never use account-wide deletion commands or assumed names. Shared resources and the GitHub OIDC provider are outside scope.

1. Set `AWS_DEPLOY_ENABLED=false` in the correct repository and verify no release is running.
2. Stop new runs and wait for accepted jobs. In an authorized host session, `docker kill --signal USR2 testcraft-evals` drains the app. Check `/healthz` reports `status: draining` and `idle: true`; HTTP 503 is expected. If canceled, `docker kill --signal CONT testcraft-evals` reopens admission.
3. Make any required consistent final backup while the app is stopped, move it to the agreed private destination, and verify it before deleting storage. Inventory all resources, including retained volumes/snapshots from failed attempts or replacements.
4. Empty only the verified artifact bucket, including versions/delete markers; abort outstanding multipart uploads. CloudFormation cannot delete a non-empty versioned bucket.
5. Delete the exact stack and monitor to `DELETE_COMPLETE`. It removes CloudFront/VPC origin, instance/root disk, NAT/Elastic IP, ECR/images, the empty artifact bucket, and dedicated network/roles. Investigate failed deletions; remaining resources can keep charging.
6. Explicitly delete the verified detached data volume when retention permits. Both `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` apply. Check other retained application volumes. This destroys SQLite and local backups; recovery requires an external copy.
7. Delete the dedicated external secret using the inventory's `SecretArn` and agreed recovery period, after confirming no other app uses it. Deleting a Secrets Manager record does not revoke provider keys. Coordinate dedicated key revocation and retirement of the production OAuth App; do not revoke shared keys or the separate local registration.
8. Remove only snapshots/backups selected for deletion. Recheck EBS, NAT/Elastic IP, S3, ECR, Secrets Manager, and CloudFront against the inventory; report residual resources. Billing can lag, so an immediate billing view cannot establish zero future cost.

A reminder does not remove resources. Renew expired SSO with `aws sso login --profile endava`. Even if the app never released successfully, inspect manual secrets, partial stacks, and retained volumes before concluding nothing remains.

## Historical references: verify before reuse

These preserve earlier operator context, not current inventory or permission checks:

- September 8, 2026: VPC quota reportedly increased from five to six under request `01e70684f5604ff8936d147ed9435069CrrGGtaM`. That created no infrastructure; check available quota again.
- Previously recorded secret: `evals-app`, ARN `arn:aws:secretsmanager:us-east-1:419466290453:secret:evals-app-S8XRid`. Verify metadata, ownership, and active status before reuse; avoid creating a duplicate simply because setup is repeated.
- A previous private-repository branch-protection request returned 403 due to plan limitations. Check current plan/settings. PR convention alone does not block direct pushes.
- Previous workshop cost estimates and the September 10 teardown date are obsolete planning references. Obtain a current estimate and assign a new teardown owner/date.
