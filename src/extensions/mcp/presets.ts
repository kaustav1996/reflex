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
import { ECC_SERVERS, type EccServer } from "./ecc.js";

/** oauth: browser consent via the mcp-remote bridge · api-key: a key the user provides · cli: a local stdio server (a vendor CLI's own login, or none) · none: a remote server with no sign-in. */
export type ConnectorAuth = "oauth" | "api-key" | "cli" | "none";

/** A value a connector needs besides its key (a URL, an email, a folder). Env var unless `arg`. */
export interface ConnectorField {
	key: string;
	label: string;
	placeholder?: string;
	/** Substituted for `{{key}}` in the command's arguments instead of set in its environment. */
	arg?: boolean;
}

export interface ConnectorPreset {
	/** Stable id used on the CLI: `reflex connect <id>`. */
	id: string;
	/** Human label. */
	label: string;
	/** Grouping for the picker. */
	category: "Communication" | "Project tracking" | "Mail" | "Productivity" | "Design" | "Fitness" | "Observability" | "Infrastructure" | "Analytics" | "Developer tools" | "Search" | "Memory" | "Browser" | "AI media" | "Documentation";
	/** One-line description of what the connector exposes. */
	description: string;
	/** How the user authenticates. */
	auth: ConnectorAuth;
	/** For `api-key` presets: the env var Reflex reads the key from (and `reflex connect` sets it). */
	envVar?: string;
	/** Where to get a key / learn more. */
	docsUrl?: string;
	/** Short line under the name on the card. */
	tagline: string;
	/** Longer paragraph for the detail page. */
	about: string;
	/** Who runs the server. */
	madeBy: { name: string; url: string };
	/** The remote endpoint the connector talks to. */
	endpoint: string;
	/** Directory-style categories. */
	categories: string[];
	/** Extra links for the detail page. */
	links?: { support?: string; privacy?: string };
	/** Another sign-in method for the same service: shown inside that connector's page, not as its own card. */
	variantOf?: string;
	/** Short name of this sign-in method when there are several (e.g. "OAuth", "API key"). */
	method?: string;
	/** Offer a read-only toggle (the build gets `readOnly`). */
	readOnlyOption?: boolean;
	/** A caveat worth showing before connecting (client allow-lists, own OAuth client, beta). */
	note?: string;
	/** Values besides the key that the user fills in when connecting. */
	fields?: ConnectorField[];
	/** Where the card comes from, when it isn't Reflex's own list (e.g. "ECC"). */
	source?: string;
	/** Build the server config. `apiKey` is the user-provided token for `api-key` presets. */
	build: (opts: { readOnly?: boolean; apiKey?: string; fields?: Record<string, string> }) => McpServerConfig;
}

/** The remote endpoint behind each connector (kept as a constant so tests + help can assert it). */
export const ENDPOINTS = {
	gmail: "https://gmailmcp.googleapis.com/mcp/v1",
	gdrive: "https://drivemcp.googleapis.com/mcp/v1",
	gcalendar: "https://calendarmcp.googleapis.com/mcp/v1",
	slack: "https://mcp.slack.com/sse",
	atlassian: "https://mcp.atlassian.com/v1/sse",
	linear: "https://mcp.linear.app/mcp",
	linearReadonly: "https://mcp.linear.app/mcp/readonly",
	figma: "https://mcp.figma.com/mcp",
	strava: "https://mcp.strava.com/mcp",
	datadog: "https://mcp.datadoghq.com/v1/mcp",
	sentry: "https://mcp.sentry.dev/mcp",
	supabase: "https://mcp.supabase.com/mcp",
	vercel: "https://mcp.vercel.com",
	netlify: "https://netlify-mcp.netlify.app/mcp",
	render: "https://mcp.render.com/mcp",
	posthog: "https://mcp.posthog.com/mcp",
	excalidrawPlus: "https://api.excalidraw.com/api/v1/mcp",
} as const;

/** Google Workspace MCP servers need your own OAuth client (Google Cloud console); mcp-remote passes it through when set. */
const GOOGLE_NOTE = "Google Workspace MCP servers require your own OAuth client: create one in the Google Cloud console, enable the *mcp.googleapis.com API for it, and set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in ~/.reflex/.env before connecting.";
function googleBridge(url: string): McpServerConfig {
	const cfg = mcpRemoteBridge(url);
	const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
	const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
	if (id && secret) cfg.args = [...(cfg.args ?? []), "--static-oauth-client-info", JSON.stringify({ client_id: id, client_secret: secret })];
	return cfg;
}

