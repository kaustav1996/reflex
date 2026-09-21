/**
 * The MCP servers from ECC (github.com/affaan-m/ECC, MIT), as connector cards.
 *
 * Source: ECC's `mcp-configs/mcp-servers.json`. Servers Reflex already has its own card for
 * (Supabase, Vercel, Railway) are left out. Every card is off until the user connects it; servers
 * that need a key or a value get it through the connect form, never from a placeholder.
 *
 * Plain data on purpose: `presets.ts` turns each row into a ConnectorPreset.
 */

export const ECC_REPO = "https://github.com/affaan-m/ECC";
export const ECC_PACKAGE_SOURCE = "git:github.com/affaan-m/ECC";

export type EccTransport =
	/** local stdio process */
	| { stdio: string; args?: string[]; env?: Record<string, string> }
	/** remote server that signs in through the mcp-remote OAuth bridge */
	| { oauth: string }
	/** remote server with no sign-in */
	| { open: string }
	/** remote server that takes the key in a header */
	| { http: string; header: string; scheme?: "Bearer" };

export interface EccField {
	/** Env var name, or an `{{arg}}` placeholder name for path arguments. */
	key: string;
	label: string;
	placeholder?: string;
	/** Substituted into the command's arguments instead of the environment. */
	arg?: boolean;
}

export interface EccServer {
	id: string;
	label: string;
	category: "Developer tools" | "Search" | "Memory" | "Browser" | "AI media" | "Documentation" | "Infrastructure" | "Analytics" | "Design" | "Project tracking";
	tagline: string;
	about: string;
	transport: EccTransport;
	/** The key the server needs, passed as this env var (or header for `http`). */
	keyEnv?: string;
	/** Other values the server needs. */
	fields?: EccField[];
	madeBy: { name: string; url: string };
	docsUrl?: string;
	/** Shown before connecting: what has to be installed or running first. */
	note?: string;
	/** Another way to reach a service Reflex already has a card for. */
	variantOf?: string;
	method?: string;
}

const npm = (pkg: string) => `https://www.npmjs.com/package/${pkg}`;

