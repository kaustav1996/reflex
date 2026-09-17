/**
 * Action gate: every state-changing tool call is judged by Jev before it runs.
 *
 * Deterministic code stays in control: read-only tools skip the gate, protected
 * paths always ask, session allow-lists short-circuit, and Jev's calibrated
 * signals are mapped to allow / ask / block by the user's risk appetite.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { clip, snapshotSession } from "./context.js";
import { buildGateQuestions, decide, type GateSignals, type GateVerdict } from "./policy.js";
import type { ReflexState } from "./state.js";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "screenshot", "computer_observe"]);

/** Tools that mutate the world and therefore go through Jev. Custom tools opt in via name prefix. */
export function isGatedTool(name: string): boolean {
	if (READ_ONLY_TOOLS.has(name)) return false;
	return name === "bash" || name === "edit" || name === "write" || name.startsWith("computer") || name === "applescript" || name === "browse";
}

export interface ActionDescription {
	tool: string;
	summary: string;
	detail: Record<string, unknown>;
	paths: string[];
}

export function describeAction(toolName: string, input: Record<string, unknown>, cwd: string): ActionDescription {
	const paths: string[] = [];
	const rel = (p: unknown) => {
		if (typeof p !== "string") return p;
		const abs = isAbsolute(p) ? p : resolve(cwd, p);
		paths.push(abs);
		return abs.startsWith(cwd) ? abs.slice(cwd.length + 1) || "." : abs;
	};
	switch (toolName) {
		case "bash": {
			const command = String(input.command ?? "");
			return { tool: "bash", summary: clip(command, 120), detail: { command: clip(command, 1500), timeout: input.timeout }, paths };
		}
		case "edit": {
			const path = rel(input.path);
			const edits = Array.isArray(input.edits) ? (input.edits as Array<{ oldText?: string; newText?: string }>) : [{ oldText: input.oldText as string, newText: input.newText as string }];
			return {
				tool: "edit",
				summary: `edit ${path} (${edits.length} change${edits.length === 1 ? "" : "s"})`,
				detail: { path, edits: edits.slice(0, 5).map((e) => ({ old: clip(String(e.oldText ?? ""), 300), new: clip(String(e.newText ?? ""), 300) })) },
				paths,
			};
		}
		case "write": {
			const path = rel(input.path);
			const content = String(input.content ?? "");
			return { tool: "write", summary: `write ${path} (${content.length} chars)`, detail: { path, bytes: content.length, content_preview: clip(content, 500) }, paths };
		}
		case "browse": {
			const goal = String(input.goal ?? "");
			return { tool: "browse", summary: clip(`browse: ${goal}`, 120), detail: { goal: clip(goal, 800), url: input.url, note: "Autonomous web browsing driven by System One; each step is separately checked for irreversible effects." }, paths };
		}
		default: {
			const brief: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(input)) brief[k] = typeof v === "string" ? clip(v, 400) : v;
			if (typeof input.path === "string") rel(input.path);
			return { tool: toolName, summary: clip(`${toolName} ${JSON.stringify(brief)}`, 120), detail: brief, paths };
		}
	}
}

/** Deterministic protected-path check (code owns this rule; Jev never overrides it). */
export function protectedPathHit(action: ActionDescription, patterns: string[]): string | undefined {
	const home = homedir();
	const expanded = patterns.map((p) => (p.startsWith("~/") ? `${home}/${p.slice(2)}` : p));
	for (const path of action.paths) {
		for (const pat of expanded) {
			if (minimatch(path, pat, { dot: true, matchBase: !pat.includes("/") }) || minimatch(basename(path), pat, { dot: true })) return path;
		}
	}
	if (action.tool === "bash") {
		const cmd = String(action.detail.command ?? "");
		for (const pat of expanded) {
			const needle = pat.replace(/^\*\*\/|^\*\*|\*/g, "").replace(/^\//, "");
			if (needle.length >= 3 && cmd.includes(needle)) return needle;
		}
	}
	return undefined;
}

/** Fallback heuristics when Jev is unreachable: keep the agent moving but never silently run the scary stuff. */
const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\b/i,
	/\bsudo\b/,
	/\bgit\s+push\b.*(--force|-f\b)/,
	/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/,
	/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)\b/i,
	/\bcurl\b[^|]*\|\s*(ba)?sh\b/,
	/\bchmod\s+(-R\s+)?777\b/,
	/\bmkfs\b|\bdd\s+if=/,
	/>\s*\/dev\/sd/,
];

