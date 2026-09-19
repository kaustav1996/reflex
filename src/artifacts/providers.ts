/**
 * Provider credentials for artifact deploys, resolved the way a local tool should: from the
 * logins this machine already has (gh, netlify, render CLIs) first, and from environment
 * tokens second (CI, or a future remote runner). Set ARTIFACTS_<PROVIDER>_AUTH=env to prefer
 * the environment for one provider.
 *
 *   gh       `gh auth token`                                         → GitHub
 *   netlify  <env-paths config>/netlify/config.json users[userId].auth.token
 *            (macOS ~/Library/Preferences/netlify, Linux ~/.config/netlify, legacy ~/.netlify)
 *   render   ~/.render/cli.yaml  api.key (+ workspace)               → Render
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { json } from "./http.js";

export type AuthSource = "cli" | "env";
export type ProviderName = "github" | "netlify" | "render";

export interface ProviderAuth {
	token: string;
	source: AuthSource;
	/** Account hint from the CLI config (Render workspace id, Netlify user email). */
	account?: string;
}

function preferEnv(provider: ProviderName): boolean {
	return /^(env|token)$/i.test(process.env[`ARTIFACTS_${provider.toUpperCase()}_AUTH`] ?? "");
}

function has(cmd: string): boolean {
	try {
		execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore", timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Netlify
// ---------------------------------------------------------------------------

export function netlifyConfigPaths(): string[] {
	if (process.env.REFLEX_NETLIFY_CONFIG) return [process.env.REFLEX_NETLIFY_CONFIG];
	const home = homedir();
	const out: string[] = [];
	if (platform() === "darwin") out.push(join(home, "Library", "Preferences", "netlify", "config.json"));
	if (platform() === "win32") out.push(join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "netlify", "Config", "config.json"));
	out.push(join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "netlify", "config.json"), join(home, ".netlify", "config.json"));
	return out;
}

export function netlifyCliAuth(): ProviderAuth | undefined {
	for (const file of netlifyConfigPaths()) {
		if (!existsSync(file)) continue;
		try {
			const cfg = JSON.parse(readFileSync(file, "utf8")) as { userId?: string; users?: Record<string, { email?: string; auth?: { token?: string } }> };
			const users = cfg.users ?? {};
			const pick = (cfg.userId && users[cfg.userId]) || Object.values(users).find((u) => u?.auth?.token);
			if (pick?.auth?.token) return { token: pick.auth.token, source: "cli", account: pick.email };
		} catch {}
	}
	return undefined;
}

export function resolveNetlify(): ProviderAuth | undefined {
	const env = process.env.NETLIFY_API_KEY || process.env.NETLIFY_AUTH_TOKEN;
	const fromEnv = env ? { token: env, source: "env" as const } : undefined;
	return preferEnv("netlify") ? (fromEnv ?? netlifyCliAuth()) : (netlifyCliAuth() ?? fromEnv);
}