/** Bearer-token streamable HTTP config. */
function bearer(url: string, apiKey?: string): McpServerConfig {
	return { url, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : ({} as Record<string, string>), enabled: true };
}

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
		tagline: "Search, read, draft and send mail",
		about: "Connect Gmail to Reflex to search your inbox, read threads, draft replies and send mail from a session or an agent. Reads are gated like any other tool; sends are always confirmed by the reflex layer before they go out.",
		madeBy: { name: "Google", url: "https://developers.google.com/mcp" },
		endpoint: ENDPOINTS.gmail,
		categories: ["Mail", "Productivity"],
		links: { support: "https://support.google.com/mail", privacy: "https://policies.google.com/privacy" },
		note: GOOGLE_NOTE,
		build: () => googleBridge(ENDPOINTS.gmail),
	},
	{
		id: "gdrive",
		label: "Google Drive",
		category: "Productivity",
		description: "Google's official Drive MCP server — search, read, create, update and share files.",
		auth: "oauth",
		docsUrl: "https://developers.google.com/workspace/drive/api/reference/mcp",
		tagline: "Search, read and upload files",
		about: "Connect Google Drive to Reflex to find documents even when you don't remember the exact name, read Docs, Sheets, Slides and PDFs, and upload or organize files. Useful for pulling project notes and data into a session.",
		madeBy: { name: "Google", url: "https://developers.google.com/workspace/guides/configure-mcp-servers" },
		endpoint: ENDPOINTS.gdrive,
		categories: ["Productivity", "Data"],
		links: { support: "https://support.google.com/drive", privacy: "https://policies.google.com/privacy" },
		note: GOOGLE_NOTE,
		build: () => googleBridge(ENDPOINTS.gdrive),
	},
	{
		id: "gcalendar",
		label: "Google Calendar",
		category: "Productivity",
		description: "Google's official Calendar MCP server — list, create and update events.",
		auth: "oauth",
		docsUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
		tagline: "Events, availability and scheduling",
		about: "Connect Google Calendar to Reflex to read your schedule, find free slots, and create or move events. Creating and editing events is gated by the reflex layer like every other side effect.",
		madeBy: { name: "Google", url: "https://developers.google.com/workspace/guides/configure-mcp-servers" },
		endpoint: ENDPOINTS.gcalendar,
		categories: ["Productivity"],
		links: { support: "https://support.google.com/calendar", privacy: "https://policies.google.com/privacy" },
		note: GOOGLE_NOTE,
		build: () => googleBridge(ENDPOINTS.gcalendar),
	},
	{
		id: "slack",
		label: "Slack",
		category: "Communication",
		description: "Slack's official remote MCP server — channels, messages, threads, and search.",
		auth: "oauth",
		docsUrl: "https://api.slack.com/mcp",
		tagline: "Channels, threads, messages and search",
		about: "Connect Slack to Reflex to read channels and threads, search messages, and post updates. Useful for summarizing a channel, pulling context for a task, or letting an agent report results back to a channel (posting is gated).",
		madeBy: { name: "Slack", url: "https://api.slack.com/mcp" },
		endpoint: ENDPOINTS.slack,
		categories: ["Communication"],
		links: { support: "https://slack.com/help", privacy: "https://slack.com/trust/privacy/privacy-policy" },
		build: () => mcpRemoteBridge(ENDPOINTS.slack),
	},
	{
		id: "atlassian",
		label: "Atlassian (Jira + Confluence)",
		method: "OAuth (Jira + Confluence)",
		category: "Project tracking",
		description: "Atlassian's official remote MCP server — Jira issues and Confluence pages across your sites.",
		auth: "oauth",
		docsUrl: "https://www.atlassian.com/mcp",
		tagline: "Jira issues and Confluence pages",
		about: "Connect Atlassian to Reflex to search and update Jira issues, read and write Confluence pages, and pull ticket context into a coding session. Works across every site your account can access.",
		madeBy: { name: "Atlassian", url: "https://www.atlassian.com/mcp" },
		endpoint: ENDPOINTS.atlassian,
		categories: ["Project tracking", "Documentation"],
		links: { support: "https://support.atlassian.com", privacy: "https://www.atlassian.com/legal/privacy-policy" },
		build: () => mcpRemoteBridge(ENDPOINTS.atlassian),
	},
	{
		id: "linear",
		label: "Linear",
		method: "OAuth",
		readOnlyOption: true,
		category: "Project tracking",
		description: "Linear's official remote MCP server — issues, projects, comments. OAuth in your browser.",
		auth: "oauth",
		docsUrl: "https://linear.app/docs/mcp",
		tagline: "Issues, projects and comments",
		about: "Connect Linear to Reflex to search and create issues, update status, comment, and read projects and cycles. Signs you in with OAuth in your browser; a read-only variant is available.",
		madeBy: { name: "Linear", url: "https://linear.app/docs/mcp" },
		endpoint: ENDPOINTS.linear,
		categories: ["Project tracking"],
		links: { support: "https://linear.app/contact", privacy: "https://linear.app/privacy" },
		build: ({ readOnly } = {}) => mcpRemoteBridge(readOnly ? ENDPOINTS.linearReadonly : ENDPOINTS.linear, readOnly),
	},
	{
		id: "linear-key",
		label: "Linear (API key)",
		variantOf: "linear",
		method: "API key",
		readOnlyOption: true,
		category: "Project tracking",
		description: "Linear's MCP server over streamable-HTTP using a personal API key — no browser, no npx.",
		auth: "api-key",
		envVar: "LINEAR_API_KEY",
		docsUrl: "https://linear.app/docs/mcp",
		tagline: "Linear with a personal API key",
		about: "The same Linear MCP server, reached over streamable HTTP with a personal API key instead of OAuth. No browser and no npx bridge; best for agents that run unattended.",
		madeBy: { name: "Linear", url: "https://linear.app/docs/mcp" },
		endpoint: ENDPOINTS.linear,
		categories: ["Project tracking"],
		links: { support: "https://linear.app/contact", privacy: "https://linear.app/privacy" },
		build: ({ apiKey, readOnly } = {}) => ({
			url: readOnly ? ENDPOINTS.linearReadonly : ENDPOINTS.linear,
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : ({} as Record<string, string>),
			enabled: true,
		}),
	},
	{
		id: "figma",
		label: "Figma",
		category: "Design",
		description: "Figma's official remote MCP server — read designs, components and variables for design-to-code.",
		auth: "oauth",
		docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
		tagline: "Designs, components and variables",
		about: "Connect Figma to Reflex to read frames, components, variables and design context straight from your files, so the agent can implement a design instead of guessing from a screenshot.",
		madeBy: { name: "Figma", url: "https://developers.figma.com/docs/figma-mcp-server/" },
		endpoint: ENDPOINTS.figma,
		categories: ["Design"],
		links: { support: "https://help.figma.com", privacy: "https://www.figma.com/privacy/" },
		note: "Figma only accepts MCP clients on its catalog allow-list; the OAuth step may be refused for the mcp-remote bridge until Figma lists it.",
		build: () => mcpRemoteBridge(ENDPOINTS.figma),
	},
	{
		id: "strava",
		label: "Strava",
		category: "Fitness",
		description: "Strava's official MCP connector — read-only access to your activities and training history.",
		auth: "oauth",
		docsUrl: "https://support.strava.com/hc/en-us/articles/46190267796237-Strava-MCP-Connector",
		tagline: "Activities and training history",
		about: "Connect Strava to Reflex to review your activity history, spot patterns and plan around training goals. Read-only, scoped to your account, and requires a Strava subscription.",
		madeBy: { name: "Strava", url: "https://press.strava.com/articles/strava-launches-mcp-connector" },
		endpoint: ENDPOINTS.strava,
		categories: ["Fitness", "Personal"],
		links: { support: "https://support.strava.com", privacy: "https://www.strava.com/legal/privacy" },
		build: () => mcpRemoteBridge(ENDPOINTS.strava),
	},
	{
		id: "datadog",
		label: "Datadog",
		category: "Observability",
		description: "Datadog's official MCP server — logs, metrics, traces, monitors and incidents.",
		auth: "oauth",
		docsUrl: "https://docs.datadoghq.com/mcp_server/setup/",
		tagline: "Logs, metrics, traces and monitors",
		about: "Connect Datadog to Reflex to search logs and spans, read metrics and monitors, and pull incident context into a debugging session. US1 endpoint by default; EU users can add a custom server pointing at mcp.datadoghq.eu.",
		madeBy: { name: "Datadog", url: "https://docs.datadoghq.com/mcp_server/" },
		endpoint: ENDPOINTS.datadog,
		categories: ["Observability"],
		links: { support: "https://help.datadoghq.com", privacy: "https://www.datadoghq.com/legal/privacy/" },
		note: "Datadog's MCP server is in preview and must be enabled for your org.",
		build: () => mcpRemoteBridge(ENDPOINTS.datadog),
	},
	{
		id: "sentry",
		label: "Sentry",
		category: "Observability",
		description: "Sentry's hosted MCP server — issues, errors, releases and Seer fixes.",
		auth: "oauth",
		docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
		tagline: "Issues, errors and releases",
		about: "Connect Sentry to Reflex to look up issues and stack traces, check releases and let the agent debug production errors with real context.",
		madeBy: { name: "Sentry", url: "https://mcp.sentry.dev/" },
		endpoint: ENDPOINTS.sentry,
		categories: ["Observability"],
		links: { support: "https://sentry.io/support/", privacy: "https://sentry.io/privacy/" },
		build: () => mcpRemoteBridge(ENDPOINTS.sentry),
	},
	{
		id: "supabase",
		label: "Supabase",
		category: "Infrastructure",
		description: "Supabase's remote MCP server — projects, database, SQL, migrations and logs.",
		auth: "oauth",
		docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
		tagline: "Projects, database and SQL",
		about: "Connect Supabase to Reflex to inspect tables, run SQL, apply migrations and read logs across your projects. Enable read-only to keep the agent from writing to the database.",
		madeBy: { name: "Supabase", url: "https://supabase.com/docs/guides/ai-tools/mcp" },
		endpoint: ENDPOINTS.supabase,
		categories: ["Infrastructure", "Data"],
		links: { support: "https://supabase.com/support", privacy: "https://supabase.com/privacy" },
		readOnlyOption: true,
		build: ({ readOnly } = {}) => mcpRemoteBridge(readOnly ? `${ENDPOINTS.supabase}?read_only=true` : ENDPOINTS.supabase),
	},
	{
		id: "vercel",
		label: "Vercel",
		category: "Infrastructure",
		description: "Vercel's official MCP server — projects, deployments, logs and analytics.",
		auth: "oauth",
		docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
		tagline: "Projects, deployments and logs",
		about: "Connect Vercel to Reflex to list projects, inspect deployments and their logs, and query Web Analytics. Deploying and purchases are gated like any other side effect.",
		madeBy: { name: "Vercel", url: "https://vercel.com/docs/agent-resources/vercel-mcp" },
		endpoint: ENDPOINTS.vercel,
		categories: ["Infrastructure"],
		links: { support: "https://vercel.com/help", privacy: "https://vercel.com/legal/privacy-policy" },
		note: "Vercel only allows reviewed MCP clients; the mcp-remote bridge may be refused at the OAuth step.",
		build: () => mcpRemoteBridge(ENDPOINTS.vercel),
	},
	{
		id: "netlify",
		label: "Netlify",
		category: "Infrastructure",
		description: "Netlify's official remote MCP server — sites, deploys, builds and env vars.",
		auth: "oauth",
		docsUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
		tagline: "Sites, deploys and builds",
		about: "Connect Netlify to Reflex to create and manage sites, trigger and inspect deploys, and read build logs from a session.",
		madeBy: { name: "Netlify", url: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/" },
		endpoint: ENDPOINTS.netlify,
		categories: ["Infrastructure"],
		links: { support: "https://answers.netlify.com", privacy: "https://www.netlify.com/privacy/" },
		build: () => mcpRemoteBridge(ENDPOINTS.netlify),
	},
	{
		id: "render",
		label: "Render",
		category: "Infrastructure",
		description: "Render's official MCP server — services, databases, deploys and logs, via API key.",
		auth: "api-key",
		envVar: "RENDER_API_KEY",
		docsUrl: "https://render.com/docs/mcp-server",
		tagline: "Services, databases and logs",
		about: "Connect Render to Reflex to list services and databases, inspect deploys and read logs. Uses a Render API key from Account Settings; no browser flow.",
		madeBy: { name: "Render", url: "https://render.com/docs/mcp-server" },
		endpoint: ENDPOINTS.render,
		categories: ["Infrastructure"],
		links: { support: "https://render.com/docs", privacy: "https://render.com/privacy" },
		build: ({ apiKey } = {}) => bearer(ENDPOINTS.render, apiKey),
	},
	{
		id: "posthog",
		label: "PostHog",
		category: "Analytics",
		method: "OAuth",
		description: "PostHog's MCP server — insights, feature flags, experiments and error tracking.",
		auth: "oauth",
		docsUrl: "https://posthog.com/docs/model-context-protocol",
		tagline: "Insights, flags and errors",
		about: "Connect PostHog to Reflex to query insights and events, manage feature flags and experiments, and look at error tracking from a session.",
		madeBy: { name: "PostHog", url: "https://posthog.com/docs/model-context-protocol" },
		endpoint: ENDPOINTS.posthog,
		categories: ["Analytics"],
		links: { support: "https://posthog.com/questions", privacy: "https://posthog.com/privacy" },
		build: () => mcpRemoteBridge(ENDPOINTS.posthog),
	},
	{
		id: "posthog-key",
		label: "PostHog (API key)",
		category: "Analytics",
		variantOf: "posthog",
		method: "API key",
		description: "PostHog's MCP server over streamable HTTP with a personal API key.",
		auth: "api-key",
		envVar: "POSTHOG_PERSONAL_API_KEY",
		docsUrl: "https://posthog.com/docs/model-context-protocol/faq",
		tagline: "PostHog with a personal API key",
		about: "The same PostHog MCP server, authenticated with a personal API key (create one with the MCP Server preset in PostHog). No browser flow; good for unattended agents.",
		madeBy: { name: "PostHog", url: "https://posthog.com/docs/model-context-protocol" },
		endpoint: ENDPOINTS.posthog,
		categories: ["Analytics"],
		links: { support: "https://posthog.com/questions", privacy: "https://posthog.com/privacy" },
		build: ({ apiKey } = {}) => bearer(ENDPOINTS.posthog, apiKey),
	},
	{
		id: "railway",
		label: "Railway",
		category: "Infrastructure",
		description: "Railway's official MCP server, bundled in the Railway CLI — services, environments, deploys and logs.",
		auth: "cli",
		docsUrl: "https://docs.railway.com/reference/mcp-server",
		tagline: "Services, environments and deploys",
		about: "Connect Railway to Reflex through the Railway CLI's built-in MCP server. Install the CLI and run `railway login` once; the connector then runs `railway mcp` locally with that login.",
		madeBy: { name: "Railway", url: "https://docs.railway.com/reference/mcp-server" },
		endpoint: "railway mcp (local stdio)",
		categories: ["Infrastructure"],
		links: { support: "https://help.railway.com", privacy: "https://railway.com/legal/privacy" },
		note: "Needs the Railway CLI on your PATH and a completed `railway login`.",
		build: () => ({ command: "railway", args: ["mcp"], enabled: true }),
	},
	{
		id: "excalidraw",
		label: "Excalidraw",
		category: "Design",
		method: "Local (open source)",
		description: "Community Excalidraw MCP server (npm excalidraw-mcp) — create and edit diagrams locally.",
		auth: "cli",
		docsUrl: "https://www.npmjs.com/package/excalidraw-mcp",
		tagline: "Draw and edit diagrams",
		about: "Let the agent create, modify and export Excalidraw diagrams. This runs the open-source community server locally with npx; no account is needed. Use the Excalidraw+ method for the hosted server tied to your Excalidraw+ workspace.",
		madeBy: { name: "Excalidraw community", url: "https://github.com/yctimlin/mcp_excalidraw" },
		endpoint: "npx -y excalidraw-mcp (local stdio)",
		categories: ["Design", "Diagrams"],
		links: { privacy: "https://plus.excalidraw.com/privacy" },
		build: () => ({ command: "npx", args: ["-y", "excalidraw-mcp"], enabled: true }),
	},
	{
		id: "excalidraw-plus",
		label: "Excalidraw+ (API key)",
		category: "Design",
		variantOf: "excalidraw",
		method: "Excalidraw+ API key",
		description: "Excalidraw+'s hosted MCP server (beta) — diagrams in your Excalidraw+ workspace, via API key.",
		auth: "api-key",
		envVar: "EXCALIDRAW_API_KEY",
		docsUrl: "https://plus.excalidraw.com/docs/mcp",
		tagline: "Excalidraw+ hosted server",
		about: "Excalidraw+'s hosted MCP server over streamable HTTP with an API key from your Excalidraw+ workspace. In public beta: tool names and schemas may still change.",
		madeBy: { name: "Excalidraw", url: "https://plus.excalidraw.com/docs/mcp" },
		endpoint: ENDPOINTS.excalidrawPlus,
		categories: ["Design", "Diagrams"],
		links: { privacy: "https://plus.excalidraw.com/privacy" },
		note: "Public beta.",
		build: ({ apiKey } = {}) => bearer(ENDPOINTS.excalidrawPlus, apiKey),
	},
];

