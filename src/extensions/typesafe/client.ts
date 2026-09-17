/**
 * Minimal TypeSafe System One client (no SDK dependency).
 *
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <TYPESAFE_API_KEY>
 *   { model, state, questions: { id: { type: "noul"|"choice"|"score", instructions, criteria } } }
 *
 * All questions in one request are evaluated in parallel, so adding heads is ~free in latency.
 * Jev is text-only and returns typed answers with calibrated probabilities (no generation).
 */

export const TYPESAFE_BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1";
export const DEFAULT_JEV_MODEL = "jev-latest";

export type Structured = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
	type: "noul";
	instructions: Structured;
	criteria?: { true: Structured; false: Structured };
}
export interface ChoiceQuestion {
	type: "choice";
	instructions: Structured;
	/** Up to 255 options, keyed by option id. Keep options mutually exclusive; add a "none" escape. */
	criteria: Record<string, Structured>;
}
export interface ScoreQuestion {
	type: "score";
	instructions: Structured;
	/** 2–10 ordered level descriptions, low → high. Describe situations, not degrees. */
	criteria: Structured[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
	type: "noul";
	/** P(yes), 0–1. */
	noul: number;
}
export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}
export interface ScoreAnswer {
	type: "score";
	/** Probability-weighted level position, 0 … levels-1 (fractional). */
	score: number;
	probabilities: Record<string, number>;
	legend?: Record<string, string>;
	confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest<Q extends Record<string, Question>> {
	state: Structured;
	questions: Q;
	model?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type AnswerFor<Q extends Question> = Q extends NoulQuestion
	? NoulAnswer
	: Q extends ChoiceQuestion
		? ChoiceAnswer
		: ScoreAnswer;

export interface SystemOneResponse<Q extends Record<string, Question>> {
	model: string;
	answers: { [K in keyof Q]: AnswerFor<Q[K]> };
	usage?: { input_tokens: number; output_tokens: number };
	latencyMs: number;
}

export const noul = (instructions: Structured, criteria?: NoulQuestion["criteria"]): NoulQuestion => ({
	type: "noul",
	instructions,
	...(criteria ? { criteria } : {}),
});
export const choice = (instructions: Structured, criteria: Record<string, Structured>): ChoiceQuestion => ({
	type: "choice",
	instructions,
	criteria,
});
export const score = (instructions: Structured, criteria: Structured[]): ScoreQuestion => ({
	type: "score",
	instructions,
	criteria,
});

export class TypesafeError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly body?: unknown,
	) {
		super(message);
		this.name = "TypesafeError";
	}
}

export interface TypesafeStats {
	requests: number;
	failures: number;
	inputTokens: number;
	outputTokens: number;
	totalLatencyMs: number;
	lastLatencyMs?: number;
	lastModel?: string;
}

export class TypesafeClient {
	readonly stats: TypesafeStats = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0 };

	constructor(
		private readonly apiKey: string,
		private readonly options: { model?: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
	) {}

	get model(): string {
		return this.options.model ?? DEFAULT_JEV_MODEL;
	}

	async systemOne<Q extends Record<string, Question>>(req: SystemOneRequest<Q>): Promise<SystemOneResponse<Q>> {
		const body = { model: req.model ?? this.model, state: req.state, questions: req.questions };
		const timeoutMs = req.timeoutMs ?? this.options.timeoutMs ?? 8000;
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const url = `${this.options.baseUrl ?? TYPESAFE_BASE_URL}/systemone`;
		const started = performance.now();
		this.stats.requests++;

		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new TypesafeError(`TypeSafe request timed out after ${timeoutMs}ms`)), timeoutMs);
			const onAbort = () => controller.abort(req.signal?.reason);
			req.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const res = await fetchImpl(url, {
					method: "POST",
					headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				if ((res.status === 429 || res.status === 503 || res.status === 529) && attempt < 2) {
					await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
					continue;
				}
				if (!res.ok) {
					let detail: unknown;
					try {
						detail = await res.json();
					} catch {
						detail = await res.text().catch(() => undefined);
					}
					const msg = typeof detail === "object" && detail && "error" in detail ? JSON.stringify((detail as { error: unknown }).error) : String(detail ?? "");
					throw new TypesafeError(`TypeSafe HTTP ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ""}`, res.status, detail);
				}
				const json = (await res.json()) as { model: string; answers: SystemOneResponse<Q>["answers"]; usage?: SystemOneResponse<Q>["usage"] };
				const latencyMs = performance.now() - started;
				this.stats.totalLatencyMs += latencyMs;
				this.stats.lastLatencyMs = latencyMs;
				this.stats.lastModel = json.model;
				if (json.usage) {
					this.stats.inputTokens += json.usage.input_tokens ?? 0;
					this.stats.outputTokens += json.usage.output_tokens ?? 0;
				}
				return { ...json, latencyMs };
			} catch (err) {
				lastError = err;
				if (req.signal?.aborted) break;
				if (err instanceof TypesafeError && err.status && err.status < 500 && err.status !== 429) break;
				if (attempt < 2 && !(err instanceof TypesafeError && err.message.includes("timed out"))) {
					await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
					continue;
				}
				break;
			} finally {
				clearTimeout(timer);
				req.signal?.removeEventListener("abort", onAbort);
			}
		}
		this.stats.failures++;
		if (lastError instanceof TypesafeError) throw lastError;
		throw new TypesafeError(lastError instanceof Error ? lastError.message : String(lastError));
	}
}

/** Validate a Choice answer the way jev-ultrafast does: never act on a malformed distribution. */
export function isValidChoice(answer: ChoiceAnswer | undefined, ids: string[]): answer is ChoiceAnswer {
	if (!answer || answer.type !== "choice") return false;
	const probs = answer.probabilities ?? {};
	const numbers = [...Object.values(probs), answer.confidence];
	const sum = Object.values(probs).reduce((a, b) => a + b, 0);
	return (
		ids.includes(answer.choice) &&
		ids.every((id) => id in probs) &&
		numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) &&
		Math.abs(sum - 1) < 0.02 &&
		probs[answer.choice] >= Math.max(...Object.values(probs)) - 1e-6
	);
}

/** Quick key check used by onboarding and `reflex doctor`. Returns an error string or undefined. */
export async function validateTypesafeKey(key: string): Promise<string | undefined> {
	try {
		const client = new TypesafeClient(key, { timeoutMs: 6000 });
		const res = await client.systemOne({
			state: "ping",
			questions: { ok: noul("Is the state the word 'ping'?") },
		});
		if (typeof res.answers.ok?.noul !== "number") return "unexpected response shape";
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
