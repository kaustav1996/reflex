/**
 * Graders, cheapest first.
 *
 *   programmatic  an exact match, a label from a fixed set, a schema, a test that passes. Free and
 *                 exact: use it whenever the output space allows, and stop here.
 *   jev-as-judge  the rubric written as checkable claims, one noul each, all in one request. Typed,
 *                 calibrated, no generation, output tokens free. Right for open-ended output whose
 *                 quality can be stated as claims ("cites a file it actually read", "answers the
 *                 question asked"), and for picking the better of two answers.
 *   llm-as-judge  a full model reading a rubric. Only when the verdict needs reasoning or writing
 *                 that a claim cannot express: it costs orders of magnitude more per case.
 *
 * Two rules that are not style preferences:
 *
 *   Never judge a model with itself. A Jev judge may not grade Jev's own decisions — that is the
 *   model marking its own homework, and it will agree with itself. Grade those against human
 *   labels. Likewise, don't use the same LLM as judge and subject.
 *
 *   Claims, not scores out of five. "Is this a 4/5 answer?" invites a number with nothing behind
 *   it. Each claim must be checkable on its own, so a failure says which claim failed.
 */
import type { NoulAnswer, Structured, TypesafeClient } from "../extensions/typesafe/client.js";
import { choice, noul } from "../extensions/typesafe/client.js";

export interface Claim {
	id: string;
	/** A statement about the output that is true or false on its own. */
	claim: string;
	/** Claims that must hold for a pass; others are reported but don't fail the case. */
	required?: boolean;
	/** Above this the claim counts as holding. */
	threshold?: number;
}

export interface ClaimVerdict {
	id: string;
	claim: string;
	probability: number;
	holds: boolean;
	required: boolean;
}

export interface JudgeResult {
	pass: boolean;
	/** Fraction of all claims that hold. */
	score: number;
	verdicts: ClaimVerdict[];
	model?: string;
}

export const DEFAULT_CLAIM_THRESHOLD = 0.6;

/**
 * Grade one output against a rubric of claims — one Jev request for the whole rubric, because
 * questions are answered in parallel against a single state and the state is charged once.
 */
export async function judgeWithJev(client: TypesafeClient, args: { task: Structured; output: Structured; claims: Claim[] }): Promise<JudgeResult> {
	if (!args.claims.length) throw new Error("a rubric needs at least one claim");
	const questions = Object.fromEntries(
		args.claims.map((c) => [c.id, noul({ question: c.claim, inspect: ["output", "task"] })]),
	);
	const res = await client.systemOne({ purpose: "eval:judge", state: { task: args.task, output: args.output }, questions });
	const verdicts = args.claims.map((c) => {
		const a = res.answers[c.id] as NoulAnswer | undefined;
		const p = a?.noul ?? 0;
		return { id: c.id, claim: c.claim, probability: p, holds: p >= (c.threshold ?? DEFAULT_CLAIM_THRESHOLD), required: c.required !== false };
	});
	return {
		pass: verdicts.every((v) => !v.required || v.holds),
		score: verdicts.filter((v) => v.holds).length / verdicts.length,
		verdicts,
		model: res.model,
	};
}

export interface PairwiseResult {
	winner: "a" | "b" | "tie";
	confidence: number;
	/** Which side the judge actually saw first, so a position bias is visible in the log. */
	firstShown: "a" | "b";
	model?: string;
}

/**
 * Pick the better of two answers. The judge is never told which is the baseline, and the order is
 * randomised per call, because a judge shown the baseline first will favour it.
 */
export async function comparePairWithJev(
	client: TypesafeClient,
	args: { task: Structured; a: Structured; b: Structured; criterion: string; shuffle?: () => boolean },
): Promise<PairwiseResult> {
	const aFirst = (args.shuffle ?? (() => Math.random() < 0.5))();
	const res = await client.systemOne({
		purpose: "eval:judge-pair",
		state: { task: args.task, first: aFirst ? args.a : args.b, second: aFirst ? args.b : args.a },
		questions: {
			better: choice({ question: `${args.criterion} Pick the answer that does this better, or tie when neither is clearly better.`, inspect: ["first", "second", "task"] }, {
				first: "The answer shown as `first` is better.",
				second: "The answer shown as `second` is better.",
				tie: "Neither is clearly better: they are equally good, or equally poor.",
			}),
		},
	});
	const pick = res.answers.better;
	const winner = pick.choice === "tie" ? "tie" : pick.choice === "first" ? (aFirst ? "a" : "b") : aFirst ? "b" : "a";
	return { winner, confidence: pick.confidence, firstShown: aFirst ? "a" : "b", model: res.model };
}

/**
 * Run the same judgement twice and say whether the verdict held. The article's grader check: a
 * judge that disagrees with itself on identical input cannot be trusted to rank two systems.
 */
export async function judgeIsStable(client: TypesafeClient, args: { task: Structured; output: Structured; claims: Claim[] }): Promise<{ stable: boolean; drift: number; runs: JudgeResult[] }> {
	const first = await judgeWithJev(client, args);
	const second = await judgeWithJev(client, args);
	const drift = Math.max(...first.verdicts.map((v, i) => Math.abs(v.probability - (second.verdicts[i]?.probability ?? v.probability))));
	return { stable: first.pass === second.pass && first.verdicts.every((v, i) => v.holds === second.verdicts[i]?.holds), drift, runs: [first, second] };
}
