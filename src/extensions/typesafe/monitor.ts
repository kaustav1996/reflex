/**
 * Progress monitor: after each turn Jev checks for loops, ignored errors and
 * stalls; at the end of a run it checks whether a completion claim was verified.
 * Nudges are injected as steer / follow-up messages (rate-limited), never silently.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { snapshotSession } from "./context.js";
import { buildCompletionQuestions, buildTurnMonitorQuestions } from "./policy.js";
import type { ReflexState } from "./state.js";

const NUDGE_TYPE = "reflex-nudge";

export function registerMonitor(pi: ExtensionAPI, state: ReflexState): void {
	let turnsWithTools = 0;
	let consecutiveLoopSignals = 0;
	let lastNudgeTurn = -10;
	let nudgedVerifyForPrompt = false;
	let pendingCheck: Promise<void> | undefined;

	pi.on("agent_start", () => {
		turnsWithTools = 0;
		consecutiveLoopSignals = 0;
		nudgedVerifyForPrompt = false;
	});

	pi.on("turn_end", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !policy.monitorProgress || !state.client) return;
		if (event.toolResults.length === 0) return;
		turnsWithTools++;
		if (turnsWithTools < 2) return; // nothing to compare against yet
		if (pendingCheck) return; // don't pile up checks
		pendingCheck = (async () => {
			try {
				const snap = snapshotSession(ctx, { maxToolCalls: 8 });
				const res = await state.client!.systemOne({
					state: {
						task: snap.userRequest,
						recent_tool_calls: snap.recentToolCalls,
						assistant_text: snap.assistantText,
						turn_index: event.turnIndex,
					},
					questions: buildTurnMonitorQuestions(),
					signal: ctx.signal,
					timeoutMs: policy.timeoutMs,
				});
				state.monitor.checks++;
				state.degradedReason = undefined;
				const { looping, error_ignored, stuck } = res.answers;
				state.record("monitor", `turn ${event.turnIndex}: loop ${pct(looping.noul)} · error-ignored ${pct(error_ignored.noul)} · stuck ${pct(stuck.noul)}`);

				consecutiveLoopSignals = looping.noul >= 0.7 ? consecutiveLoopSignals + 1 : 0;
				const canNudge = event.turnIndex - lastNudgeTurn >= 3;

				if (consecutiveLoopSignals >= 2 && canNudge) {
					lastNudgeTurn = event.turnIndex;
					state.monitor.loopNudges++;
					nudge(pi, ctx, `Reflex (System One check, ${pct(looping.noul)} looping): you appear to be repeating the same actions without new results. Stop, state what you have learned, and either change approach or ask the user.`);
					return;
				}
				if (error_ignored.noul >= 0.8 && canNudge) {
					lastNudgeTurn = event.turnIndex;
					state.monitor.errorNudges++;
					nudge(pi, ctx, `Reflex (${pct(error_ignored.noul)}): the last tool result contained an error you did not address. Read it and handle it before continuing.`);
					return;
				}
				if (stuck.noul >= 0.85 && turnsWithTools >= 6 && canNudge) {
					lastNudgeTurn = event.turnIndex;
					if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex: agent looks stuck (${pct(stuck.noul)}). Press Esc to interrupt or let it continue.`, "warning");
				}
			} catch (err) {
				if (!ctx.signal?.aborted) state.degradedReason = err instanceof Error ? err.message : String(err);
			} finally {
				pendingCheck = undefined;
			}
		})();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !policy.monitorProgress || !state.client) return;
		if (nudgedVerifyForPrompt) return;
		const snap = snapshotSession(ctx, { maxToolCalls: 10 });
		if (!snap.assistantText || snap.recentToolCalls.length === 0) return;
		const changed = snap.recentToolCalls.some((c) => c.tool === "edit" || c.tool === "write" || c.tool === "bash");
		if (!changed) return;
		try {
			const res = await state.client.systemOne({
				state: { task: snap.userRequest, recent_tool_calls: snap.recentToolCalls, assistant_text: snap.assistantText },
				questions: buildCompletionQuestions(),
				timeoutMs: policy.timeoutMs,
			});
			state.monitor.checks++;
			const { claims_done, verified, scope_drift, needs_user } = res.answers;
			state.record("completion", `done ${pct(claims_done.noul)} · verified ${pct(verified.noul)} · drift ${pct(scope_drift.noul)} · needs-user ${pct(needs_user.noul)}`);
			if (needs_user.noul >= 0.7) return;
			if (claims_done.noul >= 0.7 && verified.noul <= 0.35) {
				nudgedVerifyForPrompt = true;
				state.monitor.verifyNudges++;
				if (policy.riskAppetite === "bold") {
					if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex: completion claimed but nothing verified it (${pct(verified.noul)}).`, "warning");
				} else {
					nudge(pi, ctx, `Reflex (System One check): you reported the task as done, but no verification ran after the last change (verified ${pct(verified.noul)}). Run the relevant tests, build, or command now and report the actual output. If verification is impossible, say so explicitly.`, "followUp");
				}
			}
			if (scope_drift.noul >= 0.75 && ctx.hasUI) {
				state.monitor.driftWarnings++;
				ctx.ui.notify(`⚡ Reflex: changes may go beyond what you asked (${pct(scope_drift.noul)}). Check the diff.`, "info");
			}
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
		}
	});

	pi.registerMessageRenderer(NUDGE_TYPE, (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("");
		return new Text(`${theme.fg("accent", "⚡ ")}${theme.fg("muted", content)}`, 0, 0);
	});
}

function nudge(pi: ExtensionAPI, ctx: ExtensionContext, content: string, deliverAs: "steer" | "followUp" = "steer"): void {
	if (ctx.hasUI) ctx.ui.notify(content.split(":")[0] ?? "Reflex nudge", "warning");
	pi.sendMessage({ customType: NUDGE_TYPE, content, display: true }, { deliverAs, triggerTurn: true });
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
