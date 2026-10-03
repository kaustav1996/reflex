/**
 * Decision log: what Jev was asked, what it answered, and what the code then did — one line per
 * decision, in ~/.reflex/logs/decisions.jsonl.
 *
 * The call log next door records the request and the raw answers. This records the *decision*: the
 * model version that answered, the hash of the question wording, the probability each threshold was
 * compared against, the band it fell in, and the action taken. That is what makes a threshold
 * reviewable later — "at 0.35 we asked; how often did the user then say yes?" — and it is the
 * evidence every measurement issue (outcomes, replaying thresholds, calibration, the savings
 * report) reads.
 *
 * Outcomes arrive later than the decision (a user answers an ask; a verification fails afterwards),
 * so the file is append-only: an outcome is its own line naming the decision's id, and readers fold
 * the two together. Several Reflex processes append to the same file, so nothing is ever rewritten.
 *
 * A probability belongs to one question on one primitive. Every entry carries the primitive with
 * the number, because a noul and a choice asking "the same" thing do not return comparable values
 * and a threshold must never be carried between them.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getReflexHome } from "../config.js";
import { maskSecrets } from "./calls.js";

/** Where in Reflex the decision was made. */
export type DecisionSource = "gate" | "route" | "select" | "monitor" | "completion" | "screen" | "trim" | "prune" | "triage" | "voice" | "workflow" | "secrets" | "hook" | "share";

/** One answer, with the primitive that produced it: never compare across primitives. */
export interface DecisionSignal {
	primitive: "noul" | "choice" | "score";
	/** noul: P(yes). choice: the winning option's probability. score: the level. */
	value: number;
	/** The option a choice picked, or the level a score landed on. */
	pick?: string;
	/** Choice and score report their own confidence; a noul has none. */
	confidence?: number;
	/** The full distribution, when the primitive has one. */
	probabilities?: Record<string, number>;
	/** The threshold this was compared against, when one applied. */
	threshold?: number;
}

/** How sure the answer was, in words, so a log can be grouped without re-deriving the cut-offs. */
export type ConfidenceBand = "unsure" | "likely" | "confident";

export interface DecisionEntry {
	t: "d";
	id: string;
	at: number;
	pid: number;
	session: string;
	source: DecisionSource;
	/** The Jev version that answered, and the fingerprint of the question wording it answered. */
	model?: string;
	qhash?: string;
	/** What code did: allow, ask, block, switch:strong, hint:skill=deploy, nudge:verify, mark:data … */
	action: string;
	/** The rule or reason that produced the action, when the code names one. */
	rule?: string;
	band?: ConfidenceBand;
	signals: Record<string, DecisionSignal>;
	/** Short, human-readable: what this decision was about. */
	summary: string;
	detail?: unknown;
	ms?: number;
}

export interface OutcomeEntry {
	t: "o";
	id: string;
	at: number;
	/** What happened to the decision afterwards: user-allowed, user-denied, verification-failed, … */
	label: string;
	note?: string;
}

/** A decision with whatever outcome was recorded for it later. */
export type LoggedDecision = DecisionEntry & { outcome?: { at: number; label: string; note?: string } };

const MAX_BYTES = 20 * 1024 * 1024;

export function decisionLogPath(): string {
	return join(getReflexHome(), "logs", "decisions.jsonl");
}

function sessionLabel(): string {
	return process.env.REFLEX_SESSION_LABEL || process.cwd().split("/").filter(Boolean).pop() || "reflex";
}

function append(line: object): void {
	if (process.env.REFLEX_NO_CALL_LOG) return;
	try {
		const file = decisionLogPath();
		mkdirSync(join(file, ".."), { recursive: true });
		try {
			if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
		} catch {}
		appendFileSync(file, `${maskSecrets(JSON.stringify(line))}\n`);
	} catch {}
}

/** Record a decision. Returns its id, which an outcome can name later. */
export function logDecision(entry: Omit<DecisionEntry, "t" | "id" | "at" | "pid" | "session">): string {
	const id = randomUUID().slice(0, 8);
	append({ t: "d", id, at: Date.now(), pid: process.pid, session: sessionLabel(), ...entry });
	return id;
}

/** Record what became of a decision. Safe to call from another process, or much later. */
export function logOutcome(id: string | undefined, label: string, note?: string): void {
	if (!id) return;
	append({ t: "o", id, at: Date.now(), label, note });
}

/** Decisions, oldest first, with their outcomes folded in. */
export function readDecisions(opts: { limit?: number; sources?: DecisionSource[]; since?: number; withOutcome?: boolean } = {}): LoggedDecision[] {
	const file = decisionLogPath();
	const files = [file.replace(/\.jsonl$/, ".1.jsonl"), file].filter((f) => existsSync(f));
	const byId = new Map<string, LoggedDecision>();
	const outcomes = new Map<string, { at: number; label: string; note?: string }>();
	for (const f of files) {
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as DecisionEntry | OutcomeEntry;
				if (e.t === "d") byId.set(e.id, e);
				else if (e.t === "o") outcomes.set(e.id, { at: e.at, label: e.label, note: e.note });
			} catch {}
		}
	}
	let out = [...byId.values()].map((d) => {
		const o = outcomes.get(d.id);
		return o ? { ...d, outcome: o } : d;
	});
	if (opts.sources?.length) out = out.filter((d) => opts.sources!.includes(d.source));
	if (opts.since) out = out.filter((d) => d.at > opts.since!);
	if (opts.withOutcome) out = out.filter((d) => !!d.outcome);
	out.sort((a, b) => a.at - b.at);
	return out.slice(-(opts.limit ?? 300));
}

export function clearDecisions(): void {
	const file = decisionLogPath();
	rmSync(file, { force: true });
	rmSync(file.replace(/\.jsonl$/, ".1.jsonl"), { force: true });
}

export function decisionLogStats(): { bytes: number; decisions: number; outcomes: number } {
	let bytes = 0;
	let decisions = 0;
	let outcomes = 0;
	for (const f of [decisionLogPath().replace(/\.jsonl$/, ".1.jsonl"), decisionLogPath()]) {
		if (!existsSync(f)) continue;
		bytes += statSync(f).size;
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (line.includes('"t":"d"')) decisions++;
			else if (line.includes('"t":"o"')) outcomes++;
		}
	}
	return { bytes, decisions, outcomes };
}