/** An ECC server row as a connector card. */
export function eccPreset(e: EccServer): ConnectorPreset {
	const t = e.transport;
	const auth: ConnectorAuth = e.keyEnv ? "api-key" : "stdio" in t ? "cli" : "oauth" in t ? "oauth" : "none";
	const endpoint = "stdio" in t ? `${[t.stdio, ...(t.args ?? [])].join(" ")} (local stdio)` : "oauth" in t ? t.oauth : "open" in t ? t.open : t.http;
	return {
		id: e.id,
		label: e.label,
		category: e.category,
		description: e.about,
		auth,
		envVar: e.keyEnv,
		docsUrl: e.docsUrl,
		tagline: e.tagline,
		about: e.about,
		madeBy: e.madeBy,
		endpoint,
		categories: [e.category],
		variantOf: e.variantOf,
		method: e.method,
		note: e.note,
		fields: e.fields,
		source: "ECC",
		build: ({ apiKey, fields = {} } = {}) => {
			if ("stdio" in t) {
				const args = (t.args ?? []).map((a) => a.replace(/\{\{(\w+)\}\}/g, (_, k: string) => fields[k] ?? ""));
				return { command: t.stdio, args, ...(t.env ? { env: { ...t.env } } : {}), enabled: true };
			}
			if ("oauth" in t) return mcpRemoteBridge(t.oauth);
			if ("open" in t) return { url: t.open, enabled: true };
			return { url: t.http, headers: apiKey ? { [t.header]: t.scheme ? `${t.scheme} ${apiKey}` : apiKey } : ({} as Record<string, string>), enabled: true };
		},
	};
}

