/**
 * Reflex policy: the pure, testable core of the reflex layer.
 *
 * Code stays in control (deterministic rules, thresholds, escapes). Jev only answers
 * narrow yes/no and rubric questions about an action; this module turns those
 * calibrated numbers into allow / ask / block decisions according to the user's
 * risk appetite. Nothing here talks to the network.
 */
import type { RiskAppetite } from "../../config.js";
import { type ChoiceQuestion, choice, type NoulQuestion, noul, type ScoreQuestion, score } from "./client.js";

export type GateDecision = "allow" | "ask" | "block";

export interface GateSignals {
	/** P(irreversible data loss / destruction). */
	destructive: number;
	/** P(touches files/resources outside the working directory or system config). */
	outsideWorkspace: number;
	/** P(reads/prints/transmits secrets or credentials). */
	secrets: number;
	/** P(changes state on an external service: push, deploy, send, pay, post). */
	externalSideEffect: number;
	/** P(needs elevated privileges / changes system settings / installs globally). */
	privilege: number;
	/** P(the action is a reasonable step toward the user's latest request). */
	intentMatch: number;
	/** 0–3 risk rubric position (fractional). */
	risk: number;
	riskConfidence: number;
}

export interface GateVerdict {
	decision: GateDecision;
	/** Short human-readable reasons (highest signal first). */
	reasons: string[];
	signals: GateSignals;
	/** Which rule fired (for stats / debugging). */
	rule: string;
}

export const RISK_LEVELS = [
	"Read-only or local and trivially reversible: inspecting files, running tests or linters, git status/diff/log, listing, building in the project.",
	"Modifies files inside the project working directory that are under version control or easily recreated: editing source, creating files, git add/commit, installing project-local dependencies.",
	"Changes state outside the project or that takes effort to undo: writes outside the working directory, installs global software, git push/force-push to a branch, runs migrations, sends non-destructive network requests, changes app or shell config.",
	"Irreversible or dangerous: deletes data that cannot be recovered, rewrites shared git history, exposes or exfiltrates secrets, pays, sends messages or emails, deploys to production, changes system security settings, runs with sudo.",
];

/** The parallel question set sent to Jev for one tool call. */
export function buildGateQuestions(): {
	destructive: NoulQuestion;
	outside_workspace: NoulQuestion;
	secrets: NoulQuestion;
	external_side_effect: NoulQuestion;
	privilege: NoulQuestion;
	intent_match: NoulQuestion;
	risk: ScoreQuestion;
} {
	return {
		destructive: noul(
			{
				question: "Would executing action irreversibly delete, overwrite, or lose data that is not trivially recoverable?",
				inspect: "action",
				consider: ["files and directories", "git history and branches", "databases", "remote resources", "whether a backup, undo, or version control makes it recoverable"],
				ignore: "Changes to files the agent itself just created in this session",
			},
			{
				true: { what: "Data loss that cannot be undone with a normal undo, git checkout, or trash restore", examples: ["rm -rf on a directory with user files", "git push --force to a shared branch", "DROP TABLE", "overwriting a file with unrelated content"] },
				false: { what: "Reversible or non-destructive", examples: ["editing a tracked source file", "deleting a build artifact", "creating a new file"] },
			},
		),
		outside_workspace: noul({
			question: "Does action read or modify files, settings, or resources outside the project working directory (workspace.cwd), such as the home directory, system directories, other projects, or global configuration?",
			inspect: ["action", "workspace.cwd"],
		}),
		secrets: noul({
			question: "Does action read, print, copy, transmit, or write credentials or secrets (API keys, tokens, passwords, private keys, .env files, keychains, cookies)?",
			inspect: "action",
			ignore: "Merely mentioning environment variable names without exposing their values",
		}),
		external_side_effect: noul({
			question: "Does action change state on an external service or reach other people: git push, deploy, publish, send email or messages, make a payment, post, create or delete cloud resources, submit a form?",
			inspect: "action",
			ignore: ["Read-only network requests such as fetching a web page or package metadata", "Installing packages from a registry"],
		}),
		privilege: noul({
			question: "Does action require elevated privileges or change the system: sudo, modifying system or security settings, installing or removing global software, changing permissions broadly, editing shell startup files?",
			inspect: "action",
		}),
		intent_match: noul(
			{
				question: "Is action a reasonable, expected step toward what the user asked for in user_request, given recent_context?",
				inspect: ["action", "user_request", "recent_context"],
			},
			{
				true: "The action clearly serves the request, or is a normal preparatory step (reading, building, testing, small edits) for it",
				false: "The action is unrelated to the request, goes well beyond its scope, or contradicts it",
			},
		),
		risk: score(
			{
				question: "How risky is it to execute action right now without asking the user first?",
				inspect: ["action", "workspace", "user_request"],
			},
			RISK_LEVELS,
		),
	};
}

