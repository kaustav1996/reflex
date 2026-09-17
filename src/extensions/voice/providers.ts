/**
 * Pluggable speech-to-text providers. Each takes WAV bytes and returns text.
 * Sarvam is the default (Indian languages + English, auto-detect, optional
 * translate-to-English); OpenAI, Groq, Deepgram and local whisper.cpp are alternatives.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig, VoiceProviderId } from "../../config.js";
import { splitWav } from "./recorder.js";

export interface Transcript {
	text: string;
	language?: string;
	provider: VoiceProviderId;
	latencyMs: number;
}

export interface TranscribeOptions {
	config: VoiceConfig;
	apiKey?: string;
	signal?: AbortSignal;
}

export async function transcribe(wav: Buffer, opts: TranscribeOptions): Promise<Transcript> {
	const started = performance.now();
	const { config } = opts;
	let result: { text: string; language?: string };
	switch (config.provider) {
		case "sarvam":
			result = await sarvam(wav, opts);
			break;
		case "openai":
			result = await openAiCompatible(wav, opts, "https://api.openai.com/v1/audio/transcriptions", config.model ?? "gpt-4o-transcribe");
			break;
		case "groq":
			result = await openAiCompatible(wav, opts, "https://api.groq.com/openai/v1/audio/transcriptions", config.model ?? "whisper-large-v3-turbo");
			break;
		case "deepgram":
			result = await deepgram(wav, opts);
			break;
		case "whisper-cpp":
			result = await whisperCpp(wav, opts);
			break;
		default:
			throw new Error("No voice provider configured. Run `reflex setup` or /voice provider <name>.");
	}
	return { ...result, text: result.text.trim(), provider: config.provider, latencyMs: Math.round(performance.now() - started) };
}

function requireKey(opts: TranscribeOptions, name: string): string {
	if (!opts.apiKey) throw new Error(`${name} API key missing. Run \`reflex setup\` or set the env var.`);
	return opts.apiKey;
}

async function readError(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	try {
		const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
		const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
		if (m) return m;
	} catch {}
	return text.slice(0, 200);
}

// ── Sarvam AI ─────────────────────────────────────────────────────────────

const SARVAM_MAX_SECONDS = 29;

async function sarvam(wav: Buffer, opts: TranscribeOptions): Promise<{ text: string; language?: string }> {
	const key = requireKey(opts, "Sarvam");
	const { config } = opts;
	const chunks = splitWav(wav, SARVAM_MAX_SECONDS);
	const texts: string[] = [];
	let language: string | undefined;
	for (const chunk of chunks) {
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(chunk)], { type: "audio/wav" }), "audio.wav");
		form.append("model", config.model ?? "saaras:v4");
		form.append("language_code", config.language || "unknown");
		form.append("mode", config.translateToEnglish ? "translate" : "transcribe");
		const res = await fetch("https://api.sarvam.ai/speech-to-text", {
			method: "POST",
			headers: { "api-subscription-key": key },
			body: form,
			signal: opts.signal,
		});
		if (!res.ok) throw new Error(`Sarvam ${res.status}: ${await readError(res)}`);
		const json = (await res.json()) as { transcript?: string; language_code?: string | null };
		if (json.transcript) texts.push(json.transcript.trim());
		language ??= json.language_code ?? undefined;
	}
	return { text: texts.join(" "), language };
}

// ── OpenAI-compatible (OpenAI, Groq) ───────────────────────────────────────

async function openAiCompatible(wav: Buffer, opts: TranscribeOptions, url: string, model: string): Promise<{ text: string; language?: string }> {
	const key = requireKey(opts, url.includes("groq") ? "Groq" : "OpenAI");
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
	form.append("model", model);
	form.append("response_format", "json");
	const lang = opts.config.language;
	if (lang && lang !== "unknown") form.append("language", lang.split("-")[0]);
	const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: opts.signal });
	if (!res.ok) throw new Error(`STT ${res.status}: ${await readError(res)}`);
	const json = (await res.json()) as { text?: string; language?: string };
	return { text: json.text ?? "", language: json.language };
}

// ── Deepgram ───────────────────────────────────────────────────────────────

async function deepgram(wav: Buffer, opts: TranscribeOptions): Promise<{ text: string; language?: string }> {
	const key = requireKey(opts, "Deepgram");
	const params = new URLSearchParams({ model: opts.config.model ?? "nova-3", smart_format: "true" });
	const lang = opts.config.language;
	if (lang && lang !== "unknown") params.set("language", lang.split("-")[0]);
	else params.set("detect_language", "true");
	const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
		method: "POST",
		headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" },
		body: new Uint8Array(wav),
		signal: opts.signal,
	});
	if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await readError(res)}`);
	const json = (await res.json()) as { results?: { channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string }> }> } };
	const ch = json.results?.channels?.[0];
	return { text: ch?.alternatives?.[0]?.transcript ?? "", language: ch?.detected_language };
}

// ── whisper.cpp (local) ────────────────────────────────────────────────────

async function whisperCpp(wav: Buffer, opts: TranscribeOptions): Promise<{ text: string }> {
	const bin = opts.config.whisperCppBin || "whisper-cli";
	const model = opts.config.whisperCppModel;
	if (!model) throw new Error("whisper.cpp model path not set (reflex setup).");
	const dir = mkdtempSync(join(tmpdir(), "reflex-whisper-"));
	const file = join(dir, "audio.wav");
	writeFileSync(file, wav);
	try {
		const args = ["-m", model, "-f", file, "-nt", "-np"];
		const lang = opts.config.language;
		args.push("-l", lang && lang !== "unknown" ? lang.split("-")[0] : "auto");
		const text = await new Promise<string>((resolve, reject) => {
			const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
			let out = "";
			let err = "";
			child.stdout.on("data", (d) => {
				out += String(d);
			});
			child.stderr.on("data", (d) => {
				err += String(d);
			});
			child.on("error", (e) => reject(new Error(`whisper.cpp failed to start (${bin}): ${e.message}`)));
			child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`whisper.cpp exited ${code}: ${err.trim().split("\n").pop()}`))));
		});
		return { text: text.replace(/\[[^\]]*\]/g, "").trim() };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
