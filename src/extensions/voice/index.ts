/**
 * Voice input extension: push-to-talk recording → transcription → Jev intent
 * classification → editor / send / control.
 *
 *   /voice            toggle recording (also the configured shortcut, default ctrl+shift+v)
 *   /voice send       toggle auto-send of complete tasks (default: transcript lands in the editor)
 *   /voice lang X     set language (e.g. hi-IN, en-IN, unknown)
 *   /voice provider X sarvam | openai | groq | deepgram | whisper-cpp
 *   /voice translate  toggle Sarvam translate-to-English
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { type ReflexConfig, saveReflexConfig, type VoiceProviderId } from "../../config.js";
import { isValidChoice } from "../typesafe/client.js";
import { clip, snapshotSession } from "../typesafe/context.js";
import { buildUtteranceQuestions, UTTERANCE_KINDS } from "../typesafe/policy.js";
import type { ReflexState } from "../typesafe/state.js";
import { transcribe } from "./providers.js";
import { detectRecorder, type Recording, recorderInstallHint, startRecording, wavDurationSeconds } from "./recorder.js";

const VOICE_PROVIDERS: VoiceProviderId[] = ["sarvam", "openai", "groq", "deepgram", "whisper-cpp", "none"];

export function createVoiceExtension(config: ReflexConfig, getReflex: () => ReflexState | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		let recording: Recording | undefined;
		let timer: NodeJS.Timeout | undefined;
		let unsubscribeKeys: (() => void) | undefined;
		let autoSend = false;
		let busy = false;

		const voice = () => config.voice;

		function statusLabel(ctx: ExtensionContext): void {
			if (!ctx.hasUI) return;
			const t = ctx.ui.theme;
			if (voice().provider === "none") {
				ctx.ui.setStatus("voice", undefined);
				return;
			}
			const key = getReflex()?.keys.get(voice().provider);
			const label = `🎤 ${voice().provider}${voice().language && voice().language !== "unknown" ? `/${voice().language}` : ""}${autoSend ? " auto" : ""}`;
			ctx.ui.setStatus("voice", key || voice().provider === "whisper-cpp" ? t.fg("dim", label) : t.fg("warning", `${label} (no key)`));
		}

		function showRecordingWidget(ctx: ExtensionContext): void {
			if (!ctx.hasUI || !recording) return;
			const t = ctx.ui.theme;
			const secs = Math.floor((Date.now() - recording.startedAt) / 1000);
			const mm = String(Math.floor(secs / 60)).padStart(2, "0");
			const ss = String(secs % 60).padStart(2, "0");
			ctx.ui.setWidget("voice", [`${t.fg("error", "● REC")} ${t.bold(`${mm}:${ss}`)}  ${t.fg("dim", `${voice().provider} · Enter or ${voice().shortcut} to stop · Esc to cancel`)}`]);
		}

		async function start(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) return;
			if (voice().provider === "none") {
				ctx.ui.notify("Voice is off. /voice provider sarvam (or run `reflex setup`).", "warning");
				return;
			}
			if (!detectRecorder()) {
				ctx.ui.notify(`No microphone recorder found: ${recorderInstallHint()}`, "error");
				return;
			}
			try {
				recording = startRecording({ maxSeconds: 180 });
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				return;
			}
			showRecordingWidget(ctx);
			timer = setInterval(() => showRecordingWidget(ctx), 1000);
			ctx.ui.setWorkingMessage("Listening…");
			unsubscribeKeys = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "return")) {
					void stop(ctx);
					return { consume: true };
				}
				if (matchesKey(data, "escape")) {
					void cancel(ctx);
					return { consume: true };
				}
				return undefined;
			});
		}

		function cleanup(ctx: ExtensionContext): void {
			if (timer) clearInterval(timer);
			timer = undefined;
			unsubscribeKeys?.();
			unsubscribeKeys = undefined;
			recording = undefined;
			if (ctx.hasUI) {
				ctx.ui.setWidget("voice", undefined);
				ctx.ui.setWorkingMessage();
			}
		}

		async function cancel(ctx: ExtensionContext): Promise<void> {
			const rec = recording;
			cleanup(ctx);
			await rec?.cancel();
			if (ctx.hasUI) ctx.ui.notify("Recording cancelled", "info");
		}

		async function stop(ctx: ExtensionContext): Promise<void> {
			const rec = recording;
			if (!rec || busy) return;
			busy = true;
			cleanup(ctx);
			const t = ctx.ui.theme;
			ctx.ui.setStatus("voice", t.fg("warning", "🎤 transcribing…"));
			try {
				const wav = await rec.stop();
				const seconds = wavDurationSeconds(wav);
				if (seconds < 0.4) {
					ctx.ui.notify("Too short, nothing transcribed.", "info");
					return;
				}
				const apiKey = getReflex()?.keys.get(voice().provider);
				const result = await transcribe(wav, { config: voice(), apiKey });
				if (!result.text) {
					ctx.ui.notify("Heard nothing.", "info");
					return;
				}
				await route(ctx, result.text, result.language, result.latencyMs);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			} finally {
				busy = false;
				statusLabel(ctx);
			}
		}

		/** Decide what to do with a transcript. Jev classifies it in ~100ms when available. */
		async function route(ctx: ExtensionContext, text: string, language: string | undefined, sttMs: number): Promise<void> {
			const reflex = getReflex();
			let kind: keyof typeof UTTERANCE_KINDS | undefined;
			let complete = 1;
			let confidence = 0;
			if (reflex?.enabled && reflex.config.reflex.classifyVoice && reflex.client) {
				try {
					const snap = snapshotSession(ctx, { maxToolCalls: 3 });
					const res = await reflex.client.systemOne({
						purpose: "voice-intent",
						state: {
							transcript: text,
							recent_context: { last_user_request: clip(snap.userRequest, 300), last_assistant_text: clip(snap.assistantText, 500), agent_is_working: !ctx.isIdle() },
						},
						questions: buildUtteranceQuestions(),
						timeoutMs: 2500,
					});
					if (isValidChoice(res.answers.kind, Object.keys(UTTERANCE_KINDS))) {
						kind = res.answers.kind.choice as keyof typeof UTTERANCE_KINDS;
						confidence = res.answers.kind.confidence;
					}
					complete = res.answers.complete.noul;
					reflex.record("voice", `${kind ?? "?"} @ ${Math.round(confidence * 100)}% · complete ${Math.round(complete * 100)}% · "${clip(text, 60)}"`);
				} catch {
					/* classification is best-effort */
				}
			}
			const info = `${language ? `${language} · ` : ""}${sttMs}ms`;

			if (kind === "chatter" && confidence >= 0.6) {
				ctx.ui.notify(`Ignored (sounded like background speech): "${clip(text, 60)}"`, "info");
				return;
			}
			if (kind === "control" && confidence >= 0.6) {
				const lower = text.toLowerCase();
				if (/\b(stop|cancel|abort|halt|wait)\b/.test(lower) && !ctx.isIdle()) {
					ctx.abort();
					ctx.ui.notify(`⏹ stopped (voice) · ${info}`, "info");
					return;
				}
				// Other control phrases become an instruction the user can confirm.
				ctx.ui.setEditorText(text);
				ctx.ui.notify(`Control phrase → editor · ${info}`, "info");
				return;
			}
			if (kind === "answer" && confidence >= 0.6 && complete >= 0.5) {
				pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
				ctx.ui.notify(`🎤 answered: "${clip(text, 60)}" · ${info}`, "info");
				return;
			}
			const sendNow = autoSend && complete >= 0.6 && (kind === undefined || kind === "task");
			if (sendNow) {
				pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				ctx.ui.notify(`🎤 sent · ${info}`, "info");
				return;
			}
			const existing = ctx.ui.getEditorText();
			ctx.ui.setEditorText(existing ? `${existing.trimEnd()} ${text}` : text);
			ctx.ui.notify(`🎤 ${complete < 0.6 ? "sounds unfinished — " : ""}review and press Enter · ${info}`, "info");
		}

		pi.on("session_start", async (_e, ctx) => statusLabel(ctx));
		pi.on("session_shutdown", async (_e, ctx) => {
			if (recording) await cancel(ctx);
		});

		pi.registerShortcut(voice().shortcut as never, {
			description: "Reflex: push-to-talk voice input",
			handler: async (ctx) => (recording ? stop(ctx) : start(ctx)),
		});

		pi.registerCommand("voice", {
			description: "Voice input: /voice (toggle recording) | send | lang <code> | provider <name> | translate | shortcut <key>",
			getArgumentCompletions: (prefix) => {
				const items = ["send", "lang", "provider", "translate", "shortcut"].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c }));
				return items.length ? items : null;
			},
			handler: async (args, ctx) => {
				const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
				switch (sub) {
					case undefined:
						return recording ? stop(ctx) : start(ctx);
					case "send":
						autoSend = !autoSend;
						ctx.ui.notify(`Voice auto-send ${autoSend ? "on: complete tasks are sent immediately" : "off: transcripts go to the editor"}`, "info");
						break;
					case "lang":
						if (!rest[0]) return ctx.ui.notify("usage: /voice lang hi-IN | en-IN | unknown", "warning");
						config.voice.language = rest[0];
						break;
					case "provider": {
						const p = rest[0] as VoiceProviderId;
						if (!VOICE_PROVIDERS.includes(p)) return ctx.ui.notify(`usage: /voice provider ${VOICE_PROVIDERS.join("|")}`, "warning");
						config.voice.provider = p;
						break;
					}
					case "translate":
						config.voice.translateToEnglish = !config.voice.translateToEnglish;
						ctx.ui.notify(`Translate to English ${config.voice.translateToEnglish ? "on" : "off"} (Sarvam saaras mode)`, "info");
						break;
					case "shortcut":
						if (!rest[0]) return ctx.ui.notify("usage: /voice shortcut ctrl+shift+v (takes effect after restart)", "warning");
						config.voice.shortcut = rest[0];
						break;
					default:
						return ctx.ui.notify(`unknown /voice subcommand: ${sub}`, "warning");
				}
				saveReflexConfig(config);
				statusLabel(ctx);
			},
		});
	};
}
