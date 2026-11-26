import { z } from 'zod';
import { canonicalJson, contentHash } from '@recast/shared';

/** Bumped whenever comparison semantics change; part of every frozen hash. */
export const COMPARATOR_VERSION = 'cmp-1';

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const AssertionSchema = z.discriminatedUnion('operator', [
  z.object({ path: z.string().min(1), operator: z.literal('equals'), expected: scalar }),
  z.object({ path: z.string().min(1), operator: z.literal('in'), expected: z.array(scalar).min(1) }),
  z.object({ path: z.string().min(1), operator: z.literal('not_equals'), expected: scalar }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export const PROVENANCES = ['candidate', 'source-observed', 'intended-change'] as const;
export const LIFECYCLES = ['candidate', 'source-observed', 'established', 'frozen', 'superseded', 'retired'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

const RequirementObject = z.object({
  id: z.string().regex(/^REQ-[A-Z0-9-]{2,60}$/, 'id must look like REQ-ABC-123'),
  revision: z.number().int().positive(),
  objective: z.string().min(8).max(300),
  role: z.string().min(1),
  fixture: z.string().min(1),
  inputs: z.record(z.string(), scalar).default({}),
  /** What the person wants done, independent of any UI. Compiled into each environment's Kane objective. */
  action_intent: z.string().min(8).max(600),
  /** Which observation adapter produces the asserted values. */
  oracle: z.string().min(1),
  /** Bounded eventual consistency: how long to poll the oracle for a terminal value. */
  settle_ms: z.number().int().min(0).max(120_000).default(10_000),
  assertions: z.array(AssertionSchema).min(1),
  provenance: z.enum(PROVENANCES),
  intent_reason: z.string().optional(),
  scope: z.array(z.string()).default([]),
  source_evidence: z.array(z.string()).default([]),
});

/** The Recast-owned requirement document (not Kane syntax). */
export const RequirementSchema = RequirementObject.superRefine((r, ctx) => {
  if (r.provenance === 'intended-change' && !r.intent_reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intent_reason'], message: 'an intended change needs a reason' });
  }
  const paths = r.assertions.map((a) => a.path);
  const dup = paths.find((p, i) => paths.indexOf(p) !== i);
  if (dup) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assertions'], message: `duplicate assertion path ${dup}` });
});
export type Requirement = z.infer<typeof RequirementSchema>;

export function parseRequirement(input: unknown): Requirement {
  return RequirementSchema.parse(input);
}

/**
 * A capture draft: everything a requirement has except its assertions, which `recast capture` infers
 * from what the legacy app actually did. A draft is never frozen or compared; it only drives probe runs.
 */
export const DraftRequirementSchema = RequirementObject.extend({ assertions: z.array(AssertionSchema).max(0).default([]) });
export type DraftRequirement = z.infer<typeof DraftRequirementSchema>;

export function parseDraft(input: unknown): DraftRequirement {
  return DraftRequirementSchema.parse(input);
}

/** Fields that define behaviour. Evidence lists are provenance and do not change the hash. */
function hashBody(r: Requirement, fixtureIdentity: string) {
  const { source_evidence: _evidence, ...body } = r;
  return { body, fixtureIdentity, comparator: COMPARATOR_VERSION };
}

/** Hash covering canonical spec, fixture identity, assertions, comparator version and intent. */
export function requirementHash(r: Requirement, fixtureIdentity: string): string {
  return contentHash(hashBody(r, fixtureIdentity));
}

export function canonicalRequirement(r: Requirement): string {
  return canonicalJson(r);
}

export interface FrozenRequirement {
  requirement: Requirement;
  hash: string;
  fixtureIdentity: string;
  frozenAt: string;
}

export class FrozenSpecTamperError extends Error {
  override name = 'FrozenSpecTamperError';
}

/** Refuse a frozen requirement whose body no longer matches its recorded hash. */
export function verifyFrozen(f: FrozenRequirement): void {
  const actual = requirementHash(RequirementSchema.parse(f.requirement), f.fixtureIdentity);
  if (actual !== f.hash) {
    throw new FrozenSpecTamperError(`requirement ${f.requirement.id} r${f.requirement.revision} hash mismatch: recorded ${f.hash}, actual ${actual}`);
  }
}

/** Environment-specific navigation, kept separate from the requirement's intent. */
export interface NavigationBinding {
  startUrl: string;
  /** Plain-language hints for this UI, e.g. how login works. Never names the control to use. */
  hints: string[];
}

export interface CompiledObjective {
  objective: string;
  variables: Record<string, string>;
  startUrl: string;
}

/**
 * Compile a requirement into a Kane objective for one environment. Values are passed as
 * Kane variables ({{name}}), so the objective text is identical across environments.
 */
export function compileObjective(r: Requirement | DraftRequirement, nav: NavigationBinding, runInputs: Record<string, string>): CompiledObjective {
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...r.inputs, ...runInputs })) variables[k] = String(v);
  const missing = [...r.action_intent.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).filter((k) => !(k in variables));
  if (missing.length) throw new Error(`objective for ${r.id} needs inputs: ${missing.join(', ')}`);
  const objective = [...nav.hints, r.action_intent].join(' ');
  return { objective, variables, startUrl: nav.startUrl };
}

export function lifecycleAfterBaseline(matchingRuns: number, contradictions: number): Lifecycle {
  if (contradictions > 0) return 'source-observed';
  return matchingRuns >= 2 ? 'established' : 'source-observed';
}
