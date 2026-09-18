/**
 * Credential store: pure helpers for writing secrets to dotenv files, masking them for the
 * transcript, redacting them from tool output, and keeping them out of git.
 *
 * No secret value ever goes back to the model: callers get a `preview` (first 3 + last 2
 * characters) and a length, nothing else.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { getReflexHome } from "../../config.js";

export const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
	return ENV_NAME.test(name) && name.length <= 80;
}

/** Names that look like credentials; values under these names are redacted from tool output. */
export const SECRET_LIKE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|DSN|_URL$)/i;

export type Destination = "project" | "global" | string;

/**
 * Resolve where a secret goes.
 * - `project` (default): `<cwd>/.env`
 * - `global`: `~/.reflex/.env` (loaded by every Reflex session)
 * - a dotenv-style path relative to cwd (`.env.local`, `apps/api/.env`); must stay inside cwd.
 */
export function resolveDestination(dest: Destination | undefined, cwd: string): { file: string; label: string } {
	const d = (dest ?? "project").trim();
	if (d === "project" || d === "" || d === ".env") return { file: resolve(cwd, ".env"), label: ".env" };
	if (d === "global" || d === "reflex") return { file: resolve(getReflexHome(), ".env"), label: "~/.reflex/.env" };
	const file = isAbsolute(d) ? d : resolve(cwd, d);
	const rel = relative(cwd, file);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`destination must be inside the project (${cwd}): ${d}`);
	const base = basename(file);
	if (!(base.startsWith(".env") || base.endsWith(".env"))) throw new Error(`destination must be a dotenv-style file (.env, .env.local, …): ${d}`);
	return { file, label: rel };
}

function quoteValue(value: string): string {
	if (/^[A-Za-z0-9_./:@+=,-]*$/.test(value)) return value;
	if (!value.includes("'") && !value.includes("\n")) return `'${value}'`;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Insert or replace `NAME=value` in dotenv text, preserving everything else. */
export function upsertDotenv(text: string, name: string, value: string): { text: string; replaced: boolean } {
	const line = `${name}=${quoteValue(value)}`;
	const lines = text.length ? text.split(/\r?\n/) : [];
	const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
	let replaced = false;
	const out = lines.map((l) => {
		if (!replaced && re.test(l)) {
			replaced = true;
			return line;
		}
		return l;
	});
	if (!replaced) {
		if (out.length && out[out.length - 1] !== "") out.push(line);
		else if (out.length) out.splice(out.length - 1, 0, line);
		else out.push(line);
	}
	let joined = out.join("\n");
	if (!joined.endsWith("\n")) joined += "\n";
	return { text: joined, replaced };
}

/** Write one secret to a dotenv file (created 0600 if missing). */
export function writeSecret(file: string, name: string, value: string): { replaced: boolean; created: boolean } {
	const created = !existsSync(file);
	mkdirSync(dirname(file), { recursive: true });
	const current = created ? "" : readFileSync(file, "utf8");
	const { text, replaced } = upsertDotenv(current, name, value);
	writeFileSync(file, text, { mode: 0o600 });
	return { replaced, created };
}

/** Names defined in a dotenv file (no values). */
export function dotenvNames(file: string): string[] {
	if (!existsSync(file)) return [];
	const names: string[] = [];
	for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
		const l = raw.trim();
		if (!l || l.startsWith("#")) continue;
		const eq = l.indexOf("=");
		if (eq <= 0) continue;
		names.push(l.slice(0, eq).trim().replace(/^export\s+/, ""));
	}
	return names;
}

/** Name → value pairs of a dotenv file whose names look like credentials (for redaction only). */
export function dotenvSecretValues(file: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!existsSync(file)) return out;
	for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
		const l = raw.trim();
		if (!l || l.startsWith("#")) continue;
		const eq = l.indexOf("=");
		if (eq <= 0) continue;
		const name = l.slice(0, eq).trim().replace(/^export\s+/, "");
		let value = l.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		if (SECRET_LIKE.test(name) && value.length >= 8) out.set(name, value);
	}
	return out;
}

/** What the model is allowed to see about a value. */
export function maskSecret(value: string): string {
	if (value.length >= 12) return `${value.slice(0, 3)}…${value.slice(-2)}`;
	return `${"•".repeat(Math.min(value.length, 8))}`;
}

/** Replace every known secret value in text with `[REDACTED:NAME]`. Longest values first so prefixes don't leave fragments. */
export function redactSecrets(text: string, secrets: Map<string, string>): string {
	if (!text || secrets.size === 0) return text;
	let out = text;
	const entries = [...secrets.entries()].filter(([, v]) => v.length >= 6).sort((a, b) => b[1].length - a[1].length);
	for (const [name, value] of entries) {
		if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
	}
	return out;
}

/**
 * Make sure a dotenv file under a git repo is ignored, and report if it is already tracked.
 * Returns what was done so the tool result can say it.
 */
export function protectFromGit(file: string, cwd: string): { ignored?: boolean; added?: boolean; tracked?: boolean } {
	const rel = relative(cwd, file);
	if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(resolve(cwd, ".git"))) return {};
	const out: { ignored?: boolean; added?: boolean; tracked?: boolean } = {};
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd, stdio: "ignore" });
		out.tracked = true;
	} catch {
		out.tracked = false;
	}
	try {
		execFileSync("git", ["check-ignore", "-q", rel], { cwd, stdio: "ignore" });
		out.ignored = true;
		return out;
	} catch {
		out.ignored = false;
	}
	const gi = resolve(cwd, ".gitignore");
	const pattern = basename(file) === ".env" ? ".env" : rel;
	try {
		const current = existsSync(gi) ? readFileSync(gi, "utf8") : "";
		if (!current.split(/\r?\n/).some((l) => l.trim() === pattern)) {
			writeFileSync(gi, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
			out.added = true;
			out.ignored = true;
		}
	} catch {}
	return out;
}
