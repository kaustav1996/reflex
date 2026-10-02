/**
 * What became of a decision, from things Reflex already sees — no extra questions, no extra calls,
 * and nothing asked of the user.
 *
 *   routing      the user switching the model back by hand is the clearest "wrong tier" there is;
 *                otherwise the turn ending without a nudge is a quiet "that tier was fine".
 *   verification the completion check demanded a check: did the check then pass, fail, or never run?
 *   skill hint   did the model actually read the SKILL.md that was suggested?
 *
 * Each label is written to the decision log against the decision it belongs to, so a threshold can
 * later be replayed against what actually happened (#24) instead of against a hunch. The gate's own
 * outcome — what the user answered when it asked — is recorded where the asking happens.
 *
 * An outcome that never arrives is an outcome too: "not-read" and "not-run" are recorded when the
 * turn ends, or the log would only ever contain the cases that went somewhere.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logOutcome } from "../../logs/decisions.js";
import type { ReflexState } from "./state.js";

/** A read of the suggested skill's own SKILL.md, however the model spells the path. */
export function readsSkill(tool: string, args: Record<string, unknown>, skill: string): boolean {
	if (tool !== "read" && tool !== "skill") return false;
	const text = JSON.stringify(args ?? {}).toLowerCase();
	const name = skill.toLowerCase();
	return text.includes(`/skills/${name}/`) || (text.includes(name) && text.includes("skill.md"));
}

/** A command whose result says whether the verification the agent was told to run passed. */
export function isVerification(tool: string, args: Record<string, unknown>): boolean {
	if (tool !== "bash") return false;
	const cmd = String((args ?? {}).command ?? "").toLowerCase();
	return /\b(test|tests|vitest|jest|pytest|check|lint|typecheck|tsc|build|cargo|go test|make)\b/.test(cmd);
}

export function registerOutcomes(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("input", () => {
		// A new prompt: whatever is still open belongs to the turn that just ended.
		closeOpen(state, "new-prompt");
		state.nudgedThisPrompt = false;
	});

	pi.on("tool_call", async (event) => {
		// A connector the model reaches for is one it may reach for again: never withhold it after this.
		const server = event.toolName.includes("__") ? event.toolName.split("__")[0] : undefined;
		if (server) state.usedServers.add(server);
		const skill = state.pending.skill;
		if (skill && readsSkill(event.toolName, (event.input ?? {}) as Record<string, unknown>, skill.name)) {
			logOutcome(skill.id, "skill-read", skill.name);
			state.pending.skill = undefined;
		}
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const verify = state.pending.verify;
		if (verify && isVerification(event.toolName, (event.input ?? {}) as Record<string, unknown>)) {
			logOutcome(verify, event.isError ? "verification-failed" : "verification-passed");
			state.pending.verify = undefined;
		}
		return undefined;
	});

	pi.on("agent_end", () => {
		if (state.pending.route) {
			logOutcome(state.pending.route, state.nudgedThisPrompt ? "turn-needed-nudge" : "turn-clean");
			state.pending.route = undefined;
		}
		if (state.pending.skill) {
			logOutcome(state.pending.skill.id, "skill-not-read", state.pending.skill.name);
			state.pending.skill = undefined;
		}
		// The nudge was sent as this turn ended; the model can only act on it in the next one.
		if (state.verifyJustAsked) state.verifyJustAsked = false;
		else if (state.pending.verify) {
			logOutcome(state.pending.verify, "verification-not-run");
			state.pending.verify = undefined;
		}
	});
}

function closeOpen(state: ReflexState, label: string): void {
	if (state.pending.route) logOutcome(state.pending.route, label);
	if (state.pending.skill) logOutcome(state.pending.skill.id, "skill-not-read", state.pending.skill.name);
	// A new prompt means the verification the last turn asked for never happened.
	if (state.pending.verify) logOutcome(state.pending.verify, "verification-not-run");
	state.pending.route = undefined;
	state.pending.skill = undefined;
	state.pending.verify = undefined;
	state.verifyJustAsked = false;
}