for (const e of ECC_SERVERS) if (!PRESETS.some((p) => p.id === e.id)) PRESETS.push(eccPreset(e));

export function findPreset(id: string): ConnectorPreset | undefined {
	return PRESETS.find((p) => p.id === id);
}

/** Serializable preset metadata for the web UI (no `build` function). */
export interface PresetMeta {
	id: string;
	label: string;
	category: ConnectorPreset["category"];
	description: string;
	auth: ConnectorAuth;
	envVar?: string;
	docsUrl?: string;
	tagline: string;
	about: string;
	madeBy: { name: string; url: string };
	endpoint: string;
	categories: string[];
	links?: { support?: string; privacy?: string };
	variantOf?: string;
	method?: string;
	readOnlyOption?: boolean;
	note?: string;
	fields?: ConnectorField[];
	source?: string;
	/** How the connection is made, for the detail page. */
	transport: "mcp-remote bridge (OAuth in your browser)" | "streamable HTTP" | "local stdio";
}

/** How a preset connects, from the config it builds (a keyed server can still be a local process). */
function transportOf(p: ConnectorPreset): PresetMeta["transport"] {
	if (p.auth === "oauth") return "mcp-remote bridge (OAuth in your browser)";
	return p.build({}).command ? "local stdio" : "streamable HTTP";
}

export const PRESET_META: PresetMeta[] = PRESETS.map((p) => ({ ...metaOf(p), transport: transportOf(p) }));

function metaOf({ id, label, category, description, auth, envVar, docsUrl, tagline, about, madeBy, endpoint, categories, links, variantOf, method, readOnlyOption, note, fields, source }: ConnectorPreset): Omit<PresetMeta, "transport"> {
	return { id, label, category, description, auth, envVar, docsUrl, tagline, about, madeBy, endpoint, categories, links, variantOf, method, readOnlyOption, note, fields, source };
}
