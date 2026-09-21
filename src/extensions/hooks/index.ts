/**
 * Session hooks: turn Pi's session events into the hook events of src/hooks/store.ts, match the
 * configured hooks, optionally ask Jev whether to fire, and run the action. Every firing is shown
 * in the session and written to the call log.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { executeHook } from "../../hooks/run.js";
import { type HookDef, type HookEvent, type HookPayload, type LoadedHook, loadHooks, matches, trustProjectFile } from "../../hooks/store.js";
import { logCall } from "../../logs/calls.js";
import type { ReflexState } from "../typesafe/state.js";

const ENTRY = "reflex-hook";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

export function createHooksExtension(getReflex: () => ReflexState | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		// Hooks started by a hook-triggered agent run must not start more runs: no loops.
		const nested = !!process.env.REFLEX_FROM_HOOK;
		let hooks: LoadedHook[] = [];
		let lastAssistant = "";
		let lastCtx: ExtensionContext | undefined;

		const show = (line: string, ok: boolean) => {
			pi.appendEntry(ENTRY, { line, ok, at: Date.now() });
			if (lastCtx?.hasUI && lastCtx.mode === "rpc") lastCtx.ui.setStatus("hook-last", `${ok ? "✓" : "✗"} ${line}`);
		};

		pi.registerEntryRenderer<{ line: string; ok: boolean }>(ENTRY, (entry, _o, theme) => {
			const d = entry.data;
			if (!d) return undefined;
			return new Text(`${theme.fg("accent", "↪")} ${d.ok ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${theme.fg("dim", "hook")} ${theme.fg("muted", d.line)}`, 0, 0);
		});

		const reload = async (ctx: ExtensionContext) => {
			const loaded = loadHooks(ctx.cwd);
			hooks = loaded.hooks;
			if (loaded.untrusted && ctx.hasUI && !nested) {
				const list = loaded.untrusted.hooks.map((h) => `• ${h.id}: on ${h.event} → ${"agent" in h.run ? `run agent ${h.run.agent}` : `run \`${h.run.command.slice(0, 80)}\``}`).join("\n");
				const pick = await ctx.ui.select(`This project defines ${loaded.untrusted.hooks.length} hook(s) in .reflex/hooks.json. They run commands or agents on your machine.\n\n${list}`, ["Allow these hooks for this project", "Not now (keep them off)"]);
				if (pick?.startsWith("Allow")) {
					trustProjectFile(loaded.untrusted.file);
					hooks = loadHooks(ctx.cwd).hooks;
					show(`project hooks approved (${loaded.untrusted.hooks.length})`, true);
				}
			}
		};

		/** Returns a block reason when a before_tool command asked to stop the call. */
		const fire = async (event: HookEvent, ctx: ExtensionContext, extra: Partial<HookPayload>): Promise<string | undefined> => {
			if (nested || hooks.length === 0) return undefined;
			lastCtx = ctx;
			const payload: HookPayload = { event, cwd: ctx.cwd, session: ctx.sessionManager.getSessionFile?.() ?? undefined, lastAssistant, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, ...extra };
			let blockReason: string | undefined;
			for (const hook of hooks.filter((h) => matches(h, payload))) {
				if (hook.if && !(await jevSaysYes(hook, payload, getReflex()))) continue;
				const out = await executeHook(hook, payload);
				const what = "agent" in hook.run ? `agent ${hook.run.agent}` : "command";
				const line = `${hook.id} · ${event}${payload.tool ? ` ${payload.tool}` : ""} → ${what} · ${out.detail}${out.block ? " · BLOCKED the tool call" : ""}`;
				show(line, out.ok);
				logCall({ kind: "hook", source: hook.id, ok: out.ok, ms: out.ms, summary: line, detail: { hook, payload: { ...payload, result: payload.result?.slice(0, 1500) }, outcome: out } });
				if (out.block) blockReason = `Hook "${hook.id}" blocked this ${payload.tool} call: ${out.detail}`;
			}
			return blockReason;
		};

		pi.on("session_start", async (ev, ctx) => {
			lastCtx = ctx;
			await reload(ctx);
			await fire("session_start", ctx, { reason: ev.reason });
		});
		pi.on("session_shutdown", async (ev, ctx) => {
			await fire("session_end", ctx, { reason: ev.reason });
		});
		pi.on("before_agent_start", async (ev, ctx) => {
			await reload(ctx); // pick up edits to hooks.json without restarting the session
			await fire("prompt", ctx, { prompt: ev.prompt });
			return undefined;
		});
		pi.on("tool_call", async (ev, ctx) => {
			const input = (ev.input ?? {}) as Record<string, unknown>;
			const reason = await fire("before_tool", ctx, { tool: ev.toolName, toolInput: input, command: typeof input.command === "string" ? input.command : undefined, path: typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined });
			return reason ? { block: true, reason } : undefined;
		});
		pi.on("tool_result", async (ev, ctx) => {
			const input = (ev.input ?? {}) as Record<string, unknown>;
			await fire("after_tool", ctx, { tool: ev.toolName, toolInput: input, command: typeof input.command === "string" ? input.command : undefined, path: typeof input.path === "string" ? input.path : undefined, result: textOf(ev.content), isError: ev.isError });
			return undefined;
		});
		pi.on("turn_end", async (ev, ctx) => {
			const m = ev.message as { role?: string; content?: unknown };
			if (m?.role === "assistant") lastAssistant = textOf(m.content) || lastAssistant;
			await fire("turn_end", ctx, {});
		});
		pi.on("agent_end", async (_ev, ctx) => {
			await fire("agent_end", ctx, {});
		});
		pi.on("model_select", async (_ev, ctx) => {
			await fire("model_change", ctx, {});
		});
		pi.on("session_compact", async (_ev, ctx) => {
			await fire("compact", ctx, {});
		});

		pi.registerCommand("hooks", {
			description: "List the session hooks that are active here (global + approved project hooks)",
			handler: async (_args, ctx) => {
				await reload(ctx);
				const lines = hooks.length ? hooks.map((h) => `${h.enabled === false ? "○" : "●"} ${h.id} [${h.source}] on ${h.event}${h.match ? ` match ${JSON.stringify(h.match)}` : ""}${h.if ? ` if "${h.if.question}" ≥ ${h.if.min ?? 0.6}` : ""} → ${"agent" in h.run ? `agent ${h.run.agent}` : h.run.command.slice(0, 60)}`) : ["no hooks. Add them in reflex web → Settings → Hooks, or in ~/.reflex/hooks.json"];
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});
	};
}

/** `if`: one Jev yes/no question over the payload decides whether the hook fires. */
async function jevSaysYes(hook: HookDef, payload: HookPayload, reflex: ReflexState | undefined): Promise<boolean> {
	if (!reflex?.client) return false; // no Jev, no judgment: do not fire on a guess
	try {
		const res = await reflex.client.systemOne({
			purpose: `hook:${hook.id}`,
			state: { event: payload.event, tool: payload.tool, command: payload.command, path: payload.path, prompt: payload.prompt?.slice(0, 2000), tool_result: payload.result?.slice(0, 2000), is_error: payload.isError, last_assistant_reply: payload.lastAssistant?.slice(0, 2000) },
			questions: { fire: { type: "noul", instructions: hook.if!.question } },
		});
		const p = (res.answers.fire as { noul: number }).noul;
		reflex.record("hook", `${hook.id}: "${hook.if!.question.slice(0, 60)}" ${Math.round(p * 100)}% ${p >= (hook.if!.min ?? 0.6) ? "→ fire" : "→ skip"}`);
		return p >= (hook.if!.min ?? 0.6);
	} catch {
		return false;
	}
}
