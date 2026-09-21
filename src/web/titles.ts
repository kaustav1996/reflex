/**
 * Readable session titles for the sidebar. A session is titled by what was first asked in it
 * (or by the name the user gave it), never by its folder or its file name.
 */

const MAX = 72;

/** One line of plain text from a prompt: no markdown noise, no attachments, no slash commands. */
export function cleanTitle(text: string | undefined | null): string | undefined {
	if (!text) return undefined;
	const lines = text
		.replace(/```[\s\S]*?```/g, " ") // fenced code is never a title
		.replace(/<file[\s\S]*?<\/file>/g, " ") // attached files
		.split("\n")
		.map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim())
		.filter((l) => l && !l.startsWith("/"));
	const first = lines[0];
	if (!first) return undefined;
	const titled = first[0].toUpperCase() + first.slice(1);
	if (titled.length <= MAX) return titled;
	const cut = titled.slice(0, MAX);
	const space = cut.lastIndexOf(" ");
	return `${(space > MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:!?\s]+$/, "")}…`;
}

/** The folder name shown as the project header. */
export function projectName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}
