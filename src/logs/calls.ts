/**
 * Call log: one jsonl line per outbound call Reflex makes on the user's behalf — every
 * TypeSafe Jev request (state, questions, answers), every LLM response (model, tokens, cost),
 * every voice transcription and every browser-agent step. All processes (TUI sessions, web
 * sessions, agent runs, `reflex web` itself) append to ~/.reflex/logs/calls.jsonl.
 *
 * Secrets are masked before anything is written, deterministically: a known secret becomes
 * [SECRET:NAME]; anything that merely looks like a credential (API-key prefixes, bearer tokens,
 * long random strings) becomes [SECRET:#xxxxxx] with a stable hash prefix, so the same value
 * always masks the same way and can still be correlated across lines.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getReflexHome } from "../config.js";

export type CallKind = "typesafe" | "llm" | "voice" | "browser" | "hook";

export interface CallEntry {
	at: number;
	pid: number;
	/** Which process/session produced it (cwd name, or REFLEX_SESSION_LABEL). */
	session: string;
	kind: CallKind;
	/** Where in Reflex the call came from: gate, monitor, route, select, secrets, browse, workflow:<step>, cli, transcribe, assistant … */
	source: string;
	summary: string;
	ok: boolean;
	ms?: number;
	detail?: unknown;
}

const MAX_BYTES = 20 * 1024 * 1024;

export function callLogPath(): string {
	return join(getReflexHome(), "logs", "calls.jsonl");
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const known = new Map<string, string>();
const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH)/i;
let envScanned = false;

/** Register a named secret so it is masked as [SECRET:NAME]. */
export function registerSecret(name: string, value: string): void {
	if (value && value.length >= 6) known.set(name, value);
}

function scanEnv(): void {
	if (envScanned) return;
	envScanned = true;
	for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 8 && SECRET_NAME.test(k)) known.set(k, v);
}

const PATTERNS: RegExp[] = [
	/\b(?:sk|pk|rk|sk_live|sk_test|pk_live|rk_live|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|lin_api|lin_oauth|phx|phc|rnd|ntn|nfp|AIza|ya29|sk-ant|sk-or|sk-proj|gsk|dg|sarvam)[_-][A-Za-z0-9_\-.]{12,}/g,
	/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_\-.=+/]{16,}/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
	/\b[A-Fa-f0-9]{40,}\b/g, // long hex (tokens, sha-like keys)
];

function stableTag(value: string): string {
	return `[SECRET:#${createHash("sha256").update(value).digest("hex").slice(0, 6)}]`;
}

/** Mask known and credential-looking values in any text. Idempotent and deterministic. */
export function maskSecrets(text: string): string {
	if (!text) return text;
	scanEnv();
	let out = text;
	const entries = [...known.entries()].sort((a, b) => b[1].length - a[1].length);
	for (const [name, value] of entries) if (out.includes(value)) out = out.split(value).join(`[SECRET:${name}]`);
	for (const re of PATTERNS) {
		out = out.replace(re, (m) => {
			if (m.startsWith("[SECRET:")) return m;
			const space = m.search(/\s/);
			if (space > 0) return `${m.slice(0, space)} ${stableTag(m.slice(space + 1))}`; // keep the "Bearer" word
			return stableTag(m);
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// Writing and reading
// ---------------------------------------------------------------------------

function sessionLabel(): string {
	return process.env.REFLEX_SESSION_LABEL || basename(process.cwd());
}

function clipDeep(v: unknown, depth = 0): unknown {
	if (typeof v === "string") return v.length > 4000 ? `${v.slice(0, 4000)}…[+${v.length - 4000}]` : v;
	if (Array.isArray(v)) return depth > 6 ? "[…]" : v.slice(0, 200).map((x) => clipDeep(x, depth + 1));
	if (v && typeof v === "object") {
		if (depth > 6) return "{…}";
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 200)) o[k] = clipDeep(x, depth + 1);
		return o;
	}
	return v;
}

export function logCall(entry: { kind: CallKind; source: string; summary: string; ok?: boolean; ms?: number; detail?: unknown }): void {
	if (process.env.REFLEX_NO_CALL_LOG) return;
	try {
		const file = callLogPath();
		mkdirSync(join(file, ".."), { recursive: true });
		try {
			if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl"));
		} catch {}
		const full: CallEntry = { at: Date.now(), pid: process.pid, session: sessionLabel(), kind: entry.kind, source: entry.source, summary: entry.summary, ok: entry.ok ?? true, ms: entry.ms === undefined ? undefined : Math.round(entry.ms), detail: clipDeep(entry.detail) };
		appendFileSync(file, `${maskSecrets(JSON.stringify(full))}\n`);
	} catch {}
}

export function readCalls(opts: { limit?: number; kinds?: CallKind[]; q?: string; since?: number } = {}): CallEntry[] {
	const file = callLogPath();
	const files = [file.replace(/\.jsonl$/, ".1.jsonl"), file].filter((f) => existsSync(f));
	const out: CallEntry[] = [];
	const q = opts.q?.toLowerCase();
	for (const f of files) {
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let e: CallEntry;
			try {
				e = JSON.parse(line) as CallEntry;
			} catch {
				continue;
			}
			if (opts.kinds?.length && !opts.kinds.includes(e.kind)) continue;
			if (opts.since && e.at <= opts.since) continue;
			if (q && !line.toLowerCase().includes(q)) continue;
			out.push(e);
		}
	}
	const limit = opts.limit ?? 300;
	return out.slice(-limit);
}

export function clearCalls(): void {
	const file = callLogPath();
	rmSync(file, { force: true });
	rmSync(file.replace(/\.jsonl$/, ".1.jsonl"), { force: true });
}

export function callLogStats(): { bytes: number; lines: number } {
	const file = callLogPath();
	if (!existsSync(file)) return { bytes: 0, lines: 0 };
	const text = readFileSync(file, "utf8");
	return { bytes: text.length, lines: text.split("\n").filter(Boolean).length };
}
