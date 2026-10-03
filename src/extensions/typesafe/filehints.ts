/**
 * Naming the file a task is most likely about, when that can be done well enough to be worth it.
 *
 * Off by default, and the measurement is why: replaying this repo's own commits (the subject as the
 * task, the files it changed as the answer, judged against the tree before the commit), the pick is
 * right about three times in four above the threshold — and it only has something to say on about a
 * third of tasks. A wrong hint anchors the model on the wrong file, which is worse than saying
 * nothing, so this stays something you turn on deliberately.
 *
 * It also stays quiet when it has nothing to add: a request that already names a file, a repo small
 * enough to look around in, or a shortlist that shares no words with the request.
 */
import { logDecision } from "../../logs/decisions.js";
import { buildFileChoiceQuestion } from "./policy.js";
import { clip } from "./context.js";
import { FILE_HINT_THRESHOLD, fieldFor, head, MAX_FILE_CANDIDATES, MIN_REPO_FILES, namesAFile, pickFile, shortlistFiles, trackedFiles } from "./files.js";
import type { ReflexState } from "./state.js";

export async function fileHint(state: ReflexState, prompt: string, cwd: string): Promise<string> {
	if (state.config.reflex.fileHints !== true || !state.client) return "";
	const files = trackedFiles(cwd);
	if (files.length < MIN_REPO_FILES) return "";
	if (namesAFile(prompt, files)) return "";
	const shortlist = shortlistFiles(files, prompt, MAX_FILE_CANDIDATES);
	if (shortlist.length < 2) return "";

	const criteria: Record<string, string> = {};
	for (const f of shortlist) {
		const first = head(cwd, f, 6).split("\n").filter((l) => l.trim()).slice(0, 3).join(" ");
		criteria[f] = `${f}${first ? ` — ${clip(first, 200)}` : ""}`;
	}
	try {
		const res = await state.client.systemOne({
			purpose: "files",
			state: { task: clip(prompt, 1500) },
			questions: { where: buildFileChoiceQuestion(criteria) },
			timeoutMs: state.config.reflex.timeoutMs,
		});
		const answer = res.answers.where;
		const picked = pickFile(answer, shortlist);
		state.record("files", picked ? `${picked.file} (${Math.round(picked.score * 100)}%)` : `nothing above the bar (${answer.choice} ${Math.round(answer.confidence * 100)}%)`);
		logDecision({
			source: "files",
			model: res.model,
			action: picked ? "hint" : "quiet",
			summary: picked ? picked.file : `${shortlist.length} candidates, none clear enough`,
			signals: { where: { primitive: "choice", value: answer.probabilities?.[answer.choice] ?? answer.confidence, pick: answer.choice, confidence: answer.confidence, threshold: FILE_HINT_THRESHOLD } },
			detail: { candidates: shortlist.length, repoFiles: files.length },
		});
		return picked ? `The work probably starts in ${picked.file} (${Math.round(picked.score * 100)}%); check before trusting it.` : "";
	} catch (err) {
		state.degradedReason = err instanceof Error ? err.message : String(err);
		return "";
	}
}