export function sessionKey(action: ActionDescription): string {
	if (action.tool === "bash") return `bash:${String(action.detail.command ?? "").trim().replace(/\s+/g, " ")}`;
	if (action.tool === "edit" || action.tool === "write") return `${action.tool}:${String(action.detail.path ?? "")}`;
	return `${action.tool}:${JSON.stringify(action.detail)}`;
}

async function askUser(ctx: ExtensionContext, action: ActionDescription, verdict: GateVerdict | undefined, note: string | undefined, state: ReflexState): Promise<{ block: boolean; reason?: string; remember?: boolean }> {
	const theme = ctx.ui.theme;
	const lines = [theme.fg("warning", `⚡ Reflex wants a second look: ${action.tool}`), "", theme.fg("accent", action.summary)];
	if (action.tool === "edit" && Array.isArray(action.detail.edits)) {
		for (const e of (action.detail.edits as Array<{ old: string; new: string }>).slice(0, 2)) lines.push(theme.fg("dim", `- ${clip(e.old.replace(/\n/g, "⏎"), 80)}`), theme.fg("dim", `+ ${clip(e.new.replace(/\n/g, "⏎"), 80)}`));
	}
	lines.push("");
	if (verdict) for (const r of verdict.reasons) lines.push(theme.fg("muted", `• ${r}`));
	if (note) lines.push(theme.fg("dim", note));
	const choice = await ctx.ui.select(lines.join("\n"), ["Allow once", "Allow this for the rest of the session", "Deny and tell the agent why", "Deny"]);
	state.gate.asked++;
	if (choice === "Allow once") {
		state.gate.userAllowed++;
		return { block: false };
	}
	if (choice?.startsWith("Allow this")) {
		state.gate.userAllowed++;
		return { block: false, remember: true };
	}
	state.gate.userDenied++;
	if (choice?.startsWith("Deny and")) {
		const why = await ctx.ui.input("Tell the agent why (sent as the tool error):", "e.g. use the staging DB instead");
		return { block: true, reason: `User denied this action${why ? `: ${why}` : ""}` };
	}
	return { block: true, reason: "User denied this action via Reflex." };
}

