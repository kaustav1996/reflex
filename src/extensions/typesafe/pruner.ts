/**
 * The hooks for pruning: what each request carries, and what happens when Pi wants to compact.
 *
 *   context                 before every LLM call. Only acts on a large context, judges each old
 *                           tool result once per session, and caches the verdict — a result that is
 *                           stale now does not become fresh later, so this costs one call per batch
 *                           of candidates, not one per turn.
 *   session_before_compact  when Pi is about to replace the transcript with a summary. If pruning
 *                           frees enough, the "summary" handed back is a verbatim reconstruction
 *                           with stale output removed. If it doesn't, Pi summarises as usual.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logDecision } from "../../logs/decisions.js";
import { clip, snapshotSession } from "./context.js";
import { buildPruneQuestions, PRUNE_KEEP_THRESHOLD } from "./policy.js";
import {
	applyPrune,
	contextChars,
	type Message,
	MAX_PRUNE_CANDIDATES,
	PRUNE_MIN_CONTEXT_CHARS,
	reconstruct,
	selectCandidates,
} from "./prune.js";
import type { ReflexState } from "./state.js";

/** Pruning must free at least this share of the transcript to be used instead of a summary. */
export const ENOUGH_FREED = 0.35;

export function registerPruner(pi: ExtensionAPI, state: ReflexState): void {
	/** toolCallId → keep. Judged once; a stale result does not become fresh. */
	const verdicts = new Map<string, boolean>();

	pi.on("context", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || policy.pruneContext === false || !state.client) return undefined;
		const messages = event.messages as unknown as Message[];
		const total = contextChars(messages);
		if (total < PRUNE_MIN_CONTEXT_CHARS) return undefined;

		// Ask about what hasn't been judged yet; apply every verdict known so far.
		const fresh = selectCandidates(messages, { already: new Set(verdicts.keys()), max: MAX_PRUNE_CANDIDATES });
		if (fresh.length) {
			try {
				const snap = snapshotSession(ctx, { maxToolCalls: 0 });
				const fields: Record<string, string> = {};
				for (const c of fresh) fields[c.toolCallId] = `${c.toolName}: ${clip(c.text, 3000)}`;
				const res = await state.client.systemOne({
					purpose: "prune",
					state: { task: snap.userRequest || "(no request text)", recent_work: clip(snap.assistantText ?? "", 600), ...fields },
					questions: buildPruneQuestions(fresh.map((c) => c.toolCallId)),
					timeoutMs: policy.timeoutMs,
				});
				const answers = res.answers as Record<string, { noul: number } | undefined>;
				for (const c of fresh) verdicts.set(c.toolCallId, (answers[c.toolCallId]?.noul ?? 1) >= PRUNE_KEEP_THRESHOLD);
				logDecision({
					source: "prune",
					model: res.model,
					action: `judged:${fresh.length}`,
					summary: `${Math.round(total / 1000)}k characters in context · ${fresh.filter((c) => !verdicts.get(c.toolCallId)).length} of ${fresh.length} results now stale`,
					signals: Object.fromEntries(fresh.map((c) => [c.toolName, { primitive: "noul" as const, value: answers[c.toolCallId]?.noul ?? 1, threshold: PRUNE_KEEP_THRESHOLD }])),
					detail: { contextChars: total },
				});
			} catch (err) {
				state.degradedReason = err instanceof Error ? err.message : String(err);
				return undefined;
			}
		}

		const drop = new Set([...verdicts].filter(([, keep]) => !keep).map(([id]) => id));
		if (!drop.size) return undefined;
		const pruned = applyPrune(messages, drop);
		if (!pruned.dropped) return undefined;
		state.prunedChars = (state.prunedChars ?? 0) + pruned.charsFreed;
		state.record("prune", `${pruned.dropped} stale results left out of this request · ${Math.round(pruned.charsFreed / 1000)}k characters`);
		return { messages: pruned.messages as never };
	});

	// Pi is about to paraphrase the session. A paraphrase loses exact detail; pruning doesn't.
	pi.on("session_before_compact", async (event) => {
		const policy = state.config.reflex;
		if (!policy.enabled || policy.pruneContext === false) return undefined;
		const entries = event.branchEntries as unknown as Array<{ id?: string; message?: Message }>;
		const messages = entries.map((e) => e.message).filter((m): m is Message => !!m);
		if (!messages.length) return undefined;
		const before = contextChars(messages);
		const drop = new Set([...verdicts].filter(([, keep]) => !keep).map(([id]) => id));
		const pruned = applyPrune(messages, drop);
		const text = reconstruct(pruned.messages);
		const freed = 1 - text.length / Math.max(before, 1);
		if (freed < ENOUGH_FREED) {
			state.record("prune", `compaction: pruning would free only ${Math.round(freed * 100)}% — leaving it to the summary`);
			return undefined;
		}
		state.record("prune", `compaction: rebuilt from the transcript, ${Math.round(freed * 100)}% smaller, nothing paraphrased`);
		logDecision({
			source: "prune",
			action: "compact:reconstructed",
			summary: `${Math.round(before / 1000)}k → ${Math.round(text.length / 1000)}k characters without a summary`,
			signals: {},
			detail: { reason: event.reason, freed, droppedResults: pruned.dropped },
		});
		return {
			compaction: {
				summary: text,
				firstKeptEntryId: entries[entries.length - 1]?.id ?? "",
				tokensBefore: Math.ceil(before / 4),
				estimatedTokensAfter: Math.ceil(text.length / 4),
			} as never,
		};
	});
}
