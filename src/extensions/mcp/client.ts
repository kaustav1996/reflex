/**
 * Minimal Model Context Protocol client: stdio servers (spawned) and streamable-HTTP servers.
 * JSON-RPC 2.0; initialize → tools/list → tools/call. No dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReflexHome } from "../../config.js";

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	/** Optional tool allowlist. */
	tools?: string[];
}
export interface McpConfig {
	servers: Record<string, McpServerConfig>;
}
export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}
export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export function mcpConfigPath(): string {
	return join(getReflexHome(), "mcp.json");
}
export function loadMcpConfig(): McpConfig {
	try {
		if (!existsSync(mcpConfigPath())) return { servers: {} };
		const parsed = JSON.parse(readFileSync(mcpConfigPath(), "utf8")) as Partial<McpConfig> & { mcpServers?: McpConfig["servers"] };
		return { servers: parsed.servers ?? parsed.mcpServers ?? {} };
	} catch {
		return { servers: {} };
	}
}
export function saveMcpConfig(config: McpConfig): void {
	writeFileSync(mcpConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

type Json = Record<string, unknown>;

export class McpClient {
	private proc: ChildProcess | undefined;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
	private buffer = "";
	private sessionId: string | undefined;
	serverInfo: { name?: string; version?: string } = {};
	tools: McpTool[] = [];

	constructor(
		readonly name: string,
		readonly config: McpServerConfig,
	) {}

	async connect(timeoutMs = 20000): Promise<void> {
		if (this.config.command) {
			this.proc = spawn(this.config.command, this.config.args ?? [], { cwd: this.config.cwd, env: { ...process.env, ...(this.config.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
			this.proc.stdout?.setEncoding("utf8");
			this.proc.stdout?.on("data", (chunk: string) => this.onData(chunk));
			this.proc.on("exit", () => {
				for (const p of this.pending.values()) p.reject(new Error(`MCP server ${this.name} exited`));
				this.pending.clear();
			});
			await new Promise<void>((resolve, reject) => {
				this.proc!.once("spawn", () => resolve());
				this.proc!.once("error", (e) => reject(new Error(`cannot start MCP server ${this.name}: ${e.message}`)));
			});
		} else if (!this.config.url) throw new Error(`MCP server ${this.name}: needs command or url`);
		const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reflex", version: "0.1.0" } }, timeoutMs);
		this.serverInfo = (init.serverInfo as { name?: string; version?: string }) ?? {};
		await this.notify("notifications/initialized");
		const list = await this.request("tools/list", {}, timeoutMs);
		this.tools = ((list.tools as McpTool[]) ?? []).filter((t) => !this.config.tools?.length || this.config.tools.includes(t.name));
	}

	async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120000): Promise<{ content: McpContent[]; isError: boolean }> {
		const res = await this.request("tools/call", { name, arguments: args }, timeoutMs);
		return { content: (res.content as McpContent[]) ?? [], isError: !!res.isError };
	}

	close(): void {
		this.proc?.kill();
		this.proc = undefined;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			try {
				this.dispatch(JSON.parse(line) as Json);
			} catch {}
		}
	}

	private dispatch(msg: Json): void {
		if (typeof msg.id === "number" && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`${this.name}: ${(msg.error as { message?: string }).message ?? JSON.stringify(msg.error)}`));
			else p.resolve((msg.result as Json) ?? {});
		}
	}

	private async notify(method: string, params: Json = {}): Promise<void> {
		const body = { jsonrpc: "2.0", method, params };
		if (this.proc) this.proc.stdin?.write(`${JSON.stringify(body)}\n`);
		else await this.httpPost(body).catch(() => undefined);
	}

	private request(method: string, params: Json, timeoutMs: number): Promise<Json> {
		const id = this.nextId++;
		const body = { jsonrpc: "2.0", id, method, params };
		if (this.proc) {
			return new Promise<Json>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`${this.name}: ${method} timed out`));
				}, timeoutMs);
				this.pending.set(id, {
					resolve: (v) => {
						clearTimeout(timer);
						resolve(v);
					},
					reject: (e) => {
						clearTimeout(timer);
						reject(e);
					},
				});
				this.proc!.stdin?.write(`${JSON.stringify(body)}\n`);
			});
		}
		return this.httpPost(body, timeoutMs).then((msg) => {
			if (msg.error) throw new Error(`${this.name}: ${(msg.error as { message?: string }).message}`);
			return (msg.result as Json) ?? {};
		});
	}

	private async httpPost(body: Json, timeoutMs = 60000): Promise<Json> {
		const res = await fetch(this.config.url!, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}), ...(this.config.headers ?? {}) },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const sid = res.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;
		if (res.status === 202 || res.status === 204) return {};
		if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
		const ctype = res.headers.get("content-type") ?? "";
		const text = await res.text();
		if (ctype.includes("text/event-stream")) {
			for (const block of text.split("\n\n")) {
				const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
				if (!data) continue;
				try {
					const msg = JSON.parse(data) as Json;
					if (msg.id === body.id) return msg;
				} catch {}
			}
			throw new Error(`${this.name}: no JSON-RPC response in event stream`);
		}
		return text ? (JSON.parse(text) as Json) : {};
	}
}
