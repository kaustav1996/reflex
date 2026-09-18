/**
 * Reflex layer extension entry: wires the gate, monitor, router and the /reflex command.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ReflexConfig, RiskAppetite } from "../../config.js";
import { noul } from "./client.js";
import { registerGate, updateStatus } from "./gate.js";
import { registerMonitor } from "./monitor.js";
import { registerRouter } from "./router.js";
import { registerSelector } from "./selector.js";
import { ReflexState } from "./state.js";

export function createTypesafeExtension(config: ReflexConfig): (pi: ExtensionAPI) => ReflexState {
	return (pi) => {
		const state = new ReflexState(config);
		pi.registerFlag("reflex", { type: "string", description: "Reflex appetite for this run: cautious | balanced | bold | off (handy for -p / headless runs)" });
		/** CLI flags are only readable once Pi has parsed args, i.e. from event handlers, not the factory. */
		const applyFlag = () => {
			const flag = pi.getFlag("reflex");
			if (typeof flag !== "string" || !flag) return;
			if (flag === "off") state.config.reflex.enabled = false;
			else if (flag === "cautious" || flag === "balanced" || flag === "bold") {
				state.config.reflex.enabled = true;
				state.config.reflex.riskAppetite = flag;
			}
		};
		const ENTRY = "reflex-decision";
		let lastCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
		pi.on("session_start", async (_e, ctx) => {
			lastCtx = ctx;
		});
		state.show = (kind, summary, detail) => {
			if (!state.config.reflex.verbose && kind !== "completion") return;
			pi.appendEntry(ENTRY, { kind, summary, detail, at: Date.now() });
			// Web/RPC clients don't see TUI-only entries: mirror each decision through a status update they render as a line.
			if (lastCtx?.hasUI && lastCtx.mode === "rpc") lastCtx.ui.setStatus("reflex-last", `⚡ ${kind} ${summary}`);
		};
		pi.registerEntryRenderer<{ kind: string; summary: string; detail?: { signals?: Record<string, number>; reasons?: string[] } }>(ENTRY, (entry, options, theme) => {
			const d = entry.data;
			if (!d) return undefined;
			const expanded = (options as { expanded?: boolean }).expanded;
			const icon = d.summary.startsWith("allow") ? theme.fg("success", "✓") : d.summary.startsWith("block") ? theme.fg("error", "✗") : d.summary.startsWith("ask") ? theme.fg("warning", "?") : theme.fg("accent", "·");
			let line = `${theme.fg("accent", "⚡")} ${icon} ${theme.fg("dim", d.kind)} ${theme.fg("muted", d.summary)}`;
			if (expanded && d.detail?.signals) {
				const sig = Object.entries(d.detail.signals).map(([k, v]) => `${k} ${typeof v === "number" ? (k === "risk" ? v.toFixed(2) : `${Math.round(v * 100)}%`) : v}`);
				line += `\n   ${theme.fg("dim", sig.join(" · "))}`;
			}
			return new Text(line, 0, 0);
		});
		registerGate(pi, state);
		registerMonitor(pi, state);
		registerRouter(pi, state);
		registerSelector(pi, state);

		pi.on("session_start", async (_e, ctx) => {
			applyFlag();
			updateStatus(ctx, state);
			// Prime the TLS connection so the first gated tool call doesn't pay ~1s of handshake.
			if (state.client) {
				void state.client
					.systemOne({ purpose: "warmup", state: "warmup", questions: { ok: noul("Is the state the word warmup?") }, timeoutMs: 5000 })
					.then(() => updateStatus(ctx, state))
					.catch((err) => {
						state.degradedReason = err instanceof Error ? err.message : String(err);
						updateStatus(ctx, state);
					});
			}
			if (ctx.hasUI && state.config.reflex.enabled && !state.client) {
				ctx.ui.notify("⚡ Reflex layer is on but no TypeSafe key was found. Run /setup or set TYPESAFE_API_KEY.", "warning");
			}
		});

		pi.registerCommand("reflex", {
			description: "Reflex policy: /reflex [appetite cautious|balanced|bold | gate on|off | monitor on|off | route on|off | verbose on|off | routing fast=<model> default=<model> strong=<model> | stats | last | off | on]",
			getArgumentCompletions: (prefix) => {
				const items = ["appetite", "gate", "monitor", "route", "routing", "verbose", "select", "stats", "last", "on", "off"].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => handleCommand(args, ctx, state),
		});

		return state;
	};
}

