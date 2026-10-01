/**
 * Trimming long tool output before the model reads it.
 *
 * A 2,000-line test log or `find` dump is read once by the model and then re-read on every later
 * turn, because it stays in the transcript. Input tokens are most of a session's cost, so this is
 * where the money is.
 *
 * What is never dropped, whatever Jev says:
 *   - the head and the tail, which carry the command, the summary line and the exit status;
 *   - any line that looks like an error, a failure or a diff;
 *   - anything at all, if the output is small enough that trimming would save nothing.
 *
 * Everything else is cut into chunks and judged in one Jev call — one noul per chunk, all against
 * the same state, so the task and command are charged once rather than once per chunk. Dropped
 * chunks are replaced by a marker that says how many lines went and where the full output is, so
 * the model can read it when it turns out to matter.
 *
 * Nothing is destroyed: the complete output is written to ~/.reflex/logs/tool-output/ first.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReflexHome } from "../../config.js";

/** Below this, trimming saves less than the call costs. */
export const TRIM_MIN_CHARS = 4000;
/** Lines kept at each end, untouched. */
export const KEEP_HEAD = 20;
export const KEEP_TAIL = 15;
/** Lines per chunk offered to Jev. */
export const CHUNK_LINES = 40;
/** At most this many chunks per call; longer output keeps its head and tail and drops the middle. */
export const MAX_CHUNKS = 12;

/** Lines worth keeping whatever a model thinks of the chunk around them. */
export const ALWAYS_KEEP = /\b(error|fail(ed|ure)?|exception|traceback|panic|fatal|refused|denied|timed? ?out|cannot|not found|undefined|null pointer|segfault|assert)\b|^[+-]{1,3}\s|^\s*at .*\(.*:\d+:\d+\)/i;

export interface Chunk {
	index: number;
	/** 1-based line range in the original output. */
	from: number;
	to: number;
	text: string;
	/** True when the chunk holds a line that is kept regardless. */
	pinned: boolean;
}

export interface TrimPlan {
	/** Nothing to do: too short, or too few lines to be worth a call. */
	skip: boolean;
	head: string[];
	tail: string[];
	chunks: Chunk[];
	totalLines: number;
}

export function planTrim(text: string, opts: { minChars?: number } = {}): TrimPlan {
	const lines = text.split("\n");
	const minChars = opts.minChars ?? TRIM_MIN_CHARS;
	if (text.length < minChars || lines.length <= KEEP_HEAD + KEEP_TAIL + CHUNK_LINES) {
		return { skip: true, head: lines, tail: [], chunks: [], totalLines: lines.length };
	}
	const head = lines.slice(0, KEEP_HEAD);
	const tail = lines.slice(lines.length - KEEP_TAIL);
	const middle = lines.slice(KEEP_HEAD, lines.length - KEEP_TAIL);
	const chunks: Chunk[] = [];
	// Longer output than MAX_CHUNKS covers is chunked coarsely rather than partly judged.
	const perChunk = Math.max(CHUNK_LINES, Math.ceil(middle.length / MAX_CHUNKS));
	for (let i = 0; i < middle.length; i += perChunk) {
		const slice = middle.slice(i, i + perChunk);
		chunks.push({
			index: chunks.length,
			from: KEEP_HEAD + i + 1,
			to: KEEP_HEAD + i + slice.length,
			text: slice.join("\n"),
			pinned: slice.some((l) => ALWAYS_KEEP.test(l)),
		});
	}
	return { skip: false, head, tail, chunks, totalLines: lines.length };
}

export interface TrimResult {
	text: string;
	droppedLines: number;
	droppedChars: number;
	keptChunks: number;
	droppedChunks: number;
	savedPath?: string;
}

/**
 * Rebuild the output from the chunks that stay. `keep(chunk)` decides; a pinned chunk is kept
 * whatever it answers, which is why the needles (errors, diffs) survive a bad judgement.
 */
export function applyTrim(original: string, plan: TrimPlan, keep: (c: Chunk) => boolean, savedPath?: string): TrimResult {
	if (plan.skip) return { text: original, droppedLines: 0, droppedChars: 0, keptChunks: 0, droppedChunks: 0 };
	const parts: string[] = [plan.head.join("\n")];
	let droppedLines = 0;
	let droppedChars = 0;
	let kept = 0;
	let dropped = 0;
	let run: Chunk[] = [];
	const flush = () => {
		if (!run.length) return;
		const lines = run.reduce((n, c) => n + (c.to - c.from + 1), 0);
		const chars = run.reduce((n, c) => n + c.text.length, 0);
		droppedLines += lines;
		droppedChars += chars;
		dropped += run.length;
		parts.push(`[reflex: ${lines} lines trimmed (${run[0].from}–${run[run.length - 1].to})${savedPath ? `; full output: ${savedPath}` : ""}]`);
		run = [];
	};
	for (const c of plan.chunks) {
		if (c.pinned || keep(c)) {
			flush();
			parts.push(c.text);
			kept++;
		} else {
			run.push(c);
		}
	}
	flush();
	parts.push(plan.tail.join("\n"));
	return { text: parts.join("\n"), droppedLines, droppedChars, keptChunks: kept, droppedChunks: dropped, savedPath };
}

/** Keep the whole output on disk before anything is cut, and return the path to show the model. */
export function saveFullOutput(tool: string, text: string): string | undefined {
	try {
		const dir = join(getReflexHome(), "logs", "tool-output");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tool.replace(/[^a-z0-9]/gi, "_")}.txt`);
		writeFileSync(path, text);
		return path;
	} catch {
		return undefined;
	}
}

/** Rough and deliberately conservative: enough to report savings, not to bill anyone. */
export function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
