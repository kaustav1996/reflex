/**
 * Branding in the spirit of typesafe.ai: retro system-window chrome, monospace,
 * off-white on near-black with the pink accent. Header, title and theme bootstrap.
 */
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piVersion } from "../../brand.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BRAND, BRAND_TAGLINE, type ReflexConfig } from "../../config.js";

export function createUiExtension(config: ReflexConfig, version: string): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.setTitle(`${BRAND.toLowerCase()} — ${basename(ctx.cwd)}`);
			ctx.ui.setHeader((_tui, theme) => ({
				render(width: number): string[] {
					const w = Math.max(48, Math.min(width, 76));
					const inner = w - 2;
					const light = config.ui.theme.endsWith("light");
					// typesafe.ai palette, truecolor: pink blocks with near-black type; borders in the theme's border color.
					const PINK = "\x1b[48;2;243;134;161m\x1b[38;2;30;30;30m";
					const INK_ON_PAPER = light ? "\x1b[38;2;30;30;30m" : "\x1b[38;2;254;254;254m";
					const RESET = "\x1b[0m";
					const fg = (c: Parameters<typeof theme.fg>[0], s: string) => theme.fg(c, s);
					const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
					const row = (s: string) => `${fg("border", "│")}${pad(s)}${fg("border", "│")}`;
					// Title bar: solid pink block, striped ends, like a System 1 window on the site's pink hero.
					const tag = ` ${BRAND.toUpperCase()} ${version} `;
					const stripeLen = Math.max(0, inner - visibleWidth(tag));
					const left = Math.floor(stripeLen / 2);
					const stripe = (n: number) => `${PINK}${"▤".repeat(n)}${RESET}`;
					const titleBar = `${fg("border", "│")}${stripe(left)}${PINK}\x1b[1m${tag}${RESET}${stripe(stripeLen - left)}${fg("border", "│")}`;
					const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
					const reflex = config.reflex.enabled ? `on · ${config.reflex.riskAppetite}` : "off";
					const voice = config.voice.provider === "none" ? "off" : `${config.voice.provider}${config.voice.language !== "unknown" ? ` ${config.voice.language}` : ""}`;
					const meter = `${PINK}${" ".repeat(12)}${RESET} 100%`;
					const label = (s: string) => fg("dim", s.padEnd(11));
					const value = (s: string) => `${INK_ON_PAPER}${s}${RESET}`;
					return [
						`${fg("border", "┌")}${fg("border", "─".repeat(inner))}${fg("border", "┐")}`,
						titleBar,
						`${fg("border", "├")}${fg("border", "─".repeat(inner))}${fg("border", "┤")}`,
						row(` ${fg("muted", BRAND_TAGLINE)}`),
						row(` ${label("System One")} ${value(config.reflex.model.padEnd(16))} ${fg("dim", "reflex")} ${value(reflex)}`),
						row(` ${label("System Two")} ${value(model)}`),
						row(` ${label("Voice")} ${value(voice.padEnd(16))} ${fg("dim", "pi")} ${value(piVersion())}`),
						row(` ${label("Loading")} ${meter}`),
						`${fg("border", "└")}${fg("border", "─".repeat(inner))}${fg("border", "┘")}`,
						fg("dim", " /reflex policy · /voice or ctrl+shift+v · /browse <goal> · /computer · /models · /help"),
						"",
					];
				},
				invalidate() {},
			}));
		});
	};
}