export interface AppetiteThresholds {
	/** Allow automatically when risk score is below this and confidence is at least minConfidence. */
	maxAutoRisk: number;
	minConfidence: number;
	/** Any of these signals at/above the threshold forces an ask. */
	askIf: { destructive: number; secrets: number; externalSideEffect: number; privilege: number; outsideWorkspace: number };
	/** Below this intent probability, ask even for low-risk actions (the agent may be wandering). */
	minIntent: number;
}

export const THRESHOLDS: Record<RiskAppetite, AppetiteThresholds> = {
	cautious: {
		maxAutoRisk: 0.6,
		minConfidence: 0.75,
		askIf: { destructive: 0.15, secrets: 0.15, externalSideEffect: 0.25, privilege: 0.2, outsideWorkspace: 0.4 },
		minIntent: 0.5,
	},
	balanced: {
		maxAutoRisk: 1.5,
		minConfidence: 0.55,
		askIf: { destructive: 0.35, secrets: 0.35, externalSideEffect: 0.5, privilege: 0.5, outsideWorkspace: 0.7 },
		minIntent: 0.3,
	},
	bold: {
		maxAutoRisk: 2.3,
		minConfidence: 0.4,
		askIf: { destructive: 0.6, secrets: 0.6, externalSideEffect: 0.75, privilege: 0.75, outsideWorkspace: 0.95 },
		minIntent: 0.15,
	},
};

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Turn Jev's numbers into a decision. Deterministic; the same signals always give the same verdict. */
export function decide(signals: GateSignals, appetite: RiskAppetite, opts: { hasUI: boolean; protectedPathHit?: string }): GateVerdict {
	const t = THRESHOLDS[appetite];
	const reasons: string[] = [];
	if (opts.protectedPathHit) reasons.push(`touches protected path ${opts.protectedPathHit}`);
	if (signals.destructive >= t.askIf.destructive) reasons.push(`may be destructive (${pct(signals.destructive)})`);
	if (signals.secrets >= t.askIf.secrets) reasons.push(`may expose secrets (${pct(signals.secrets)})`);
	if (signals.externalSideEffect >= t.askIf.externalSideEffect) reasons.push(`external side effect (${pct(signals.externalSideEffect)})`);
	if (signals.privilege >= t.askIf.privilege) reasons.push(`elevated privileges / system change (${pct(signals.privilege)})`);
	if (signals.outsideWorkspace >= t.askIf.outsideWorkspace) reasons.push(`outside the workspace (${pct(signals.outsideWorkspace)})`);
	if (signals.intentMatch < t.minIntent) reasons.push(`doesn't look like what you asked for (${pct(signals.intentMatch)} match)`);

	const riskLabel = `risk ${signals.risk.toFixed(1)}/3 @ ${pct(signals.riskConfidence)} confidence`;

	// Hard stop in headless mode for clearly dangerous, off-intent actions: nobody can answer a prompt.
	const clearlyDangerous = signals.destructive >= 0.85 || signals.secrets >= 0.85;
	if (clearlyDangerous && signals.intentMatch < 0.25) {
		return { decision: "block", reasons: [...reasons, riskLabel], signals, rule: "dangerous-and-off-intent" };
	}

	if (opts.protectedPathHit) {
		return { decision: opts.hasUI ? "ask" : "block", reasons: [...reasons, riskLabel], signals, rule: "protected-path" };
	}

	if (reasons.length > 0) {
		return { decision: opts.hasUI ? "ask" : "block", reasons: [...reasons, riskLabel], signals, rule: "signal-threshold" };
	}

	if (signals.risk <= t.maxAutoRisk && signals.riskConfidence >= t.minConfidence) {
		return { decision: "allow", reasons: [riskLabel], signals, rule: "auto-allow" };
	}

	if (signals.risk <= t.maxAutoRisk) {
		// Low risk but Jev is unsure of its own answer. With a UI we ask (cheap); headless there is
		// nobody to ask and no signal fired, so blocking would only stall the run: allow and log it.
		if (appetite === "bold" || !opts.hasUI) return { decision: "allow", reasons: [riskLabel, opts.hasUI ? "low confidence, bold mode" : "low confidence, headless"], signals, rule: "low-confidence-allow" };
		return { decision: "ask", reasons: [`unsure: ${riskLabel}`], signals, rule: "low-confidence" };
	}

	return { decision: opts.hasUI ? "ask" : "block", reasons: [`${riskLabel} exceeds ${appetite} budget (${t.maxAutoRisk})`], signals, rule: "risk-budget" };
}

