/**
 * How replies are shown: the terminal and `reflex web` render markdown (paragraphs, lists, code
 * blocks, **bold**, `code`), not HTML. Some models otherwise reach for chat-app markup such as
 * <details><summary>…</summary></details>, which shows up as raw tags.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FORMAT_NOTE = "\n\nReply formatting: this interface renders markdown (paragraphs, lists, fenced code blocks, **bold**, `inline code`), not HTML. Do not write HTML tags such as <details>, <summary> or <div> in replies; use a short heading or a list instead.";

export function createFormatExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("before_agent_start", async (event) => (event.systemPrompt.includes(FORMAT_NOTE) ? undefined : { systemPrompt: event.systemPrompt + FORMAT_NOTE }));
	};
}
