/**
 * Built-in MCP connector presets.
 *
 * Reflex already lets you add any MCP server by hand in `reflex web → Settings → Connectors`
 * (or by editing `~/.reflex/mcp.json`). These presets are the "no details required" version: the
 * user just runs `reflex connect gmail` (or `/connect gmail` in the agent) and Reflex fills in
 * the right endpoint and transport. All four are the *official, vendor-hosted* remote MCP
 * servers — centrally managed, OAuth-authenticated, no API keys to copy by hand.
 *
 * Because Reflex's own MCP client speaks stdio + streamable-HTTP but does not implement the
 * OAuth 2.1 + dynamic-client-registration dance, OAuth remotes are bridged through the
 * `mcp-remote` package: `npx -y mcp-remote <url>` spawns a local stdio server that runs the
 * OAuth flow in your browser on first use and caches the token in `~/.mcp-auth/`. After that it
 * is transparent. Linear additionally supports a personal API key, so we offer a key-based
 * variant that talks streamable-HTTP directly with no browser and no `npx`.
 */
import type { McpServerConfig } from "./client.js";

export type ConnectorAuth = "oauth" | "api-key";

export interface ConnectorPreset {
	/** Stable id used on the CLI: `reflex connect <id>`. */
	id: string;
	/** Human label. */
	label: string;
	/** Grouping for the picker. */
	category: "Communication" | "Project tracking" | "Mail";
	/** One-line description of what the connector exposes. */
	description: string;
	/** How the user authenticates. */
	auth: ConnectorAuth;
	/** For `api-key` presets: the env var Reflex reads the key from (and `reflex connect` sets it). */
	envVar?: string;
	/** Where to get a key / learn more. */
	docsUrl?: string;
	/** Build the server config. `apiKey` is the user-provided token for `api-key` presets. */
	build: (opts: { readOnly?: boolean; apiKey?: string }) => McpServerConfig;
}

/** The remote endpoint behind each connector (kept as a constant so tests + help can assert it). */
export const ENDPOINTS = {
	gmail: "https://mcp.google.com/gmail/mcp",
	slack: "https://mcp.slack.com/sse",
	atlassian: "https://mcp.atlassian.com/v1/sse",
	linear: "https://mcp.linear.app/mcp",
	linearReadonly: "https://mcp.linear.app/mcp/readonly",
} as const;

/** `mcp-remote` stdio bridge: spawns a local stdio MCP server that owns the OAuth flow. */
function mcpRemoteBridge(url: string, readOnly?: boolean): McpServerConfig {
	const args = ["-y", "mcp-remote@latest", url];
	if (readOnly) args.push("--tool-filter-readonly");
	return { command: "npx", args, enabled: true };
}

export const PRESETS: ConnectorPreset[] = [
	{
		id: "gmail",
		label: "Gmail",
		category: "Mail",
		description: "Google's official remote MCP server for Gmail — read, search, draft, and send mail.",
		auth: "oauth",
		docsUrl: "https://developers.google.com/mcp",
		build: () => mcpRemoteBridge(ENDPOINTS.gmail),
	},
	{
		id: "slack",
		label: "Slack",
		category: "Communication",
		description: "Slack's official remote MCP server — channels, messages, threads, and search.",
		auth: "oauth",
		docsUrl: "https://api.slack.com/mcp",
		build: () => mcpRemoteBridge(ENDPOINTS.slack),
	},
	{
		id: "atlassian",
		label: "Atlassian (Jira + Confluence)",
		category: "Project tracking",
		description: "Atlassian's official remote MCP server — Jira issues and Confluence pages across your sites.",
		auth: "oauth",
		docsUrl: "https://www.atlassian.com/mcp",
		build: () => mcpRemoteBridge(ENDPOINTS.atlassian),
	},
	{
		id: "linear",
		label: "Linear (OAuth)",
		category: "Project tracking",
		description: "Linear's official remote MCP server — issues, projects, comments. OAuth in your browser.",
		auth: "oauth",
		docsUrl: "https://linear.app/docs/mcp",
		build: ({ readOnly } = {}) => mcpRemoteBridge(readOnly ? ENDPOINTS.linearReadonly : ENDPOINTS.linear, readOnly),
	},
	{
		id: "linear-key",
		label: "Linear (API key)",
		category: "Project tracking",
		description: "Linear's MCP server over streamable-HTTP using a personal API key — no browser, no npx.",
		auth: "api-key",
		envVar: "LINEAR_API_KEY",
		docsUrl: "https://linear.app/docs/mcp",
		build: ({ apiKey, readOnly } = {}) => ({
			url: readOnly ? ENDPOINTS.linearReadonly : ENDPOINTS.linear,
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : ({} as Record<string, string>),
			enabled: true,
		}),
	},
];

export function findPreset(id: string): ConnectorPreset | undefined {
	return PRESETS.find((p) => p.id === id);
}
