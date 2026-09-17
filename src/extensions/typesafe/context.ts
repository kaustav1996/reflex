/**
 * Helpers that turn Pi session history into compact, structured state for Jev.
 * Jev is text-only and context-rot prone, so everything is truncated and named.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);

export interface RecentToolCall {
	tool: string;
	args: Record<string, unknown>;
	result?: string;
	isError?: boolean;
}

export interface SessionSnapshot {
	/** Latest user request text (truncated). */
	userRequest: string;
	/** Previous user requests (truncated), most recent last. */
	earlierRequests: string[];
	/** Recent tool calls with brief results, oldest first. */
	recentToolCalls: RecentToolCall[];
	/** Latest assistant text (truncated). */
	assistantText: string;
}

type AnyMessage = {
	role: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
};

function textOf(content: unknown, max: number): string {
	if (typeof content === "string") return clip(content, max);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content as Array<{ type: string; text?: string }>) {
		if (c.type === "text" && c.text) parts.push(c.text);
		else if (c.type === "image") parts.push("[image]");
	}
	return clip(parts.join("\n"), max);
}

export function briefArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args ?? {})) {
		if (typeof v === "string") out[k] = clip(v, k === "command" ? 600 : 240);
		else if (Array.isArray(v)) out[k] = v.slice(0, 4).map((x) => (typeof x === "string" ? clip(x, 160) : typeof x === "object" && x ? briefArgs(tool, x as Record<string, unknown>) : x));
		else if (typeof v === "object" && v) out[k] = briefArgs(tool, v as Record<string, unknown>);
		else out[k] = v;
	}
	return out;
}

export function snapshotSession(ctx: ExtensionContext, opts: { maxToolCalls?: number } = {}): SessionSnapshot {
	const maxToolCalls = opts.maxToolCalls ?? 8;
	const branch = ctx.sessionManager.getBranch();
	const messages: AnyMessage[] = [];
	for (const entry of branch) {
		if (entry.type === "message") messages.push(entry.message as AnyMessage);
	}

	const userTexts: string[] = [];
	let assistantText = "";
	const calls: RecentToolCall[] = [];
	const callIndex = new Map<string, RecentToolCall>();

	for (const m of messages) {
		if (m.role === "user") {
			const t = textOf(m.content, 1200);
			if (t) userTexts.push(t);
		} else if (m.role === "assistant") {
			const t = textOf(m.content, 1500);
			if (t) assistantText = t;
			if (Array.isArray(m.content)) {
				for (const c of m.content as Array<{ type: string; id?: string; name?: string; arguments?: Record<string, unknown> }>) {
					if (c.type === "toolCall" && c.name) {
						const call: RecentToolCall = { tool: c.name, args: briefArgs(c.name, c.arguments ?? {}) };
						calls.push(call);
						if (c.id) callIndex.set(c.id, call);
					}
				}
			}
		} else if (m.role === "toolResult") {
			const call = m.toolCallId ? callIndex.get(m.toolCallId) : undefined;
			if (call) {
				call.result = textOf(m.content, 400);
				call.isError = !!m.isError;
			}
		}
	}

	return {
		userRequest: userTexts[userTexts.length - 1] ?? "",
		earlierRequests: userTexts.slice(-4, -1),
		recentToolCalls: calls.slice(-maxToolCalls),
		assistantText,
	};
}
