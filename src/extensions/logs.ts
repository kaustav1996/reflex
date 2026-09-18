/**
 * LLM call logging: every assistant message Pi finalizes is one model call. Records model,
 * tokens, cost, stop reason, duration, tool calls and a clipped preview into the call log.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logCall } from "../logs/calls.js";

type Assistant = {
	role: "assistant";
	provider?: string;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; totalTokens?: number; cost?: { total?: number; input?: number; output?: number } };
	content?: Array<{ type: string; text?: string; name?: string; arguments?: unknown; thinking?: string }>;
};

export function createLogsExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		let startedAt: number | undefined;
		pi.on("message_start", async (ev) => {
			if ((ev as { message?: { role?: string } }).message?.role === "assistant") startedAt = Date.now();
		});
		pi.on("message_end", async (ev) => {
			const m = (ev as { message?: Assistant }).message;
			if (!m || m.role !== "assistant") return;
			const ms = startedAt ? Date.now() - startedAt : undefined;
			startedAt = undefined;
			const text = (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
			const tools = (m.content ?? []).filter((c) => c.type === "toolCall").map((c) => ({ name: c.name, arguments: c.arguments }));
			const u = m.usage ?? {};
			const cost = u.cost?.total;
			logCall({
				kind: "llm",
				source: "assistant",
				ok: !m.errorMessage,
				ms,
				summary: `${m.provider ?? "?"}/${m.model ?? "?"} · in ${u.input ?? 0}${u.cacheRead ? ` (+${u.cacheRead} cached)` : ""} out ${u.output ?? 0}${cost !== undefined ? ` · $${cost.toFixed(5)}` : ""} · ${m.stopReason ?? ""}${tools.length ? ` · ${tools.length} tool call${tools.length > 1 ? "s" : ""}` : ""}${m.errorMessage ? ` · error: ${m.errorMessage.slice(0, 120)}` : ""}`,
				detail: { provider: m.provider, model: m.model, responseModel: m.responseModel, usage: u, stopReason: m.stopReason, error: m.errorMessage, text, toolCalls: tools },
			});
		});
	};
}