async function handleCommand(args: string, ctx: ExtensionCommandContext, state: ReflexState): Promise<void> {
	const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const p = state.config.reflex;
	const theme = ctx.ui.theme;
	const say = (msg: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, type);

	switch (sub) {
		case undefined:
		case "": {
			const lines = [
				`${theme.bold("⚡ Reflex")} ${state.enabled ? theme.fg("success", "on") : theme.fg("error", "off")}${state.client ? "" : theme.fg("warning", " (no TypeSafe key)")}`,
				`appetite: ${theme.fg("accent", p.riskAppetite)}   gate: ${onOff(p.gateToolCalls)}   monitor: ${onOff(p.monitorProgress)}   route: ${onOff(p.routeModels)}   verbose: ${onOff(p.verbose)}`,
				`model: ${p.model}   timeout: ${p.timeoutMs}ms   protected: ${p.protectedPaths.length} patterns`,
				`routing: fast=${p.routing.fast ?? "-"}  default=${p.routing.default ?? "-"}  strong=${p.routing.strong ?? "-"}`,
				theme.fg("dim", "usage: /reflex appetite <cautious|balanced|bold> · gate on|off · monitor on|off · route on|off · routing fast=<provider/model> … · stats · last"),
			];
			ctx.ui.setWidget("reflex-info", lines);
			setTimeout(() => ctx.ui.setWidget("reflex-info", undefined), 12000);
			return;
		}
		case "on":
		case "off":
			p.enabled = sub === "on";
			break;
		case "appetite": {
			const v = rest[0] as RiskAppetite | undefined;
			if (!v || !["cautious", "balanced", "bold"].includes(v)) {
				const picked = await ctx.ui.select("Risk appetite", ["cautious", "balanced", "bold"]);
				if (!picked) return;
				p.riskAppetite = picked as RiskAppetite;
			} else p.riskAppetite = v;
			break;
		}
		case "gate":
			p.gateToolCalls = rest[0] !== "off";
			break;
		case "monitor":
			p.monitorProgress = rest[0] !== "off";
			break;
		case "route":
			p.routeModels = rest[0] !== "off";
			break;
		case "verbose":
			p.verbose = rest[0] !== "off";
			break;
		case "select":
			p.selectSkills = rest[0] !== "off";
			break;
		case "routing": {
			for (const kv of rest) {
				const [k, v] = kv.split("=");
				if ((k === "fast" || k === "default" || k === "strong") && v) p.routing[k] = v;
			}
			if (rest.length === 0) say("usage: /reflex routing fast=openrouter/google/gemini-3.1-flash-lite-preview default=openrouter/anthropic/claude-sonnet-4.6 strong=openrouter/anthropic/claude-opus-4.7", "info");
			break;
		}
		case "stats": {
			const s = state.client?.stats;
			const g = state.gate;
			const m = state.monitor;
			const r = state.router;
			const avg = state.avgLatency();
			const lines = [
				theme.bold("⚡ Reflex session stats"),
				`gate: ${g.allowed} auto-allowed · ${g.skipped} session-allowed · ${g.asked} asked (${g.userAllowed} yes / ${g.userDenied} no) · ${g.blocked} blocked · ${g.degraded} degraded`,
				`monitor: ${m.checks} checks · ${m.loopNudges} loop nudges · ${m.errorNudges} error nudges · ${m.verifyNudges} verify nudges · ${m.driftWarnings} drift warnings`,
				`router: ${r.decisions} decisions · ${r.switches} switches · ${Object.entries(r.byTier).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
				s ? `jev: ${s.requests} requests (${s.failures} failed) · ${s.inputTokens} in / ${s.outputTokens} out tokens · ~$${((s.inputTokens / 1e6) * 0.042).toFixed(5)} · avg ${avg ? Math.round(avg) : "-"}ms · ${s.lastModel ?? ""}` : "jev: no client",
				state.degradedReason ? theme.fg("warning", `last error: ${state.degradedReason}`) : "",
			].filter(Boolean);
			ctx.ui.setWidget("reflex-info", lines);
			setTimeout(() => ctx.ui.setWidget("reflex-info", undefined), 15000);
			return;
		}
		case "last": {
			const lines = state.log.slice(-8).map((l) => `${theme.fg("dim", new Date(l.at).toLocaleTimeString())} ${theme.fg("accent", l.kind)} ${l.summary}`);
			ctx.ui.setWidget("reflex-info", lines.length ? [theme.bold("⚡ recent Jev decisions"), ...lines] : ["no decisions yet"]);
			setTimeout(() => ctx.ui.setWidget("reflex-info", undefined), 15000);
			return;
		}
		default:
			say(`unknown /reflex subcommand: ${sub}`, "warning");
			return;
	}
	state.save();
	updateStatus(ctx, state);
	say(`⚡ Reflex: ${sub} ${rest.join(" ")} saved (appetite ${p.riskAppetite}, gate ${onOff(p.gateToolCalls)}, monitor ${onOff(p.monitorProgress)}, route ${onOff(p.routeModels)})`);
}

const onOff = (b: boolean) => (b ? "on" : "off");