/** Account slug: NETLIFY_ACCOUNT_SLUG, else the first account the token can see (personal first). */
export async function netlifyAccountSlug(token: string): Promise<string> {
	if (process.env.NETLIFY_ACCOUNT_SLUG) return process.env.NETLIFY_ACCOUNT_SLUG.split(/\s/)[0];
	const accounts = await json<Array<{ slug: string; type_name?: string; default?: boolean }>>("https://api.netlify.com/api/v1/accounts", { token });
	const pick = accounts.find((a) => a.default) ?? accounts[0];
	if (!pick) throw new Error("this Netlify login has no accounts");
	return pick.slug;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderConfigPath(): string {
	if (process.env.RENDER_CLI_CONFIG_PATH) return process.env.RENDER_CLI_CONFIG_PATH;
	return join(process.env.RENDER_CLI_CONFIG_DIR ?? join(homedir(), ".render"), "cli.yaml");
}

/** Minimal reader for the Render CLI's cli.yaml: top-level `workspace:` and `api: { key, expires_at }`. */
export function renderCliAuth(): (ProviderAuth & { expiresAt?: number }) | undefined {
	const file = renderConfigPath();
	if (!existsSync(file)) return undefined;
	let key = "";
	let workspace = "";
	let expiresAt: number | undefined;
	let inApi = false;
	for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "");
		if (!line.trim()) continue;
		const indented = /^\s/.test(line);
		const m = line.trim().match(/^([A-Za-z_]+):\s*(.*)$/);
		if (!m) continue;
		const [, k, vRaw] = m;
		const v = vRaw.trim().replace(/^["']|["']$/g, "");
		if (!indented) {
			inApi = k === "api";
			if (k === "workspace") workspace = v;
			continue;
		}
		if (inApi) {
			if (k === "key") key = v;
			if (k === "expires_at") expiresAt = Number(v) || undefined;
		}
	}
	if (!key) return undefined;
	if (expiresAt && expiresAt * (expiresAt < 1e12 ? 1000 : 1) < Date.now()) return undefined; // expired CLI token
	return { token: key, source: "cli", account: workspace || undefined, expiresAt };
}

export function resolveRender(): ProviderAuth | undefined {
	const fromEnv = process.env.RENDER_API_KEY ? { token: process.env.RENDER_API_KEY, source: "env" as const, account: process.env.RENDER_OWNER_ID } : undefined;
	return preferEnv("render") ? (fromEnv ?? renderCliAuth()) : (renderCliAuth() ?? fromEnv);
}

/** Owner id: RENDER_OWNER_ID, else the CLI's active workspace, else the first team (then user) the token can see. */
export async function renderOwnerId(auth: ProviderAuth): Promise<string> {
	if (process.env.RENDER_OWNER_ID) return process.env.RENDER_OWNER_ID.split(/\s/)[0];
	if (auth.account?.startsWith("tea-") || auth.account?.startsWith("usr-")) return auth.account;
	const owners = await json<Array<{ owner: { id: string; type: string; name?: string } }>>("https://api.render.com/v1/owners?limit=20", { token: auth.token });
	const pick = owners.find((o) => o.owner.type === "team") ?? owners[0];
	if (!pick) throw new Error("this Render login has no workspaces");
	return pick.owner.id;
}

// ---------------------------------------------------------------------------
// CLI status and login flows
// ---------------------------------------------------------------------------

export interface CliStatus {
	provider: ProviderName;
	cli: string;
	installed: boolean;
	loggedIn: boolean;
	account?: string;
	/** Command a person runs in a terminal to log in. */
	login: string;
	/** How to install the CLI when it is missing. */
	install: string;
	/** Whether the login command works without a terminal (can be run by the agent directly). */
	headless: boolean;
}

export function cliStatuses(githubAuth?: { source: string; login?: string }): CliStatus[] {
	const netlify = netlifyCliAuth();
	const render = renderCliAuth();
	const netlifyInstalled = has("netlify");
	return [
		{ provider: "github", cli: "gh", installed: has("gh"), loggedIn: githubAuth?.source === "gh", account: githubAuth?.source === "gh" ? githubAuth.login : undefined, login: "gh auth login --web", install: "brew install gh", headless: false },
		{ provider: "netlify", cli: "netlify", installed: netlifyInstalled, loggedIn: !!netlify, account: netlify?.account, login: netlifyInstalled ? "netlify login" : "npx -y netlify-cli login", install: "npm install -g netlify-cli", headless: true },
		{ provider: "render", cli: "render", installed: has("render"), loggedIn: !!render, account: render?.account, login: "render login", install: "brew install render", headless: false },
	];
}

/**
 * Start a CLI login. Headless-capable commands (netlify) run directly and resolve when they exit.
 * The others need a real terminal: on macOS we open Terminal.app with the command; elsewhere we
 * return the command for the person to run. Either way the caller polls `cliStatuses()`.
 */
export function startCliLogin(provider: ProviderName, log: (line: string) => void = () => {}): { started: boolean; command: string; how: "spawned" | "terminal" | "manual" } {
	const st = cliStatuses().find((s) => s.provider === provider)!;
	const command = st.login;
	if (st.headless) {
		const [cmd, ...args] = command.split(/\s+/);
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "" }, detached: false });
		child.stdout?.on("data", (d) => log(String(d).trim()));
		child.stderr?.on("data", (d) => log(String(d).trim()));
		child.on("exit", (code) => log(`${command} exited with ${code}`));
		return { started: true, command, how: "spawned" };
	}
	if (platform() === "darwin") {
		try {
			const script = `tell application "Terminal"\nactivate\ndo script "${command.replace(/"/g, '\\"')}"\nend tell`;
			execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 8000 });
			return { started: true, command, how: "terminal" };
		} catch {}
	}
	return { started: false, command, how: "manual" };
}

/** Poll until the provider reports a login (or the timeout passes). */
export async function waitForCliLogin(provider: ProviderName, githubProbe: () => { source: string; login?: string } | undefined, timeoutMs = 4 * 60_000): Promise<CliStatus> {
	const t0 = Date.now();
	for (;;) {
		const st = cliStatuses(githubProbe())!.find((s) => s.provider === provider)!;
		if (st.loggedIn || Date.now() - t0 > timeoutMs) return st;
		await new Promise((r) => setTimeout(r, 3000));
	}
}
