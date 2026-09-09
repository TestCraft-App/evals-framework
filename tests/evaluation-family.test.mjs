import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluationFamily } from '../public/run-detail.js';

test('display family reflects criteria rather than the mixed-method storage identifier', () => {
  const record = methods => ({ method: 'hybrid', criteria: methods.map(method => ({ method, text: method })) });
  assert.equal(evaluationFamily(record(['contains', 'not_contains', 'exact_match'])), 'rule_based');
  assert.equal(evaluationFamily(record(['model_grade', 'model_grade'])), 'model_based');
  assert.equal(evaluationFamily(record(['contains', 'model_grade'])), 'hybrid');
  assert.equal(evaluationFamily({ method: 'contains', criteria: ['login'] }), 'rule_based');
  assert.equal(evaluationFamily({ method: 'model_grade', criteria: 'Covers login' }), 'model_based');
  assert.equal(evaluationFamily({ method: 'hybrid' }), 'hybrid');
});
