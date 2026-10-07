import { AppError } from './validation.mjs';

export async function validatePersonalApiKey(value, env, fetchImpl = fetch) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value.trim())) throw new AppError('Enter a valid OpenAI API key without spaces.');
  const key = value.trim();
  try {
    const response = await fetchImpl(`${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, {
      method: 'GET', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    try {
      // Provider authentication failures are input errors, not expired app sessions.
      if (response.status === 401) throw new AppError('This API key was rejected by OpenAI. Check the key and try again.', 422);
      if (response.status === 403) throw new AppError('This API key cannot access the OpenAI model list. Check its permissions and try again.', 422);
      if (response.status === 429) throw new AppError('OpenAI is rate limiting the key check. Please try again shortly.', 503);
      if (!response.ok) throw new AppError('OpenAI could not validate the API key right now. Please try again.', 502);
      const raw = await response.text();
      if (raw.length > 500000) throw new AppError('OpenAI returned an unexpected key-check response. Please try again.', 502);
      let data; try { data = JSON.parse(raw); } catch { throw new AppError('OpenAI returned an unexpected key-check response. Please try again.', 502); }
      if (data?.object !== 'list' || !Array.isArray(data.data)) throw new AppError('OpenAI returned an unexpected key-check response. Please try again.', 502);
      return { valid: true };
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(error.name === 'TimeoutError' ? 'The API key check timed out. Please try again.' : 'OpenAI could not be reached to check the API key. Please try again.', 502);
  }
}
