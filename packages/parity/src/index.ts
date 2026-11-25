import type { ParityStatus } from '@recast/shared';
import { COMPARATOR_VERSION, type Assertion, type Requirement } from '@recast/behaviour-spec';

/** Pure, deterministic comparison. No LLM decides any status here. */

export type Scalar = string | number | boolean | null;

export interface ObservedValue {
  path: string;
  value: Scalar;
  status: 'observed' | 'unavailable';
}

export interface AssertionResult {
  path: string;
  operator: Assertion['operator'];
  expected: Scalar | Scalar[];
  actual: Scalar | undefined;
  outcome: 'pass' | 'fail' | 'unverified';
  reason?: string;
}

/** Exact typed equality: no truthy coercion, missing ≠ null ≠ false, "1" ≠ 1. */
export function scalarEquals(a: Scalar, b: Scalar): boolean {
  return typeof a === typeof b && a === b;
}

export function evaluateAssertion(a: Assertion, observations: ObservedValue[]): AssertionResult {
  const matches = observations.filter((o) => o.path === a.path);
  const base = { path: a.path, operator: a.operator, expected: a.expected };
  if (matches.length === 0) return { ...base, actual: undefined, outcome: 'unverified', reason: 'no observation for path' };
  if (matches.length > 1) return { ...base, actual: undefined, outcome: 'unverified', reason: 'ambiguous: several observations for path' };
  const o = matches[0]!;
  if (o.status !== 'observed') return { ...base, actual: undefined, outcome: 'unverified', reason: 'observation unavailable' };
  let pass: boolean;
  switch (a.operator) {
    case 'equals': pass = scalarEquals(o.value, a.expected); break;
    case 'not_equals': pass = !scalarEquals(o.value, a.expected); break;
    case 'in': pass = a.expected.some((e) => scalarEquals(o.value, e)); break;
  }
  return { ...base, actual: o.value, outcome: pass ? 'pass' : 'fail' };
}

export interface RunEvaluation {
  runId: string;
  /** Execution completed (Kane finished, fixture valid). Infra errors/cancellations are excluded upstream. */
  executionValid: boolean;
  assertions: AssertionResult[];
  verdict: 'satisfied' | 'not_satisfied' | 'unverified';
}

export function evaluateRun(runId: string, req: Requirement, observations: ObservedValue[], executionValid: boolean): RunEvaluation {
  const assertions = req.assertions.map((a) => evaluateAssertion(a, observations));
  let verdict: RunEvaluation['verdict'];
  if (!executionValid || assertions.some((r) => r.outcome === 'unverified')) verdict = 'unverified';
  else verdict = assertions.every((r) => r.outcome === 'pass') ? 'satisfied' : 'not_satisfied';
  return { runId, executionValid, assertions, verdict };
}

export interface ParityDecision {
  status: ParityStatus;
  reasonCode:
    | 'ALL_ASSERTIONS_PASS'
    | 'REPRODUCIBLE_MISMATCH'
    | 'INTENDED_CHANGE_SATISFIED'
    | 'NOT_ENOUGH_TARGET_RUNS'
    | 'CONTRADICTORY_TARGET_RUNS'
    | 'UNVERIFIED_OBSERVATIONS'
    | 'NO_ESTABLISHED_BASELINE'
    | 'NO_TARGET_RUNS';
  explanation: string;
  comparatorVersion: string;
  sourceRuns: string[];
  targetRuns: string[];
}

export interface ClassifyInput {
  requirement: Requirement;
  /** Baseline is established/frozen for this revision. */
  baselineEstablished: boolean;
  sourceRuns: RunEvaluation[];
  targetRuns: RunEvaluation[];
  /** A confirmed gap needs this many consistent failing target runs (rerun before repair). */
  minTargetRunsForGap?: number;
}

/**
 * Classification order: baseline → target runs present → all observations verified →
 * consistency across runs → pass/fail. Kane's own pass/fail or verdict is never an input.
 */
export function classify(input: ClassifyInput): ParityDecision {
  const { requirement: r, sourceRuns, targetRuns } = input;
  const need = input.minTargetRunsForGap ?? 2;
  const base = { comparatorVersion: COMPARATOR_VERSION, sourceRuns: sourceRuns.map((s) => s.runId), targetRuns: targetRuns.map((t) => t.runId) };
  if (!input.baselineEstablished) return { ...base, status: 'untested', reasonCode: 'NO_ESTABLISHED_BASELINE', explanation: `${r.id} r${r.revision} has no established source baseline yet.` };
  if (targetRuns.length === 0) return { ...base, status: 'untested', reasonCode: 'NO_TARGET_RUNS', explanation: `No qualifying target run for ${r.id} r${r.revision}.` };
  const unverified = targetRuns.filter((t) => t.verdict === 'unverified');
  if (unverified.length) return { ...base, status: 'uncertain', reasonCode: 'UNVERIFIED_OBSERVATIONS', explanation: `${unverified.length} of ${targetRuns.length} target runs lack a valid execution or a verified observation.` };
  const satisfied = targetRuns.filter((t) => t.verdict === 'satisfied').length;
  const failed = targetRuns.length - satisfied;
  if (satisfied && failed) return { ...base, status: 'uncertain', reasonCode: 'CONTRADICTORY_TARGET_RUNS', explanation: `Target runs disagree: ${satisfied} satisfied, ${failed} did not.` };
  if (satisfied) {
    return r.provenance === 'intended-change'
      ? { ...base, status: 'intentional_change', reasonCode: 'INTENDED_CHANGE_SATISFIED', explanation: `All ${satisfied} target runs meet the intended expectation (${r.intent_reason}).` }
      : { ...base, status: 'preserved', reasonCode: 'ALL_ASSERTIONS_PASS', explanation: `All assertions passed in ${satisfied} of ${targetRuns.length} target runs.` };
  }
  if (failed < need) return { ...base, status: 'uncertain', reasonCode: 'NOT_ENOUGH_TARGET_RUNS', explanation: `${failed} failing target run; ${need} consistent runs are needed to confirm a gap.` };
  return { ...base, status: 'missing', reasonCode: 'REPRODUCIBLE_MISMATCH', explanation: explainMismatch(targetRuns) };
}

function explainMismatch(runs: RunEvaluation[]): string {
  const first = runs[0]!.assertions.filter((a) => a.outcome === 'fail');
  const parts = first.map((a) => `${a.path} was ${JSON.stringify(a.actual)}, expected ${a.operator === 'in' ? `one of ${JSON.stringify(a.expected)}` : JSON.stringify(a.expected)}`);
  return `In all ${runs.length} target runs ${parts.join('; ')}.`;
}

/** Baseline: N source runs must all satisfy; any disagreement keeps the requirement uncertain. */
export function baselineStatus(runs: RunEvaluation[], minRuns = 2): { established: boolean; matching: number; contradictions: number } {
  const valid = runs.filter((r) => r.verdict !== 'unverified');
  const matching = valid.filter((r) => r.verdict === 'satisfied').length;
  const contradictions = valid.length - matching;
  return { established: contradictions === 0 && matching >= minRuns, matching, contradictions };
}