export function registerGate(pi: ExtensionAPI, state: ReflexState): void {
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const policy = state.config.reflex;
		if (!policy.enabled || !policy.gateToolCalls) return undefined;
		if (!isGatedTool(event.toolName)) return undefined;

		const action = describeAction(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		const key = sessionKey(action);
		if (state.sessionAllow.has(key)) {
			state.gate.skipped++;
			return undefined;
		}

		const protectedHit = protectedPathHit(action, policy.protectedPaths);

		// Jev is unavailable (no key or client disabled): deterministic fallback only.
		if (!state.client) {
			return fallback(ctx, action, protectedHit, state, "reflex has no TypeSafe key");
		}

		const snap = snapshotSession(ctx, { maxToolCalls: 6 });
		const started = performance.now();
		let signals: GateSignals;
		try {
			const res = await state.client.systemOne({
				state: {
					action: { tool: action.tool, ...action.detail },
					workspace: { cwd: ctx.cwd, git_repo: isGitRepo(ctx.cwd), protected_paths: policy.protectedPaths },
					user_request: snap.userRequest || "(no request text)",
					earlier_requests: snap.earlierRequests,
					recent_context: snap.recentToolCalls.map((c) => ({ tool: c.tool, args: c.args, error: c.isError ?? false })),
				},
				questions: buildGateQuestions(),
				signal: ctx.signal,
			});
			const a = res.answers;
			signals = {
				destructive: a.destructive.noul,
				outsideWorkspace: a.outside_workspace.noul,
				secrets: a.secrets.noul,
				externalSideEffect: a.external_side_effect.noul,
				privilege: a.privilege.noul,
				intentMatch: a.intent_match.noul,
				risk: a.risk.score,
				riskConfidence: a.risk.confidence,
			};
			state.degradedReason = undefined;
		} catch (err) {
			if (ctx.signal?.aborted) return undefined;
			state.degradedReason = err instanceof Error ? err.message : String(err);
			state.gate.degraded++;
			return fallback(ctx, action, protectedHit, state, `reflex degraded: ${clip(state.degradedReason, 80)}`);
		}

		const verdict = decide(signals, policy.riskAppetite, { hasUI: ctx.hasUI, protectedPathHit: protectedHit });
		const ms = Math.round(performance.now() - started);
		state.record("gate", `${verdict.decision} ${action.tool}: ${action.summary} [${verdict.rule}, ${ms}ms]`, { signals, reasons: verdict.reasons });
		updateStatus(ctx, state);

		if (verdict.decision === "allow") {
			state.gate.allowed++;
			return undefined;
		}
		if (verdict.decision === "block") {
			state.gate.blocked++;
			if (ctx.hasUI) ctx.ui.notify(`⚡ Reflex blocked ${action.tool}: ${verdict.reasons[0] ?? "risky"}`, "warning");
			return { block: true, reason: `Reflex blocked this action (${verdict.reasons.join("; ")}). Explain what you intended and ask the user before retrying.` };
		}
		// ask
		if (!ctx.hasUI) {
			state.gate.blocked++;
			return { block: true, reason: `Reflex needs user confirmation for this action (${verdict.reasons.join("; ")}) but no UI is available. Choose a safer approach or stop and report.` };
		}
		const answer = await askUser(ctx, action, verdict, undefined, state);
		if (answer.remember) state.sessionAllow.add(key);
		updateStatus(ctx, state);
		return answer.block ? { block: true, reason: answer.reason } : undefined;
	});
}

async function fallback(ctx: ExtensionContext, action: ActionDescription, protectedHit: string | undefined, state: ReflexState, note: string) {
	const cmd = action.tool === "bash" ? String(action.detail.command ?? "") : "";
	const dangerous = DANGEROUS_PATTERNS.some((p) => p.test(cmd));
	updateStatus(ctx, state);
	if (!protectedHit && !dangerous) return undefined;
	if (!ctx.hasUI) {
		state.gate.blocked++;
		return { block: true, reason: `Blocked by Reflex fallback rules (${protectedHit ? `protected path ${protectedHit}` : "dangerous command pattern"}); ${note}.` };
	}
	const answer = await askUser(ctx, action, undefined, `${protectedHit ? `protected path: ${protectedHit}. ` : "matches a dangerous command pattern. "}(${note})`, state);
	if (answer.remember) state.sessionAllow.add(sessionKey(action));
	return answer.block ? { block: true, reason: answer.reason } : undefined;
}

const gitRepoCache = new Map<string, boolean>();
function isGitRepo(cwd: string): boolean {
	const cached = gitRepoCache.get(cwd);
	if (cached !== undefined) return cached;
	let dir = cwd;
	let found = false;
	for (let i = 0; i < 12; i++) {
		if (existsSync(`${dir}/.git`)) {
			found = true;
			break;
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	gitRepoCache.set(cwd, found);
	return found;
}

export function updateStatus(ctx: ExtensionContext, state: ReflexState): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	if (!state.enabled) {
		ctx.ui.setStatus("reflex", theme.fg("dim", "⚡ reflex off"));
		return;
	}
	const g = state.gate;
	const avg = state.avgLatency();
	const parts = [`${g.allowed + g.skipped} auto`, `${g.asked} asked`, `${g.blocked} blocked`];
	if (avg !== undefined) parts.push(`~${Math.round(avg)}ms`);
	const label = state.degradedReason ? theme.fg("warning", "⚡ reflex degraded") : theme.fg("accent", `⚡ reflex ${state.config.reflex.riskAppetite}`);
	ctx.ui.setStatus("reflex", `${label} ${theme.fg("dim", parts.join(" · "))}`);
}
