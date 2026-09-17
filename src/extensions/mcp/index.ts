/**
 * MCP connectors: every enabled server in ~/.reflex/mcp.json becomes a set of tools
 * named <server>__<tool>. Servers start lazily at session start; /mcp shows status.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadMcpConfig, McpClient, type McpContent } from "./client.js";

export function createMcpExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		const clients = new Map<string, McpClient>();
		const errors = new Map<string, string>();
		const registered = new Set<string>();

		async function connectAll(ctx: ExtensionContext): Promise<void> {
			const cfg = loadMcpConfig();
			for (const [name, server] of Object.entries(cfg.servers)) {
				if (server.enabled === false || clients.has(name)) continue;
				const client = new McpClient(name, server);
				try {
					await client.connect();
					clients.set(name, client);
					errors.delete(name);
					for (const tool of client.tools) registerTool(name, client, tool);
				} catch (err) {
					errors.set(name, err instanceof Error ? err.message : String(err));
					client.close();
				}
			}
			status(ctx);
		}

		function registerTool(server: string, client: McpClient, tool: { name: string; description?: string; inputSchema: Record<string, unknown> }): void {
			const name = `${server}__${tool.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
			if (registered.has(name)) return;
			registered.add(name);
			pi.registerTool({
				name,
				label: `${server}: ${tool.name}`,
				description: `[MCP ${server}] ${tool.description ?? tool.name}`,
				promptSnippet: `${server} connector: ${(tool.description ?? tool.name).split("\n")[0].slice(0, 80)}`,
				parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: "object", properties: {} }),
				async execute(_id, params) {
					const res = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
					const content = res.content.map((c: McpContent) => (c.type === "image" && c.data ? { type: "image" as const, data: c.data, mimeType: c.mimeType ?? "image/png" } : { type: "text" as const, text: c.text ?? (c.type === "resource" ? JSON.stringify(c) : "") }));
					if (res.isError) throw new Error(content.map((c) => ("text" in c ? c.text : "")).join("\n") || `${tool.name} failed`);
					return { content: content.length ? content : [{ type: "text", text: "(no output)" }], details: { server, tool: tool.name } };
				},
				renderCall(args, theme) {
					return new Text(`${theme.fg("toolTitle", theme.bold(`${server} `))}${theme.fg("accent", tool.name)} ${theme.fg("dim", JSON.stringify(args).slice(0, 80))}`, 0, 0);
				},
			});
		}

		function status(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			const n = clients.size;
			const bad = errors.size;
			if (!n && !bad) {
				ctx.ui.setStatus("mcp", undefined);
				return;
			}
			ctx.ui.setStatus("mcp", bad ? ctx.ui.theme.fg("warning", `🔌 ${n} mcp · ${bad} failed`) : ctx.ui.theme.fg("dim", `🔌 ${n} mcp`));
		}

		pi.on("session_start", async (_e, ctx) => {
			await connectAll(ctx);
		});
		pi.on("session_shutdown", async () => {
			for (const c of clients.values()) c.close();
			clients.clear();
		});
		pi.registerCommand("mcp", {
			description: "MCP connectors: status of servers from ~/.reflex/mcp.json (add them in `reflex web` → Settings)",
			handler: async (_args, ctx) => {
				await connectAll(ctx);
				const lines = [ctx.ui.theme.bold("🔌 MCP connectors")];
				for (const [name, c] of clients) lines.push(`${ctx.ui.theme.fg("success", "●")} ${name} ${ctx.ui.theme.fg("dim", `${c.serverInfo.name ?? ""} ${c.serverInfo.version ?? ""} · ${c.tools.length} tools: ${c.tools.map((t) => t.name).join(", ").slice(0, 120)}`)}`);
				for (const [name, err] of errors) lines.push(`${ctx.ui.theme.fg("error", "●")} ${name} ${ctx.ui.theme.fg("dim", err.slice(0, 140))}`);
				if (lines.length === 1) lines.push(ctx.ui.theme.fg("dim", "none configured — add servers in reflex web → Settings → Connectors"));
				ctx.ui.setWidget("mcp", lines);
				setTimeout(() => ctx.ui.setWidget("mcp", undefined), 15000);
			},
		});
	};
}