// ---------------------------------------------------------------------------
// Progress monitor questions (turn_end / agent_end)
// ---------------------------------------------------------------------------

export function buildTurnMonitorQuestions(): { looping: NoulQuestion; error_ignored: NoulQuestion; stuck: NoulQuestion } {
	return {
		looping: noul(
			{
				question: "Is the agent repeating the same or near-identical actions in recent_tool_calls without producing new information or progress?",
				inspect: "recent_tool_calls",
			},
			{
				true: { what: "Two or more recent calls are essentially the same command or edit with the same outcome", examples: ["running the same failing test repeatedly without changing code", "re-reading the same file three times", "retrying an identical command that errors the same way"] },
				false: "Actions differ meaningfully or each repeat follows a change that could alter the outcome",
			},
		),
		error_ignored: noul({
			question: "Does the latest tool result in recent_tool_calls contain an error or failure that the assistant's latest message (assistant_text) does not acknowledge or act on?",
			inspect: ["recent_tool_calls", "assistant_text"],
		}),
		stuck: noul({
			question: "Given the task and the recent history, is the agent making no progress toward the task (thrashing, guessing, or stuck on an environment problem it keeps hitting)?",
			inspect: ["task", "recent_tool_calls", "assistant_text"],
		}),
	};
}

export function buildCompletionQuestions(): { claims_done: NoulQuestion; verified: NoulQuestion; scope_drift: NoulQuestion; needs_user: NoulQuestion } {
	return {
		claims_done: noul({
			question: "Does assistant_text claim that the task is complete, fixed, working, or done?",
			inspect: "assistant_text",
		}),
		verified: noul(
			{
				question: "Is there concrete evidence in recent_tool_calls that the outcome was verified (tests run and passed, build succeeded, command output confirms the behavior, the file was re-read after editing)?",
				inspect: "recent_tool_calls",
			},
			{
				true: "A verification step actually ran after the last change and its output supports the claim",
				false: { what: "No verification ran, or it ran before the last change, or it failed", examples: ["edits were made but no test/build/run followed", "the assistant says 'this should work' without running anything"] },
			},
		),
		scope_drift: noul({
			question: "Did the agent make changes clearly beyond what task asked for (unrelated files, extra features, refactors nobody requested)?",
			inspect: ["task", "recent_tool_calls", "assistant_text"],
		}),
		needs_user: noul({
			question: "Is the assistant asking the user a question or waiting for a decision only the user can make?",
			inspect: "assistant_text",
		}),
	};
}

// ---------------------------------------------------------------------------
// Model routing (before_agent_start)
// ---------------------------------------------------------------------------

export const ROUTE_TIERS = {
	fast: "A small, well-specified change or question: rename, one-line fix, explain a snippet, look something up, run a command, format, add a log line.",
	default: "A typical multi-step coding task: implement a feature in a few files, fix a bug with a known reproduction, write tests, refactor a module.",
	strong: "A hard or ambiguous task: subtle debugging with unclear cause, architecture or design decisions, large cross-cutting refactors, performance work, security-sensitive changes, or anything where being wrong is expensive.",
} as const;

export function buildRoutingQuestion(): ChoiceQuestion {
	return choice(
		{
			question: "Which tier of language model does this user request need to be done well?",
			inspect: ["request", "project_hint"],
			fallback: "Prefer default when unsure",
		},
		ROUTE_TIERS,
	);
}

// ---------------------------------------------------------------------------
// Voice intent
// ---------------------------------------------------------------------------

export const UTTERANCE_KINDS = {
	task: "A request for the agent to do work: write, fix, change, run, explain, find, or open something.",
	control: "A command to the agent's session itself: stop, cancel, undo, retry, switch model, clear, show status, read that back, toggle voice.",
	answer: "A reply to a question the agent just asked (yes, no, the second one, use option B).",
	chatter: "Not meant for the agent: background speech, a false trigger, filler like 'um', or an unintelligible fragment.",
} as const;

export function buildUtteranceQuestions(): { kind: ChoiceQuestion; complete: NoulQuestion } {
	return {
		kind: choice({ question: "What kind of utterance is transcript, given the agent's recent context?", inspect: ["transcript", "recent_context"] }, UTTERANCE_KINDS),
		complete: noul({
			question: "Is transcript a complete thought that can be acted on as-is (not cut off mid-sentence, not missing the object of the request)?",
			inspect: "transcript",
		}),
	};
}
