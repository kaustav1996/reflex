/**
 * Triaging a failed command before the model spends a turn on it.
 *
 * When `npm test` exits non-zero, the model reads the output, forms a theory and tries something —
 * a full turn, often to conclude "the package isn't installed". Jev can categorise the failure in
 * one request, and for the few categories where code knows what to do, say so in the result the
 * model is about to read.
 *
 * What this never does:
 *   - run anything. A missing dependency produces a *suggested* command, which still goes through
 *     the gate when the model runs it. Installing software because a command failed is exactly the
 *     kind of helpfulness nobody asked for.
 *   - hide the output. The note is added above it; the model still sees everything.
 *   - speak when it isn't sure, or when the failure is an ordinary bug — which is most of them.
 *
 * Repeats are the other half. The same failure three times means the current approach is not
 * working, and that is worth saying once, plainly, rather than letting a loop burn turns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logDecision } from "../../logs/decisions.js";
import { clip, snapshotSession } from "./context.js";
import { buildTriageQuestions, TRIAGE_MAX_REPEATS, TRIAGE_MIN_CONFIDENCE, TRIAGE_REPEAT } from "./policy.js";
import type { ReflexState } from "./state.js";

/** Output short enough to say nothing, or a tool whose failures aren't commands. */
const MIN_OUTPUT = 40;

export function isFailedCommand(toolName: string, isError: boolean, text: string): boolean {
	return isError && (toolName === "bash" || toolName === "powershell") && text.trim().length >= MIN_OUTPUT;
}

/** The install a missing dependency needs, when the output names it plainly enough to quote. */
export function suggestInstall(output: string): string | undefined {
	const node = output.match(/Cannot find module ['"]([^'"]+)['"]/i) ?? output.match(/Cannot find package ['"]([^'"]+)['"]/i);
	if (node) return `npm install ${node[1].startsWith(".") ? "" : node[1]}`.trim();
	const py = output.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/i);
	if (py) return `pip install ${py[1]}`;
	const shell = output.match(/(?:command not found|is not recognized)[:,]?\s*([\w.-]+)/i) ?? output.match(/([\w.-]+): command not found/i);
	if (shell) return `install ${shell[1]} (for example with your package manager)`;
	return undefined;
}

export function noteFor(kind: string, output: string, repeats: number): string | undefined {
	if (repeats >= TRIAGE_MAX_REPEATS) {
		return `⚡ Reflex: this is the ${repeats}th time the same failure has come back. The current approach isn't working — stop, say what you have established and what you would try next, and ask the user rather than trying another variation.`;
	}
	switch (kind) {
		case "missing_dependency": {
			const install = suggestInstall(output);
			return `⚡ Reflex: this looks like something that isn't installed, not a bug in the code.${install ? ` Installing it would be \`${install}\` — propose that to the user rather than reading further into the output.` : " Work out what is missing and propose installing it, rather than reading further into the output."} Don't install anything without asking.`;
		}
		case "transient":
			return "⚡ Reflex: this looks transient (a timeout, a rate limit, a lock, or a flaky test) rather than a fault in the code. One retry is reasonable; if it fails the same way again, treat it as real.";
		case "environment":
			return "⚡ Reflex: this looks like configuration or credentials rather than code — a missing variable, an expired token, a wrong path, or a service that isn't running. Check that before changing any code.";
		default:
			return undefined;
	}
}

export function registerTriage(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("tool_result", async (event, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || policy.triageFailures === false || !state.client) return undefined;
		const texts = event.content.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string");
		const output = texts.map((c) => c.text).join("\n");
		if (!isFailedCommand(event.toolName, event.isError, output)) return undefined;

		const command = String((event.input as { command?: unknown } | undefined)?.command ?? "");
		try {
			const res = await state.client.systemOne({
				purpose: "triage",
				state: {
					command: clip(command, 300),
					output: clip(output, 4000),
					earlier_failures: state.recentFailures.length ? state.recentFailures : "(none yet in this session)",
				},
				questions: buildTriageQuestions(),
				timeoutMs: policy.timeoutMs,
			});
			const { kind, repeat } = res.answers;
			const sameAgain = repeat.noul >= TRIAGE_REPEAT;
			state.repeatedFailures = sameAgain ? state.repeatedFailures + 1 : 1;
			state.recentFailures = [...state.recentFailures, clip(`${command}: ${output.split("\n").find((l) => l.trim()) ?? ""}`, 200)].slice(-4);

			const confident = kind.confidence >= TRIAGE_MIN_CONFIDENCE;
			const note = confident || state.repeatedFailures >= TRIAGE_MAX_REPEATS ? noteFor(kind.choice, output, state.repeatedFailures) : undefined;
			state.record("triage", `${kind.choice} ${Math.round(kind.confidence * 100)}%${sameAgain ? ` · same failure ×${state.repeatedFailures}` : ""}${note ? "" : " · said nothing"}`);
			logDecision({
				source: "triage",
				model: res.model,
				action: note ? (state.repeatedFailures >= TRIAGE_MAX_REPEATS ? "stop:repeat" : `hint:${kind.choice}`) : "quiet",
				band: kind.confidence >= 0.8 ? "confident" : kind.confidence >= 0.5 ? "likely" : "unsure",
				summary: clip(command, 120),
				signals: {
					kind: { primitive: "choice", value: kind.probabilities[kind.choice] ?? kind.confidence, pick: kind.choice, confidence: kind.confidence, probabilities: kind.probabilities, threshold: TRIAGE_MIN_CONFIDENCE },
					repeat: { primitive: "noul", value: repeat.noul, threshold: TRIAGE_REPEAT },
				},
				detail: { repeats: state.repeatedFailures },
			});
			if (!note) return undefined;
			if (ctx.hasUI && state.repeatedFailures >= TRIAGE_MAX_REPEATS) ctx.ui.notify(`⚡ Reflex: the same failure ${state.repeatedFailures} times — the agent has been told to stop and ask.`, "warning");
			const [first, ...rest] = event.content;
			return { content: [first.type === "text" ? { ...first, text: `${note}\n\n${first.text}` } : first, ...rest] };
		} catch (err) {
			state.degradedReason = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	});

	// A new request is a new problem: the failure history belongs to the task that produced it.
	pi.on("input", () => {
		state.recentFailures = [];
		state.repeatedFailures = 0;
	});
}