export const ECC_SERVERS: EccServer[] = [
	{
		id: "github",
		label: "GitHub",
		category: "Developer tools",
		tagline: "Pull requests, issues and repos",
		about: "The GitHub MCP server as configured by ECC: read and manage pull requests, issues, branches and repository files with a personal access token. Reflex's own git and deploy features use your `gh` login instead; this connector is for agents that should work with GitHub through tools.",
		transport: { stdio: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
		keyEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
		madeBy: { name: "Model Context Protocol", url: npm("@modelcontextprotocol/server-github") },
		docsUrl: npm("@modelcontextprotocol/server-github"),
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		category: "Search",
		tagline: "Scrape and crawl websites",
		about: "Firecrawl turns web pages and whole sites into clean markdown the agent can read: scrape a page, crawl a site, map its URLs or search the web.",
		transport: { stdio: "npx", args: ["-y", "firecrawl-mcp"] },
		keyEnv: "FIRECRAWL_API_KEY",
		madeBy: { name: "Firecrawl", url: "https://firecrawl.dev" },
		docsUrl: npm("firecrawl-mcp"),
	},
	{
		id: "exa-web-search",
		label: "Exa search",
		category: "Search",
		tagline: "Web search built for agents",
		about: "Web search, research and content retrieval through the Exa API. ECC suggests using it for broader research after checking GitHub and the primary docs.",
		transport: { stdio: "npx", args: ["-y", "exa-mcp-server"] },
		keyEnv: "EXA_API_KEY",
		madeBy: { name: "Exa", url: "https://exa.ai" },
		docsUrl: npm("exa-mcp-server"),
	},
	{
		id: "parallel-search",
		label: "Parallel search",
		category: "Search",
		tagline: "Search and fetch with citations",
		about: "Parallel's hosted web_search and web_fetch tools: give an objective and queries, get back citation-backed excerpts in one call instead of several keyword searches.",
		transport: { open: "https://search.parallel.ai/mcp" },
		madeBy: { name: "Parallel", url: "https://parallel.ai" },
		docsUrl: "https://parallel.ai",
	},
	{
		id: "cloudflare-docs",
		label: "Cloudflare docs",
		category: "Documentation",
		tagline: "Search Cloudflare's documentation",
		about: "Cloudflare's hosted documentation server: search and read the Cloudflare developer docs from a session.",
		transport: { open: "https://docs.mcp.cloudflare.com/mcp" },
		madeBy: { name: "Cloudflare", url: "https://developers.cloudflare.com/agents/model-context-protocol/" },
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
	},
	{
		id: "cloudflare-workers-builds",
		label: "Cloudflare Workers builds",
		category: "Infrastructure",
		tagline: "Workers builds and their logs",
		about: "Cloudflare's hosted server for Workers Builds: list builds, read build logs and inspect what failed.",
		transport: { oauth: "https://builds.mcp.cloudflare.com/mcp" },
		madeBy: { name: "Cloudflare", url: "https://developers.cloudflare.com/agents/model-context-protocol/" },
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
	},
	{
		id: "cloudflare-workers-bindings",
		label: "Cloudflare Workers bindings",
		category: "Infrastructure",
		tagline: "KV, R2, D1 and other bindings",
		about: "Cloudflare's hosted server for Workers bindings: work with KV namespaces, R2 buckets, D1 databases and other resources your Workers use.",
		transport: { oauth: "https://bindings.mcp.cloudflare.com/mcp" },
		madeBy: { name: "Cloudflare", url: "https://developers.cloudflare.com/agents/model-context-protocol/" },
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
	},
	{
		id: "cloudflare-observability",
		label: "Cloudflare observability",
		category: "Infrastructure",
		tagline: "Workers logs and analytics",
		about: "Cloudflare's hosted observability server: query Workers logs and analytics to debug what happened in production.",
		transport: { oauth: "https://observability.mcp.cloudflare.com/mcp" },
		madeBy: { name: "Cloudflare", url: "https://developers.cloudflare.com/agents/model-context-protocol/" },
		docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
	},
	{
		id: "clickhouse",
		label: "ClickHouse",
		category: "Analytics",
		tagline: "Query ClickHouse Cloud",
		about: "ClickHouse Cloud's hosted MCP server: explore databases and tables and run analytical queries.",
		transport: { oauth: "https://mcp.clickhouse.cloud/mcp" },
		madeBy: { name: "ClickHouse", url: "https://clickhouse.com" },
		docsUrl: "https://clickhouse.com/docs",
	},
	{
		id: "context7",
		label: "Context7",
		category: "Documentation",
		tagline: "Up-to-date library docs",
		about: "Looks up current documentation for libraries and frameworks (resolve a library, then query its docs), so the agent doesn't rely on stale training data.",
		transport: { stdio: "npx", args: ["-y", "@upstash/context7-mcp@latest"] },
		madeBy: { name: "Upstash", url: "https://context7.com" },
		docsUrl: npm("@upstash/context7-mcp"),
	},
	{
		id: "memory",
		label: "Memory (knowledge graph)",
		category: "Memory",
		tagline: "A simple persistent knowledge graph",
		about: "The reference memory server: entities, relations and observations stored in a local file, readable across sessions. Reflex's own shared memory is planned separately (issue #43); this is a quick way to try persistent memory today.",
		transport: { stdio: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
		madeBy: { name: "Model Context Protocol", url: npm("@modelcontextprotocol/server-memory") },
		docsUrl: npm("@modelcontextprotocol/server-memory"),
	},
	{
		id: "omega-memory",
		label: "Omega memory",
		category: "Memory",
		tagline: "Semantic memory and knowledge graphs",
		about: "Persistent agent memory with semantic search, multi-agent coordination and knowledge graphs, run locally through uvx.",
		transport: { stdio: "uvx", args: ["omega-memory", "serve"] },
		madeBy: { name: "omega-memory", url: "https://pypi.org/project/omega-memory/" },
		docsUrl: "https://pypi.org/project/omega-memory/",
		note: "Needs uv (for `uvx`) on your PATH.",
	},
	{
		id: "longhand",
		label: "Longhand",
		category: "Memory",
		tagline: "Searchable Claude Code session history",
		about: "Indexes raw Claude Code sessions (tool calls, file edits, thinking) from ~/.claude/projects into local SQLite and ChromaDB, so an agent can search what happened in past sessions.",
		transport: { stdio: "longhand", args: ["mcp-server"] },
		madeBy: { name: "Longhand", url: ECC_REPO },
		note: "Needs the `longhand` command installed. It reads Claude Code's history, not Reflex's.",
	},
	{
		id: "ecc-memory-vault",
		label: "ECC memory vault",
		category: "Memory",
		tagline: "Memory shared with your other agents",
		about: "ECC's local memory vault, shared by Claude Code, Codex, Hermes, Cursor, OpenCode and other MCP clients. Reflex connects as its own identity (`reflex`).",
		transport: { stdio: "ecc-memory-mcp", env: { ECC_MEMORY_HARNESS: "reflex" } },
		madeBy: { name: "ECC", url: ECC_REPO },
		docsUrl: ECC_REPO,
		note: "Needs ECC's `ecc-memory-mcp` command installed.",
	},
	{
		id: "nexus",
		label: "Nexus",
		category: "Developer tools",
		tagline: "Usage, cost and privacy proxy",
		about: "A local cost and privacy proxy: query your own usage and savings, route to the cheapest capable model, and mask secrets and personal data before requests leave the machine.",
		transport: { stdio: "nexus", args: ["mcp"] },
		madeBy: { name: "Nexus", url: ECC_REPO },
		note: "Needs the `nexus` command installed.",
	},
	{
		id: "sequential-thinking",
		label: "Sequential thinking",
		category: "Developer tools",
		tagline: "Step-by-step problem solving",
		about: "The reference sequential-thinking server: gives the model a tool for breaking a problem into revisable steps.",
		transport: { stdio: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
		madeBy: { name: "Model Context Protocol", url: npm("@modelcontextprotocol/server-sequential-thinking") },
		docsUrl: npm("@modelcontextprotocol/server-sequential-thinking"),
	},
	{
		id: "magic",
		label: "Magic UI",
		category: "Design",
		tagline: "UI components on demand",
		about: "Magic UI's server: find and insert Magic UI React components into the project.",
		transport: { stdio: "npx", args: ["-y", "@magicuidesign/mcp@latest"] },
		madeBy: { name: "Magic UI", url: "https://magicui.design" },
		docsUrl: npm("@magicuidesign/mcp"),
	},
	{
		id: "playwright",
		label: "Playwright",
		category: "Browser",
		tagline: "Browser automation and testing",
		about: "Microsoft's Playwright MCP server: drive Chrome from the accessibility tree to test pages and flows. Reflex's own browser agent (`browse`) covers goal-driven browsing; this one gives the model direct browser tools.",
		transport: { stdio: "npx", args: ["-y", "@playwright/mcp", "--browser", "chrome"] },
		madeBy: { name: "Microsoft", url: "https://github.com/microsoft/playwright-mcp" },
		docsUrl: "https://github.com/microsoft/playwright-mcp",
	},
	{
		id: "fal-ai",
		label: "fal.ai",
		category: "AI media",
		tagline: "Generate images, video and audio",
		about: "Generate and edit images, video and audio with the models hosted on fal.ai.",
		transport: { stdio: "npx", args: ["-y", "fal-ai-mcp-server"] },
		keyEnv: "FAL_KEY",
		madeBy: { name: "fal.ai", url: "https://fal.ai" },
		docsUrl: npm("fal-ai-mcp-server"),
	},
	{
		id: "browserbase",
		label: "Browserbase",
		category: "Browser",
		tagline: "Cloud browser sessions",
		about: "Run browser sessions in Browserbase's cloud instead of on your machine: navigate, click, extract and take screenshots.",
		transport: { stdio: "npx", args: ["-y", "@browserbasehq/mcp-server-browserbase"] },
		keyEnv: "BROWSERBASE_API_KEY",
		madeBy: { name: "Browserbase", url: "https://www.browserbase.com" },
		docsUrl: npm("@browserbasehq/mcp-server-browserbase"),
	},
	{
		id: "browser-use",
		label: "Browser Use",
		category: "Browser",
		tagline: "Hosted browser agent",
		about: "Browser Use's hosted agent: hand it a web task and it carries it out in a cloud browser.",
		transport: { http: "https://api.browser-use.com/mcp", header: "x-browser-use-api-key" },
		keyEnv: "BROWSER_USE_API_KEY",
		madeBy: { name: "Browser Use", url: "https://browser-use.com" },
		docsUrl: "https://docs.browser-use.com",
	},
	{
		id: "memxus",
		label: "Memxus",
		category: "Memory",
		tagline: "Hosted memory across AI tools",
		about: "Hosted persistent memory shared across Claude Code, Cursor, Gemini CLI and other tools: save context once and have it recalled in later sessions.",
		transport: { http: "https://mcp.memxus.com/mcp", header: "Authorization", scheme: "Bearer" },
		keyEnv: "MEMXUS_API_KEY",
		madeBy: { name: "Memxus", url: "https://memxus.com" },
		docsUrl: "https://memxus.com",
		note: "Hosted: what you save is stored on Memxus's servers.",
	},
	{
		id: "codescene",
		label: "CodeScene code health",
		category: "Developer tools",
		tagline: "Code health scores and hotspots",
		about: "CodeScene's Code Health server: score files for maintainability, find hotspots and check whether a change made the code healthier.",
		transport: { stdio: "npx", args: ["-y", "@codescene/codehealth-mcp"] },
		keyEnv: "CS_ACCESS_TOKEN",
		madeBy: { name: "CodeScene", url: "https://codescene.com" },
		docsUrl: npm("@codescene/codehealth-mcp"),
	},
	{
		id: "token-optimizer",
		label: "Token optimizer",
		category: "Developer tools",
		tagline: "Deduplicate and compress context",
		about: "Reduces context size through content deduplication and compression. ECC lists it for long sessions; measure it on your own work before relying on it.",
		transport: { stdio: "npx", args: ["-y", "token-optimizer-mcp"] },
		madeBy: { name: "token-optimizer-mcp", url: npm("token-optimizer-mcp") },
		docsUrl: npm("token-optimizer-mcp"),
	},
	{
		id: "devfleet",
		label: "DevFleet",
		category: "Developer tools",
		tagline: "Parallel Claude Code agents",
		about: "Multi-agent orchestration: dispatch parallel Claude Code agents in isolated worktrees, plan projects, chain missions and read structured reports.",
		transport: { open: "http://localhost:18801/mcp" },
		madeBy: { name: "LEC-AI", url: "https://github.com/LEC-AI/claude-devfleet" },
		docsUrl: "https://github.com/LEC-AI/claude-devfleet",
		note: "Needs claude-devfleet running locally on port 18801.",
	},
	{
		id: "laraplugins",
		label: "Laravel plugins",
		category: "Developer tools",
		tagline: "Find Laravel packages",
		about: "Search Laravel packages by keyword, health score and Laravel/PHP version compatibility.",
		transport: { open: "https://laraplugins.io/mcp/plugins" },
		madeBy: { name: "laraplugins.io", url: "https://laraplugins.io" },
		docsUrl: "https://laraplugins.io",
	},
	{
		id: "evalview",
		label: "EvalView",
		category: "Developer tools",
		tagline: "Regression tests for agents",
		about: "Snapshot an agent's behaviour and detect regressions in its tool calls and output quality: create tests, run snapshots and checks, and generate tests for skills.",
		transport: { stdio: "python3", args: ["-m", "evalview", "mcp", "serve"] },
		keyEnv: "OPENAI_API_KEY",
		madeBy: { name: "EvalView", url: "https://pypi.org/project/evalview/" },
		docsUrl: "https://pypi.org/project/evalview/",
		note: "Needs `pip install evalview`. It calls OpenAI with the key you give it.",
	},
	{
		id: "filesystem",
		label: "Filesystem",
		category: "Developer tools",
		tagline: "Read and write files in one folder",
		about: "The reference filesystem server, limited to the folder you choose. Reflex already has its own file tools inside the project; this is for giving agents access to another folder.",
		transport: { stdio: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{{FOLDER}}"] },
		fields: [{ key: "FOLDER", label: "Folder", placeholder: "/Users/you/projects", arg: true }],
		madeBy: { name: "Model Context Protocol", url: npm("@modelcontextprotocol/server-filesystem") },
		docsUrl: npm("@modelcontextprotocol/server-filesystem"),
	},
	{
		id: "ito-compute",
		label: "Itô compute",
		category: "Developer tools",
		tagline: "Itô cloud compute (build it first)",
		about: "Opt-in local Itô compute server (ito_auth, ito_find, ito_status, ito_accept). Its package is unpublished: build it from Ito-Markets/ito-cloud-runtime and point this connector at the built file.",
		transport: { stdio: "node", args: ["{{SCRIPT}}"] },
		fields: [{ key: "SCRIPT", label: "Path to ito-mcp.js", placeholder: "/path/to/ito-cloud-runtime/cli/ito-compute-cli/dist/bin/ito-mcp.js", arg: true }],
		madeBy: { name: "Itô Markets", url: "https://github.com/Ito-Markets" },
		note: "The package is unpublished; build it yourself first.",
	},
	{
		id: "jira",
		label: "Jira (API token)",
		category: "Project tracking",
		variantOf: "atlassian",
		method: "Jira API token (local)",
		tagline: "Jira through a local server",
		about: "Jira through the local mcp-atlassian server with an API token: search, create, update, comment on and transition issues. No browser sign-in; good for unattended agents.",
		transport: { stdio: "uvx", args: ["mcp-atlassian==0.21.0"] },
		keyEnv: "JIRA_API_TOKEN",
		fields: [
			{ key: "JIRA_URL", label: "Jira URL", placeholder: "https://your-team.atlassian.net" },
			{ key: "JIRA_EMAIL", label: "Account email", placeholder: "you@company.com" },
		],
		madeBy: { name: "mcp-atlassian", url: "https://pypi.org/project/mcp-atlassian/" },
		docsUrl: "https://pypi.org/project/mcp-atlassian/",
		note: "Needs uv (for `uvx`) on your PATH.",
	},
	{
		id: "confluence",
		label: "Confluence (API token)",
		category: "Project tracking",
		variantOf: "atlassian",
		method: "Confluence API token (local)",
		tagline: "Confluence through a local server",
		about: "Confluence Cloud through a local server with an API token: search pages, read content and explore spaces.",
		transport: { stdio: "npx", args: ["-y", "confluence-mcp-server"] },
		keyEnv: "CONFLUENCE_API_TOKEN",
		fields: [
			{ key: "CONFLUENCE_BASE_URL", label: "Confluence URL", placeholder: "https://your-team.atlassian.net/wiki" },
			{ key: "CONFLUENCE_EMAIL", label: "Account email", placeholder: "you@company.com" },
		],
		madeBy: { name: "confluence-mcp-server", url: npm("confluence-mcp-server") },
		docsUrl: npm("confluence-mcp-server"),
	},
];
