/**
 * GitHub: Render can only build from a git repo (or a registry image), so a fullstack artifact's
 * code is pushed to a repo named reflex-artifact-<slug>.
 *
 * Reflex runs on your machine, so it uses the GitHub login your machine already has: the `gh`
 * CLI (`gh auth login`) comes first. Environment tokens (GITHUB_TOKEN, then GITHUB_ORG_TOKEN)
 * are the fallback for CI or a future remote runner; set ARTIFACTS_GITHUB_AUTH=env to prefer
 * them even when gh is logged in. The repo owner is the authenticated user unless
 * ARTIFACTS_GITHUB_OWNER names an org (GITHUB_ORG is honoured only with GITHUB_ORG_TOKEN).
 * The repo is public unless ARTIFACTS_REPO_PRIVATE=true — Render only reads private repos when
 * its GitHub app is connected.
 *
 * What gets pushed: the artifact folder minus node_modules, .git, build output, .env* and other
 * secrets. Never the .env.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError, json } from "./http.js";

const API = "https://api.github.com";
const EXCLUDES = ["node_modules", ".git", "dist", "build", "out", ".next", ".svelte-kit", ".env", ".env.*", "*.db", "*.db-wal", "*.db-shm", "*.sqlite", ".DS_Store", ".reflex-build", "__pycache__", ".venv", "venv"];

export interface GithubAuth {
	token: string;
	source: "GITHUB_TOKEN" | "GITHUB_ORG_TOKEN" | "gh";
}

function ghToken(): GithubAuth | undefined {
	try {
		const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
		if (t) return { token: t, source: "gh" };
	} catch {}
	return undefined;
}

function envToken(): GithubAuth | undefined {
	if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
	if (process.env.GITHUB_ORG_TOKEN) return { token: process.env.GITHUB_ORG_TOKEN, source: "GITHUB_ORG_TOKEN" };
	return undefined;
}

export function githubAuth(): GithubAuth | undefined {
	const preferEnv = /^(env|token)$/i.test(process.env.ARTIFACTS_GITHUB_AUTH ?? "");
	return preferEnv ? (envToken() ?? ghToken()) : (ghToken() ?? envToken());
}

/** The login `gh` is signed in as, for status displays. */
export function ghLogin(): string | undefined {
	try {
		const out = execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

export class Github {
	constructor(
		private token: string,
		public owner?: string,
	) {}

	static async fromEnv(): Promise<{ gh: Github; source: GithubAuth["source"] }> {
		const auth = githubAuth();
		if (!auth) throw new Error("backend deploys push the code Render builds to a GitHub repo: run `gh auth login` on this machine (or set GITHUB_TOKEN for CI)");
		const owner = process.env.ARTIFACTS_GITHUB_OWNER || (auth.source === "GITHUB_ORG_TOKEN" ? process.env.GITHUB_ORG : undefined) || undefined;
		const gh = new Github(auth.token, owner);
		if (!gh.owner) gh.owner = (await json<{ login: string }>(`${API}/user`, { token: gh.token })).login;
		return { gh, source: auth.source };
	}

	repoName(slug: string): string {
		return `reflex-artifact-${slug}`;
	}

	async ensureRepo(slug: string, priv: boolean): Promise<{ url: string; name: string; private: boolean; created: boolean }> {
		const name = this.repoName(slug);
		try {
			const r = await json<{ html_url: string; private: boolean }>(`${API}/repos/${this.owner}/${name}`, { token: this.token });
			return { url: r.html_url, name, private: r.private, created: false };
		} catch (err) {
			if (!(err instanceof HttpError && err.status === 404)) throw err;
		}
		const isOrg = !!(process.env.ARTIFACTS_GITHUB_OWNER || process.env.GITHUB_ORG) && this.owner !== (await json<{ login: string }>(`${API}/user`, { token: this.token }).catch(() => ({ login: "" }))).login;
		const r = await json<{ html_url: string; private: boolean }>(isOrg ? `${API}/orgs/${this.owner}/repos` : `${API}/user/repos`, {
			method: "POST",
			token: this.token,
			body: JSON.stringify({ name, private: priv, description: `Reflex artifact "${slug}" — deployed backend source`, auto_init: false }),
		});
		return { url: r.html_url, name, private: r.private, created: true };
	}

	async deleteRepo(slug: string): Promise<void> {
		try {
			await json(`${API}/repos/${this.owner}/${this.repoName(slug)}`, { method: "DELETE", token: this.token });
		} catch (err) {
			if (!(err instanceof HttpError && (err.status === 404 || err.status === 403))) throw err;
		}
	}

	/**
	 * Push a snapshot of `dir` to the repo's main branch from a fresh temporary clone (never the
	 * user's own .git). Returns the commit sha.
	 */
	pushSnapshot(dir: string, repoUrl: string, message: string, log: (line: string) => void): string {
		const tmp = mkdtempSync(join(tmpdir(), "reflex-artifact-"));
		const authUrl = repoUrl.replace(/^https:\/\//, `https://x-access-token:${this.token}@`) + (repoUrl.endsWith(".git") ? "" : ".git");
		const scrub = (s: string) => s.split(this.token).join("***");
		const run = (args: string[], cwd = tmp) => {
			const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 240_000 });
			if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${scrub((r.stderr || r.stdout || "").trim().slice(-400))}`);
			return r.stdout.trim();
		};
		try {
			const rs = spawnSync("rsync", ["-a", ...EXCLUDES.flatMap((e) => ["--exclude", e]), `${dir.replace(/\/$/, "")}/`, `${tmp}/`], { encoding: "utf8" });
			if (rs.status !== 0) throw new Error(`copying the app failed: ${rs.stderr}`);
			run(["init", "-q", "-b", "main"]);
			run(["-c", "user.name=reflex", "-c", "user.email=reflex@localhost", "add", "-A"]);
			const changed = spawnSync("git", ["-c", "user.name=reflex", "-c", "user.email=reflex@localhost", "commit", "-q", "-m", message], { cwd: tmp, encoding: "utf8" });
			if (changed.status !== 0) throw new Error(`nothing to commit in ${dir}: ${changed.stderr || changed.stdout}`);
			const sha = run(["rev-parse", "HEAD"]);
			run(["remote", "add", "origin", authUrl]);
			let lastErr = "";
			for (let i = 0; i < 3; i++) {
				const r = spawnSync("git", ["push", "-q", "--force", "origin", "HEAD:refs/heads/main"], { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 240_000 });
				if (r.status === 0) {
					log(`pushed ${sha.slice(0, 7)} to ${repoUrl}`);
					return sha;
				}
				lastErr = scrub((r.stderr || r.stdout || "").trim().slice(-400));
				log(`push attempt ${i + 1} failed: ${lastErr}`);
				spawnSync("sleep", ["5"]);
			}
			throw new Error(`git push failed: ${lastErr}`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}
