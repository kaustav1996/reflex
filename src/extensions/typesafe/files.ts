/**
 * Pointing the agent at the files a task is about.
 *
 * Starting a task in an unfamiliar repo costs several turns of looking around: grep, list, read,
 * read again. The paths themselves carry most of the signal, so a shortlist by word overlap followed
 * by one Jev request — a noul per candidate, all against the same state — can name the handful worth
 * opening first.
 *
 * It stays quiet when it has nothing to add: a request that already names a file, a small repo
 * where looking around is cheap anyway, or a shortlist nothing scores well on. A wrong hint costs
 * the model a wasted read, so the bar is set where a hint has to be worth that.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Files that are never worth suggesting: generated, vendored, or not source. */
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|vendor|__pycache__)\//;
const SKIP_FILE = /(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|wav|woff2?)$)/i;

/** Below this many files, the agent can look around for itself more cheaply than Jev can advise. */
export const MIN_REPO_FILES = 40;
/** Candidates put to Jev in one request. */
export const MAX_FILE_CANDIDATES = 20;
/**
 * The winning file is named only at or above this. Measured by replaying this repo's commits:
 * above 0.6 the pick is right 3 times in 4, and it speaks on about a third of tasks. Below that it
 * is a coin flip, and a wrong hint anchors the model on the wrong file.
 */
export const FILE_HINT_THRESHOLD = 0.6;

export function trackedFiles(cwd: string): string[] {
	try {
		return execFileSync("git", ["-C", cwd, "ls-files"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5000 })
			.split("\n")
			.filter((f) => f.trim() && !SKIP.test(f) && !SKIP_FILE.test(f));
	} catch {
		return [];
	}
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "add", "fix", "use", "make", "run", "can", "you", "please", "now", "then", "when", "what", "why", "how", "it", "is", "to", "in", "of", "a", "an", "on", "my", "me"]);
const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/** Does the request already name a tracked file? Then it needs no help finding one. */
export function namesAFile(request: string, files: string[]): boolean {
	const tokens = request.toLowerCase().match(/[\w./-]{4,}/g) ?? [];
	return files.some((f) => {
		const lower = f.toLowerCase();
		const base = lower.split("/").pop() ?? lower;
		return tokens.some((t) => t === lower || t === base || (t.includes("/") && lower.includes(t)));
	});
}

/** The candidates worth asking about: paths sharing the most words with the request. */
export function shortlistFiles(files: string[], request: string, max = MAX_FILE_CANDIDATES): string[] {
	const req = new Set(words(request));
	if (!req.size) return [];
	const score = (f: string) => {
		const parts = words(f.replace(/[/_-]/g, " "));
		let n = 0;
		for (const w of parts) if (req.has(w)) n += 1;
		// The file's own name says more about it than the folders above it.
		const base = words((f.split("/").pop() ?? "").replace(/[_-]/g, " "));
		for (const w of base) if (req.has(w)) n += 2;
		return n;
	};
	return files
		.map((f) => ({ f, s: score(f) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s || a.f.length - b.f.length)
		.slice(0, max)
		.map((x) => x.f);
}

/** The first lines of a file, which usually say what it is. */
export function head(cwd: string, file: string, lines = 12): string {
	try {
		const path = join(cwd, file);
		if (!existsSync(path) || statSync(path).size > 400_000) return "";
		return readFileSync(path, "utf8").split("\n").slice(0, lines).join("\n").slice(0, 900);
	} catch {
		return "";
	}
}

/** A question id Jev can carry: paths have characters that answer keys shouldn't. */
export function fieldFor(file: string): string {
	return `file_${file.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 60);
}

/** The file to name, if any: the Choice's winner, when it isn't "none" and clears the bar. */
export function pickFile(answer: { choice: string; probabilities?: Record<string, number>; confidence: number } | undefined, shortlist: string[], threshold = FILE_HINT_THRESHOLD): { file: string; score: number } | undefined {
	if (!answer || answer.choice === "none" || !shortlist.includes(answer.choice)) return undefined;
	const score = answer.probabilities?.[answer.choice] ?? answer.confidence;
	return score >= threshold ? { file: answer.choice, score } : undefined;
}
