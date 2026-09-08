import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseConfig, manifestFor, shellQuote } from '../scripts/aws/release.mjs';
import { infrastructure } from '../scripts/aws/infrastructure.mjs';

const env = {
  GITHUB_REPOSITORY: 'TestCraft-App/evals-framework', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  AWS_ACCOUNT_ID: '123456789012', AWS_REGION: 'us-east-1', AWS_INSTANCE_ID: 'i-0123456789abcdef0', AWS_ARTIFACT_BUCKET: 'evals-releases-example',
  ECR_REPOSITORY_URI: '123456789012.dkr.ecr.us-east-1.amazonaws.com/testcraft-evals', AWS_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:evals/keys-abcdef',
  APP_ORIGIN: 'https://example.cloudfront.net', WORKSHOP_ID: 'workshop',
};

test('deploy config binds account, region, repository, main and immutable release identities', () => {
  const config = releaseConfig(env);
  assert.equal(config.allowance, 200);
  assert.equal(releaseConfig({ ...env, WORKSHOP_MAX_MODEL_CALLS: '0' }).allowance, 0);
  const manifest = manifestFor(config, 'sha256:' + 'b'.repeat(64));
  assert.equal(manifest.image, env.ECR_REPOSITORY_URI + '@sha256:' + 'b'.repeat(64));
  assert.deepEqual(Object.keys(manifest).sort(), ['account', 'region', 'origin', 'allowance', 'secretArn', 'workshop', 'release', 'image'].sort());
  assert.equal(JSON.stringify(manifestFor(releaseConfig({ ...env, OPENAI_API_KEY: 'never-copy', AWS_SECRET_ACCESS_KEY: 'never-copy' }), 'sha256:' + 'b'.repeat(64))).includes('never-copy'), false);
  assert.throws(() => manifestFor(config, 'latest'));
});

test('wrong accounts, PRs, malformed identifiers and shell payloads fail before deployment', () => {
  const invalid = {
    GITHUB_REPOSITORY: 'someone/fork', GITHUB_REF: 'refs/pull/1/merge', GITHUB_SHA: 'main', GITHUB_RUN_ID: '123;command', GITHUB_RUN_ATTEMPT: '1\n2',
    AWS_ACCOUNT_ID: '999999999999', AWS_REGION: 'eu-central-1', AWS_INSTANCE_ID: 'i-123;command', AWS_ARTIFACT_BUCKET: 'bucket/../target',
    ECR_REPOSITORY_URI: '999999999999.dkr.ecr.us-east-1.amazonaws.com/evals', AWS_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:999999999999:secret:other',
    APP_ORIGIN: 'https://example.cloudfront.net/path', WORKSHOP_ID: 'workshop\nOPENAI_API_KEY=bad', WORKSHOP_MAX_MODEL_CALLS: '1.5',
  };
  for (const [key, value] of Object.entries(invalid)) assert.throws(() => releaseConfig({ ...env, [key]: value }), key);
  for (const origin of ['http://example.cloudfront.net', 'https://example.cloudfront.net/', 'https://user:password@example.com', 'https://example.com?other']) assert.throws(() => releaseConfig({ ...env, APP_ORIGIN: origin }));
  assert.equal(shellQuote("it's safe; $(not-executed)"), "'it'\\''s safe; $(not-executed)'");
});

test('workshop infrastructure has an isolated network, private origin and uncacheable sessions', () => {
  const { Resources: r } = infrastructure();
  assert.equal(Object.values(r).filter(x => x.Type === 'AWS::EC2::VPC').length, 1);
  assert.equal(Object.values(r).filter(x => x.Type === 'AWS::EC2::NatGateway').length, 1);
  assert.equal(r.Host.Properties.NetworkInterfaces[0].AssociatePublicIpAddress, false);
  assert.equal(r.Host.Properties.InstanceType, 't3.small');
  assert.equal(r.Host.Properties.CreditSpecification.CPUCredits, 'standard');
  assert.equal(r.Host.Properties.MetadataOptions.HttpTokens, 'required');
  assert.equal(r.Host.Properties.MetadataOptions.HttpPutResponseHopLimit, 2);
  const ingress = r.OriginSecurityGroup.Properties.SecurityGroupIngress;
  assert.equal(ingress.length, 1);
  assert.deepEqual(ingress[0].SourcePrefixListId, { Ref: 'CloudFrontPrefixList' });
  assert.equal(ingress[0].FromPort, 3000);
  assert.equal(ingress[0].CidrIp, undefined);
  const behavior = r.Distribution.Properties.DistributionConfig.DefaultCacheBehavior;
  assert.equal(behavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(behavior.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
  assert.equal(behavior.OriginRequestPolicyId, '216adef6-5c7f-47e4-b989-5492eafa07d3');
  assert.ok(behavior.AllowedMethods.includes('DELETE'));
  assert.ok(r.Distribution.Properties.DistributionConfig.CustomErrorResponses.every(x => x.ErrorCachingMinTTL === 0));
});

test('infrastructure scopes deployment access and preserves data for explicit teardown', () => {
  const { Resources: r } = infrastructure();
  const trust = r.DeployRole.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.deepEqual(trust.Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:TestCraft-App@139815958/evals-framework@1360313670:ref:refs/heads/main',
  });
  const permissions = r.DeployRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.equal(JSON.stringify(permissions).includes('secretsmanager:GetSecretValue'), false);
  assert.equal(JSON.stringify(r.HostRole).includes('AdministratorAccess'), false);
  assert.equal(r.RuntimeSecret, undefined);
  assert.deepEqual(r.HostRole.Properties.Policies[0].PolicyDocument.Statement.at(-1).Resource, { Ref: 'RuntimeSecretArn' });
  assert.equal(r.DataVolume.DeletionPolicy, 'Retain');
  assert.equal(r.DataVolume.UpdateReplacePolicy, 'Retain');
  assert.equal(r.DataVolume.Properties.Encrypted, true);
  assert.equal(r.Artifacts.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true);
  assert.equal(r.Artifacts.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(r.Images.Properties.ImageTagMutability, 'IMMUTABLE');
  assert.equal(r.Images.Properties.EmptyOnDelete, true);
});
