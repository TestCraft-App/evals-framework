// Shared, non-secret catalog: the API supplies the same definitions used by validation.
export const evaluationMethods = {
  model_grade: {
    family: 'model_based', familyLabel: 'Model-based', label: 'LLM as a judge',
    gradingCalls: 1, deterministic: false,
    description: 'An LLM assesses quality against your rubric, with a score, evidence and a short explanation per criterion. No reference answer is required.',
    criteriaHint: 'Write observable qualities, not required words. Each criterion has equal weight. For example: a negative test describes the action and the expected error.',
    placeholder: 'e.g. Includes a failed login scenario and states the expected behavior.',
    limitation: 'The judge can vary or be wrong. Review its evidence with a human. It does not execute code or visit the page URL.',
  },
  contains: {
    family: 'rule_based', familyLabel: 'Rule-based', label: 'Contains',
    gradingCalls: 0, deterministic: true,
    description: 'Checks that the output contains each required text fragment. Grading runs locally without an LLM.',
    criteriaHint: 'Enter one literal required fragment per item, not an instruction. Matching is case-sensitive; each fragment has equal weight.',
    placeholder: 'e.g. getByRole',
    limitation: 'Text presence does not prove correctness: a fragment in a comment also matches. Use the judge for meaning and quality.',
  },
  not_contains: {
    family: 'rule_based', familyLabel: 'Rule-based', label: 'Does not contain',
    gradingCalls: 0, deterministic: true,
    description: 'Checks each forbidden text fragment for absence in the output. Grading runs locally without an LLM.',
    criteriaHint: 'Enter one literal forbidden fragment per item, such as waitForTimeout or TODO. Each absent fragment passes; matching is case-sensitive.',
    placeholder: 'e.g. waitForTimeout',
    limitation: 'This is a text check, not code analysis. Comments also match, and differently written equivalents may go undetected.',
  },
  exact_match: {
    family: 'rule_based', familyLabel: 'Rule-based', label: 'Exact match',
    gradingCalls: 0, deterministic: true,
    description: 'Compares the entire output with one literal target. Best for a fixed label or tightly constrained response, not freely generated tests.',
    criteriaHint: 'Enter exactly one item with the complete text to match. Only outer whitespace and CRLF line endings are normalized.',
    placeholder: 'The complete response text to match',
    limitation: 'A different but valid answer still fails. Case, punctuation and internal whitespace matter.',
  },
};

export const methods = Object.keys(evaluationMethods);
