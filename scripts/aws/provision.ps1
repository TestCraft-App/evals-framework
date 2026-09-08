param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^arn:aws:secretsmanager:us-east-1:419466290453:secret:[A-Za-z0-9/_+=.@-]+$')]
  [string]$RuntimeSecretArn,
  [switch]$Create
)
$ErrorActionPreference = 'Stop'
$taskAws = (Get-Command aws -ErrorAction Stop).Source
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$taskAccount = '419466290453'
$taskRegion = 'us-east-1'
$taskStack = 'testcraft-evals-workshop'

function Invoke-WorkshopAws {
  param([string[]]$Arguments)
  $taskOutput = & $taskAws @Arguments --profile endava --region $taskRegion --no-cli-pager --output json
  if ($LASTEXITCODE -ne 0) { throw 'AWS request failed. Inspect the error above; do not repeat an uncertain create.' }
  return ($taskOutput | ConvertFrom-Json)
}

$taskIdentity = Invoke-WorkshopAws -Arguments @('sts', 'get-caller-identity')
if ($taskIdentity.Account -ne $taskAccount) { throw 'Wrong AWS account. No resources created.' }
$taskSecret = Invoke-WorkshopAws -Arguments @('secretsmanager', 'describe-secret', '--secret-id', $RuntimeSecretArn)
if ($taskSecret.DeletedDate -or $taskSecret.ARN -cne $RuntimeSecretArn) { throw 'Expected the exact active secret explicitly provided by the operator. Its contents were not read.' }
$taskZones = Invoke-WorkshopAws -Arguments @('ec2', 'describe-availability-zones')
$taskZone = $taskZones.AvailabilityZones | Where-Object { $_.ZoneName -eq 'us-east-1a' -and $_.ZoneId -ne 'use1-az3' -and $_.State -eq 'available' }
if (-not $taskZone) { throw 'The selected zone is not suitable for CloudFront VPC origins.' }
$taskVpcs = Invoke-WorkshopAws -Arguments @('ec2', 'describe-vpcs')
$taskVpcQuota = Invoke-WorkshopAws -Arguments @('service-quotas', 'get-service-quota', '--service-code', 'vpc', '--quota-code', 'L-F678F1CE')
if (@($taskVpcs.Vpcs).Count -ge $taskVpcQuota.Quota.Value) { throw 'VPC quota is full. Wait for the approved increase; no existing network will be modified.' }
$taskAddresses = Invoke-WorkshopAws -Arguments @('ec2', 'describe-addresses')
$taskAddressQuota = Invoke-WorkshopAws -Arguments @('service-quotas', 'get-service-quota', '--service-code', 'ec2', '--quota-code', 'L-0263D0A3')
if (@($taskAddresses.Addresses).Count -ge $taskAddressQuota.Quota.Value) { throw 'Elastic IP quota is full; do not reuse an address belonging to another project.' }
$taskPrefixes = Invoke-WorkshopAws -Arguments @('ec2', 'describe-managed-prefix-lists', '--filters', 'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing')
if (@($taskPrefixes.PrefixLists).Count -ne 1) { throw 'Could not resolve the CloudFront prefix list.' }
$taskOidcArn = "arn:aws:iam::${taskAccount}:oidc-provider/token.actions.githubusercontent.com"
$taskOidc = Invoke-WorkshopAws -Arguments @('iam', 'get-open-id-connect-provider', '--open-id-connect-provider-arn', $taskOidcArn)
if ($taskOidc.Url -ne 'token.actions.githubusercontent.com' -or $taskOidc.ClientIDList -notcontains 'sts.amazonaws.com') { throw 'GitHub OIDC provider is missing or incompatible; shared settings were not changed.' }
$taskStacks = Invoke-WorkshopAws -Arguments @('cloudformation', 'list-stacks')
if ($taskStacks.StackSummaries | Where-Object { $_.StackName -eq $taskStack -and $_.StackStatus -ne 'DELETE_COMPLETE' }) { throw 'A stack with this name exists. Inspect it; this script never updates or overwrites an existing deployment.' }

Push-Location $taskRoot
try {
  & node scripts/aws/infrastructure.mjs --save
  if ($LASTEXITCODE -ne 0) { throw 'Template generation failed.' }
  $null = Invoke-WorkshopAws -Arguments @('cloudformation', 'validate-template', '--template-body', 'file://.aws-deploy/infrastructure.json')
  if (-not $Create) {
    Write-Output 'Preflight passed. No infrastructure created. Add -Create only to provision the approved paid resources.'
    return
  }
  $taskToken = 'testcraft-' + [guid]::NewGuid().ToString()
  Write-Output "Creating only $taskStack in Endava $taskAccount / $taskRegion. Request token: $taskToken"
  $taskResult = Invoke-WorkshopAws -Arguments @(
    'cloudformation', 'create-stack', '--stack-name', $taskStack,
    '--template-body', 'file://.aws-deploy/infrastructure.json', '--capabilities', 'CAPABILITY_IAM',
    '--client-request-token', $taskToken,
    '--parameters',
    "ParameterKey=AvailabilityZone,ParameterValue=$($taskZone.ZoneName)",
    "ParameterKey=CloudFrontPrefixList,ParameterValue=$($taskPrefixes.PrefixLists[0].PrefixListId)",
    "ParameterKey=GithubOidcArn,ParameterValue=$taskOidcArn",
    "ParameterKey=RuntimeSecretArn,ParameterValue=$RuntimeSecretArn",
    '--tags', 'Key=Project,Value=testcraft-evals', 'Key=Purpose,Value=workshop', 'Key=Owner,Value=jfagundez-uy'
  )
  Write-Output $taskResult.StackId
  Write-Output 'Creation requested, not yet verified. Inspect stack events and SSM readiness. A rollback can retain the dedicated data volume; inventory it explicitly.'
} finally { Pop-Location }
