import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function releaseConfig(env) {
  const checked = (name, pattern) => {
    const value = env[name] || '';
    if (!pattern.test(value)) throw new Error(`Invalid or missing ${name}.`);
    return value;
  };
  if (env.GITHUB_REPOSITORY !== 'TestCraft-App/evals-framework' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Deployment is allowed only from this repository main branch.');
  const account = checked('AWS_ACCOUNT_ID', /^\d{12}$/);
  const region = checked('AWS_REGION', /^[a-z]{2}-[a-z]+-\d$/);
  const repository = checked('ECR_REPOSITORY_URI', new RegExp(`^${account}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/[a-z0-9]+(?:[._/-][a-z0-9]+)*$`));
  const secretArn = checked('AWS_SECRET_ARN', new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:[A-Za-z0-9/_+=.@-]+$`));
  const origin = checked('APP_ORIGIN', /^https:\/\/[a-zA-Z0-9.-]+$/);
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be the exact HTTPS origin, without a trailing slash.');
  return {
    account, region, repository, secretArn, origin,
    instance: checked('AWS_INSTANCE_ID', /^i-[a-f0-9]{8,17}$/),
    bucket: checked('AWS_ARTIFACT_BUCKET', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    release: checked('GITHUB_SHA', /^[a-f0-9]{40}$/),
    run: `${checked('GITHUB_RUN_ID', /^\d+$/)}-${checked('GITHUB_RUN_ATTEMPT', /^\d+$/)}`,
    workshop: checked('WORKSHOP_ID', /^[A-Za-z0-9_-]{1,80}$/),
    githubClientId: checked('GITHUB_CLIENT_ID', /^[A-Za-z0-9_.-]{1,100}$/),
    adminGithubIds: checked('ADMIN_GITHUB_IDS', /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/),
  };
}

export function manifestFor(config, digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Expected an immutable ECR image digest.');
  const { account, region, origin, secretArn, workshop, release, githubClientId, adminGithubIds } = config;
  return { account, region, origin, secretArn, workshop, release, githubClientId, adminGithubIds, image: `${config.repository}@${digest}` };
}

const exec = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, ...options });
const aws = (region, args) => exec('aws', [...args, '--region', region, '--no-cli-pager']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function publish() {
  const config = releaseConfig(process.env);
  if (process.argv.includes('--check-config')) { console.log('Deployment configuration is valid.'); return; }
  if (exec('git', ['rev-parse', 'HEAD']).trim() !== config.release) throw new Error('Checkout does not match the release commit.');
  const { region } = config;
  if (aws(region, ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']).trim() !== config.account) throw new Error('Unexpected AWS account; no deployment attempted.');
  const imageTag = `${config.release}-${config.run}`;
  const image = `${config.repository}:${imageTag}`;
  const token = aws(region, ['ecr', 'get-login-password']);
  exec('docker', ['login', '--username', 'AWS', '--password-stdin', config.repository.split('/')[0]], { input: token, stdio: ['pipe', 'inherit', 'inherit'] });
  exec('docker', ['build', '--pull', '--platform', 'linux/amd64', '-t', image, '.'], { stdio: 'inherit' });
  exec('docker', ['push', image], { stdio: 'inherit' });
  const digest = aws(region, ['ecr', 'describe-images', '--repository-name', config.repository.split('/').slice(1).join('/'), '--image-ids', `imageTag=${imageTag}`, '--query', 'imageDetails[0].imageDigest', '--output', 'text']).trim();
  const manifest = JSON.stringify(manifestFor(config, digest));
  const script = await readFile(new URL('./deploy-host.sh', import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), 'testcraft-release-'));
  try {
    await writeFile(join(temp, 'release.json'), manifest);
    const prefix = `releases/${config.release}/${config.run}`;
    aws(region, ['s3', 'cp', join(temp, 'release.json'), `s3://${config.bucket}/${prefix}/release.json`, '--only-show-errors']);
    aws(region, ['s3', 'cp', resolve('scripts/aws/deploy-host.sh'), `s3://${config.bucket}/${prefix}/deploy-host.sh`, '--only-show-errors']);
    // Only non-secret configuration is sent through Run Command. The app itself reads Secrets Manager.
    const commands = [
      'set -eu',
      'task_dir=$(mktemp -d /run/testcraft-release-XXXXXX)',
      `trap 'rm -f "$task_dir/release.json" "$task_dir/deploy-host.sh"; rmdir "$task_dir"' EXIT`,
      ...['release.json', 'deploy-host.sh'].map(file => `aws s3 cp ${shellQuote(`s3://${config.bucket}/${prefix}/${file}`)} "$task_dir/${file}" --region ${shellQuote(region)} --only-show-errors`),
      `printf '%s  %s\\n' ${shellQuote(hash(manifest))} "$task_dir/release.json" ${shellQuote(hash(script))} "$task_dir/deploy-host.sh" | sha256sum --check --status`,
      'bash "$task_dir/deploy-host.sh" "$task_dir/release.json"',
    ];
    const result = JSON.parse(aws(region, ['ssm', 'send-command', '--instance-ids', config.instance, '--document-name', 'AWS-RunShellScript', '--comment', `TestCraft release ${config.release}`, '--parameters', JSON.stringify({ commands, executionTimeout: ['1200'] }), '--output', 'json']));
    const id = result.Command.CommandId;
    console.log(`Deployment command: ${id}`);
    let completed = false;
    for (let attempt = 0; attempt < 250; attempt++) {
      await delay(5000);
      let invocation;
      try { invocation = JSON.parse(aws(region, ['ssm', 'get-command-invocation', '--command-id', id, '--instance-id', config.instance, '--output', 'json'])); }
      catch (error) { if (String(error.stderr).includes('InvocationDoesNotExist')) continue; throw error; }
      if (invocation.Status === 'Success') { completed = true; break; }
      if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) throw new Error(`Deployment ${invocation.Status}. Inspect Run Command ${id}; no automatic re-dispatch.`);
    }
    if (!completed) throw new Error(`Deployment outcome is not confirmed. Inspect Run Command ${id} before retrying.`);
    const health = await fetch(`${config.origin}/healthz`, { signal: AbortSignal.timeout(15000), redirect: 'error', cache: 'no-store' });
    if (!health.ok || health.headers.get('cache-control') !== 'no-store' || (await health.json()).release !== config.release) throw new Error('Public health verification failed. Inspect CloudFront and the running release before retrying.');
    console.log(`Verified release ${config.release} at ${config.origin}`);
  } finally {
    await rm(join(temp, 'release.json'), { force: true });
    await rmdir(temp);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publish().catch(error => { console.error(error.message); process.exitCode = 1; });
}
