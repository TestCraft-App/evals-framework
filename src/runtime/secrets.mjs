const allowedKeys = new Set(['OPENAI_API_KEY', 'TESTCRAFT_OPENAI_API_KEY']);

export function parseSecrets(raw) {
  const invalid = () => new Error('The AWS secret must be a JSON object containing only the supported API-key fields.');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384) throw invalid();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw invalid(); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw invalid();
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowedKeys.has(key) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw invalid();
  }
  return parsed;
}

async function readAwsSecret({ arn, region }) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region, maxAttempts: 2 });
  try {
    return (await client.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }), { abortSignal: AbortSignal.timeout(15000) })).SecretString;
  } finally { client.destroy(); }
}

export async function loadRuntimeSecrets(env, readSecret = readAwsSecret) {
  if (!env.AWS_SECRET_ARN) return;
  if (!env.AWS_REGION || !env.AWS_SECRET_ARN.startsWith(`arn:aws:secretsmanager:${env.AWS_REGION}:`)) {
    throw new Error('Configure AWS_REGION and an AWS_SECRET_ARN in that region.');
  }
  let raw;
  try { raw = await readSecret({ arn: env.AWS_SECRET_ARN, region: env.AWS_REGION }); }
  catch { throw new Error('Could not load runtime credentials from AWS Secrets Manager. Check the instance role, region and network.'); }
  const secrets = parseSecrets(raw);
  // AWS mode is authoritative: never silently retain a stale local credential.
  for (const key of allowedKeys) env[key] = secrets[key] || '';
}
