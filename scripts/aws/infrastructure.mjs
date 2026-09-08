import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ref = name => ({ Ref: name });
const att = (name, field) => ({ 'Fn::GetAtt': [name, field] });
const sub = text => ({ 'Fn::Sub': text });
const tags = name => [{ Key: 'Project', Value: 'testcraft-evals' }, { Key: 'Name', Value: sub('${AWS::StackName}-' + name) }];
const allow = (Action, Resource) => ({ Effect: 'Allow', Action, Resource });
const policy = Statement => ({ Version: '2012-10-17', Statement });
const resource = (Type, Properties, extra = {}) => ({ Type, Properties, ...extra });

export function infrastructure() {
  const bootstrap = readFileSync(new URL('./bootstrap-host.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const r = {};
  r.Network = resource('AWS::EC2::VPC', {
    CidrBlock: '10.84.0.0/24', EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tags('network'),
  });
  r.InternetGateway = resource('AWS::EC2::InternetGateway', { Tags: tags('internet') });
  r.GatewayAttachment = resource('AWS::EC2::VPCGatewayAttachment', { VpcId: ref('Network'), InternetGatewayId: ref('InternetGateway') });
  for (const [name, cidr] of [['Public', '10.84.0.0/27'], ['Private', '10.84.0.32/27']]) {
    r[name + 'Subnet'] = resource('AWS::EC2::Subnet', { VpcId: ref('Network'), CidrBlock: cidr, AvailabilityZone: ref('AvailabilityZone'), MapPublicIpOnLaunch: false, Tags: tags(name.toLowerCase()) });
    r[name + 'Routes'] = resource('AWS::EC2::RouteTable', { VpcId: ref('Network'), Tags: tags(name.toLowerCase() + '-routes') });
    r[name + 'RouteAssociation'] = resource('AWS::EC2::SubnetRouteTableAssociation', { SubnetId: ref(name + 'Subnet'), RouteTableId: ref(name + 'Routes') });
  }
  r.PublicDefaultRoute = resource('AWS::EC2::Route', { RouteTableId: ref('PublicRoutes'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref('InternetGateway') }, { DependsOn: 'GatewayAttachment' });
  r.NatAddress = resource('AWS::EC2::EIP', { Domain: 'vpc', Tags: tags('nat-address') }, { DependsOn: 'GatewayAttachment' });
  r.NatGateway = resource('AWS::EC2::NatGateway', { AllocationId: att('NatAddress', 'AllocationId'), SubnetId: ref('PublicSubnet'), Tags: tags('nat') }, { DependsOn: ['PublicDefaultRoute', 'PublicRouteAssociation'] });
  r.PrivateDefaultRoute = resource('AWS::EC2::Route', { RouteTableId: ref('PrivateRoutes'), DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: ref('NatGateway') });
  r.OriginSecurityGroup = resource('AWS::EC2::SecurityGroup', {
    GroupDescription: 'TestCraft private origin: CloudFront only, no SSH', VpcId: ref('Network'), Tags: tags('origin'),
    SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 3000, ToPort: 3000, SourcePrefixListId: ref('CloudFrontPrefixList') }],
    SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS to AWS, TestCraft and model providers' }],
  });
  r.Images = resource('AWS::ECR::Repository', {
    ImageTagMutability: 'IMMUTABLE', EmptyOnDelete: true, EncryptionConfiguration: { EncryptionType: 'AES256' }, Tags: tags('images'),
  });
  r.Artifacts = resource('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    VersioningConfiguration: { Status: 'Enabled' }, Tags: tags('releases'),
  });
  r.ArtifactPolicy = resource('AWS::S3::BucketPolicy', {
    Bucket: ref('Artifacts'), PolicyDocument: policy([{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [att('Artifacts', 'Arn'), sub('${Artifacts.Arn}/*')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } }]),
  });
  r.HostRole = resource('AWS::IAM::Role', {
    AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
    ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    Policies: [{ PolicyName: 'ApplicationReadOnly', PolicyDocument: policy([
      allow('ecr:GetAuthorizationToken', '*'),
      allow(['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], att('Images', 'Arn')),
      allow('s3:GetObject', sub('${Artifacts.Arn}/releases/*')),
      allow('secretsmanager:GetSecretValue', ref('RuntimeSecretArn')),
    ]) }], Tags: tags('host-role'),
  });
  r.HostProfile = resource('AWS::IAM::InstanceProfile', { Roles: [ref('HostRole')] });
  // Preserve workshop data on infrastructure replacement; teardown must remove it explicitly.
  r.DataVolume = resource('AWS::EC2::Volume', { AvailabilityZone: ref('AvailabilityZone'), Size: 20, VolumeType: 'gp3', Encrypted: true, Tags: tags('data') }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  r.Host = resource('AWS::EC2::Instance', {
    ImageId: ref('ImageId'), InstanceType: 't3.small', IamInstanceProfile: ref('HostProfile'),
    CreditSpecification: { CPUCredits: 'standard' },
    MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 2 },
    NetworkInterfaces: [{ DeviceIndex: '0', AssociatePublicIpAddress: false, SubnetId: ref('PrivateSubnet'), GroupSet: [ref('OriginSecurityGroup')] }],
    BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 16, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true } }],
    UserData: { 'Fn::Base64': { 'Fn::Join': ['', ['#!/usr/bin/env bash\ntask_volume_id=', ref('DataVolume'), '\n', bootstrap]] } },
    Tags: tags('host'),
  }, { DependsOn: ['PrivateDefaultRoute', 'PrivateRouteAssociation'] });
  r.DataAttachment = resource('AWS::EC2::VolumeAttachment', { Device: '/dev/sdf', InstanceId: ref('Host'), VolumeId: ref('DataVolume') });
  r.VpcOrigin = resource('AWS::CloudFront::VpcOrigin', {
    VpcOriginEndpointConfig: { Name: sub('${AWS::StackName}-origin'), Arn: sub('arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Host}'), HTTPPort: 3000, HTTPSPort: 443, OriginProtocolPolicy: 'http-only', OriginSSLProtocols: ['TLSv1.2'] }, Tags: tags('vpc-origin'),
  });
  r.Distribution = resource('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Enabled: true, Comment: sub('${AWS::StackName} temporary workshop'), HttpVersion: 'http2and3', IPV6Enabled: true, PriceClass: 'PriceClass_All',
      Origins: [{ Id: 'private-application', DomainName: att('Host', 'PrivateDnsName'), VpcOriginConfig: { VpcOriginId: att('VpcOrigin', 'Id'), OriginReadTimeout: 30, OriginKeepaliveTimeout: 5 } }],
      DefaultCacheBehavior: {
        TargetOriginId: 'private-application', ViewerProtocolPolicy: 'redirect-to-https', Compress: true,
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'], CachedMethods: ['GET', 'HEAD'],
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3',
      },
      ViewerCertificate: { CloudFrontDefaultCertificate: true },
      CustomErrorResponses: [500, 502, 503, 504].map(ErrorCode => ({ ErrorCode, ErrorCachingMinTTL: 0 })),
    }, Tags: tags('https'),
  });
  r.DeployRole = resource('AWS::IAM::Role', {
    AssumeRolePolicyDocument: policy([{
      Effect: 'Allow', Principal: { Federated: ref('GithubOidcArn') }, Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:TestCraft-App/evals-framework:ref:refs/heads/main' } },
    }]),
    Policies: [{ PolicyName: 'DeployOnlyThisApplication', PolicyDocument: policy([
      allow('ecr:GetAuthorizationToken', '*'),
      allow(['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:DescribeImages'], att('Images', 'Arn')),
      allow('s3:PutObject', sub('${Artifacts.Arn}/releases/*')),
      allow('ssm:SendCommand', [sub('arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Host}'), sub('arn:aws:ssm:${AWS::Region}::document/AWS-RunShellScript')]),
      allow('ssm:GetCommandInvocation', '*'),
    ]) }], Tags: tags('github-deploy'),
  });
  return {
    AWSTemplateFormatVersion: '2010-09-09', Description: 'Dedicated temporary TestCraft Evals workshop: private EC2, NAT and public HTTPS. No application secrets in this template.',
    Parameters: {
      AvailabilityZone: { Type: 'AWS::EC2::AvailabilityZone::Name', Description: 'Must not be physical zone use1-az3 in us-east-1.' },
      CloudFrontPrefixList: { Type: 'String', AllowedPattern: '^pl-[a-f0-9]+$' },
      GithubOidcArn: { Type: 'String', AllowedPattern: '^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$' },
      RuntimeSecretArn: { Type: 'String', AllowedPattern: '^arn:aws:secretsmanager:us-east-1:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$', Description: 'ARN only. Create the app-specific secret manually; its value never enters CloudFormation.' },
      ImageId: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64' },
    }, Resources: r,
    Outputs: {
      AppOrigin: { Value: sub('https://${Distribution.DomainName}') }, DistributionId: { Value: ref('Distribution') },
      InstanceId: { Value: ref('Host') }, DataVolumeId: { Value: ref('DataVolume') },
      ArtifactBucket: { Value: ref('Artifacts') }, EcrRepositoryUri: { Value: att('Images', 'RepositoryUri') },
      SecretArn: { Value: ref('RuntimeSecretArn') }, DeployRoleArn: { Value: att('DeployRole', 'Arn') },
      NatGatewayId: { Value: ref('NatGateway') }, NatAllocationId: { Value: att('NatAddress', 'AllocationId') },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const json = JSON.stringify(infrastructure(), null, 2) + '\n';
  if (process.argv.includes('--save')) {
    mkdirSync(new URL('../../.aws-deploy/', import.meta.url), { recursive: true });
    writeFileSync(new URL('../../.aws-deploy/infrastructure.json', import.meta.url), json);
    console.log('Generated .aws-deploy/infrastructure.json (no credentials).');
  } else console.log(json);
}
