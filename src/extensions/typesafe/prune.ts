/**
 * Pruning a long session instead of summarising it.
 *
 * Compaction replaces a transcript with a paraphrase, and a paraphrase loses the exact things an
 * agent needs: the path, the line number, the flag it discovered three turns ago. Most of a long
 * session isn't prose, though — it's stale tool output that mattered once and never again. Dropping
 * that frees far more room than summarising does, and loses nothing anyone can name.
 *
 * So: prune first, summarise only if pruning cannot free enough.
 *
 * What is never pruned:
 *   - every user message and every assistant message, word for word;
 *   - the most recent tool results, which the next turn is probably still working from;
 *   - anything small enough that dropping it saves nothing.
 *
 * A pruned result keeps its tool call and leaves a marker in place of the output, so the model can
 * see that the command ran and run it again if it turns out to matter. Nothing is deleted from the
 * session file: this changes only what a given request carries.
 */

/**
 * Below this total size, pruning is not worth a Jev call. Trimming (which runs first, on each
 * result) keeps most sessions under it, which is the intended order: the cheaper mechanism first.
 * `REFLEX_PRUNE_MIN_CHARS` lowers it for testing and tuning.
 */
export const PRUNE_MIN_CONTEXT_CHARS = Number(process.env.REFLEX_PRUNE_MIN_CHARS ?? 60000);
/** Recent tool results the next turn is probably still using. */
export const KEEP_RECENT_RESULTS = 6;
/** A result smaller than this frees nothing worth asking about. */
export const MIN_RESULT_CHARS = 500;
/** Results judged in one request. */
export const MAX_PRUNE_CANDIDATES = 12;

export interface Message {
	role: string;
	toolCallId?: string;
	toolName?: string;
	content?: Array<{ type: string; text?: string }> | string;
	[k: string]: unknown;
}

export interface Candidate {
	toolCallId: string;
	toolName: string;
	index: number;
	chars: number;
	text: string;
}

export function messageChars(m: Message): number {
	if (typeof m.content === "string") return m.content.length;
	return (m.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0);
}

export function contextChars(messages: Message[]): number {
	return messages.reduce((n, m) => n + messageChars(m), 0);
}

export function textOf(m: Message): string {
	if (typeof m.content === "string") return m.content;
	return (m.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text as string).join("\n");
}

/**
 * Tool results old enough and big enough to be worth asking about, newest first so the most
 * valuable candidates survive the cap.
 */
export function selectCandidates(messages: Message[], opts: { keepRecent?: number; minChars?: number; max?: number; already?: Set<string> } = {}): Candidate[] {
	const keepRecent = opts.keepRecent ?? KEEP_RECENT_RESULTS;
	const minChars = opts.minChars ?? MIN_RESULT_CHARS;
	const results: Candidate[] = [];
	messages.forEach((m, index) => {
		if (m.role !== "toolResult" || !m.toolCallId) return;
		results.push({ toolCallId: m.toolCallId, toolName: m.toolName ?? "tool", index, chars: messageChars(m), text: textOf(m) });
	});
	const old = results.slice(0, Math.max(0, results.length - keepRecent));
	return old
		.filter((c) => c.chars >= minChars && !opts.already?.has(c.toolCallId))
		.sort((a, b) => b.chars - a.chars)
		.slice(0, opts.max ?? MAX_PRUNE_CANDIDATES);
}

export const PRUNED_MARKER = (toolName: string, chars: number) =>
	`[reflex: the output of this earlier ${toolName} call was pruned from this request to save context (${chars} characters). It is still in the session; run the command again if you need it.]`;

export interface PruneResult {
	messages: Message[];
	dropped: number;
	charsFreed: number;
}

/** Replace the content of the named tool results with a marker. User and assistant turns are untouched. */
export function applyPrune(messages: Message[], drop: Set<string>): PruneResult {
	let dropped = 0;
	let charsFreed = 0;
	const out = messages.map((m) => {
		if (m.role !== "toolResult" || !m.toolCallId || !drop.has(m.toolCallId)) return m;
		const chars = messageChars(m);
		const marker = PRUNED_MARKER(m.toolName ?? "tool", chars);
		if (marker.length >= chars) return m; // a marker longer than the output frees nothing
		dropped++;
		charsFreed += chars - marker.length;
		return { ...m, content: [{ type: "text", text: marker }] };
	});
	return { messages: out, dropped, charsFreed };
}

/**
 * A transcript rebuilt by pruning rather than paraphrasing: every user and assistant message word
 * for word, and one line per tool call saying what ran and how much output was dropped.
 *
 * This is what replaces an LLM summary when pruning frees enough room. It is longer than a summary
 * and that is the point — nothing in it was invented.
 */
export function reconstruct(messages: Message[], opts: { keepResultChars?: number } = {}): string {
	const keep = opts.keepResultChars ?? 400;
	const lines: string[] = ["[reflex: the earlier part of this session, with stale tool output removed. Nothing below is a summary: every message is verbatim.]", ""];
	for (const m of messages) {
		if (m.role === "user") lines.push(`USER: ${textOf(m)}`, "");
		else if (m.role === "assistant") {
			const text = textOf(m).trim();
			if (text) lines.push(`ASSISTANT: ${text}`, "");
			const calls = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "toolCall") as Array<{ name?: string; arguments?: unknown }>;
			for (const c of calls) lines.push(`  → ran ${c.name ?? "tool"} ${JSON.stringify(c.arguments ?? {}).slice(0, 160)}`);
		} else if (m.role === "toolResult") {
			const text = textOf(m);
			lines.push(text.length <= keep ? `  ← ${m.toolName}: ${text}` : `  ← ${m.toolName}: ${text.slice(0, keep)}\n     [${text.length - keep} more characters pruned]`);
		}
	}
	return lines.join("\n");
}
