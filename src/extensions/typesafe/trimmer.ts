/**
 * The hook: trim long tool output on its way to the model, and record what it cost and saved.
 *
 * The decision is logged like every other, so "how many tokens did this save, and how often did the
 * model have to go and read the full file afterwards?" is answerable from the log rather than from
 * optimism. Re-reading the saved file is recorded as the outcome of that trim — the one measurement
 * that says whether the bar is set too high.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logDecision, logOutcome } from "../../logs/decisions.js";
import { buildTrimQuestions, TRIM_KEEP_THRESHOLD } from "./policy.js";
import { clip, snapshotSession } from "./context.js";
import type { ReflexState } from "./state.js";
import { applyTrim, approxTokens, planTrim, saveFullOutput, TRIM_MIN_CHARS } from "./trim.js";

/** Tools whose output is long, repetitive and worth trimming. */
export function trimmable(tool: string): boolean {
	return tool === "bash" || tool === "powershell" || tool === "read" || /__/.test(tool);
}

export function registerTrimmer(pi: ExtensionAPI, state: ReflexState): void {
	/** Saved outputs this session, so a later read of one can be tied back to the trim. */
	const saved = new Map<string, string>();

	pi.on("tool_result", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || policy.trimToolOutput === false || !state.client) return undefined;
		if (!trimmable(event.toolName)) return undefined;
		const texts = event.content.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string");
		if (texts.length !== 1) return undefined;
		const original = texts[0].text;
		if (original.length < TRIM_MIN_CHARS) return undefined;
		const plan = planTrim(original);
		if (plan.skip || !plan.chunks.length) return undefined;

		// Every chunk pinned means there is nothing to ask about.
		const askable = plan.chunks.filter((c) => !c.pinned);
		if (!askable.length) return undefined;

		const snap = snapshotSession(ctx, { maxToolCalls: 0 });
		const chunkState: Record<string, string> = {};
		for (const c of askable) chunkState[`chunk_${c.index}`] = clip(c.text, 4000);
		try {
			const res = await state.client.systemOne({
				purpose: "trim",
				state: { task: snap.userRequest || "(no request text)", command: clip(JSON.stringify(event.input ?? {}), 300), ...chunkState },
				questions: buildTrimQuestions(askable.map((c) => c.index)),
				timeoutMs: policy.timeoutMs,
			});
			const answers = res.answers as Record<string, { noul: number } | undefined>;
			const path = saveFullOutput(event.toolName, original);
			const trimmed = applyTrim(original, plan, (c) => (answers[`chunk_${c.index}`]?.noul ?? 1) >= TRIM_KEEP_THRESHOLD, path);
			if (!trimmed.droppedLines) return undefined;

			const savedTokens = approxTokens(original) - approxTokens(trimmed.text);
			state.trimmedTokens = (state.trimmedTokens ?? 0) + savedTokens;
			state.record("trim", `${event.toolName}: ${trimmed.droppedLines} of ${plan.totalLines} lines dropped · ~${savedTokens} tokens saved`);
			const id = logDecision({
				source: "trim",
				model: res.model,
				action: `drop:${trimmed.droppedChunks}`,
				summary: `${event.toolName} · ${plan.totalLines} lines → ${trimmed.droppedLines} dropped`,
				signals: Object.fromEntries(askable.map((c) => [`chunk_${c.index}`, { primitive: "noul" as const, value: answers[`chunk_${c.index}`]?.noul ?? 1, threshold: TRIM_KEEP_THRESHOLD }])),
				detail: { tool: event.toolName, savedTokens, keptChunks: trimmed.keptChunks, pinned: plan.chunks.length - askable.length, path },
			});
			if (path) saved.set(path, id);
			return { content: [{ ...texts[0], text: trimmed.text }] };
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	});

	// Going back for the full output is the measurement that matters: it says the bar was too high.
	pi.on("tool_call", async (event) => {
		if (!saved.size) return undefined;
		const text = JSON.stringify(event.input ?? {});
		for (const [path, id] of saved) {
			if (text.includes(path)) {
				logOutcome(id, "full-output-re-read");
				saved.delete(path);
			}
		}
		return undefined;
	});
}
