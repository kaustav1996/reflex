/**
 * Microphone capture for the terminal: spawns ffmpeg (or sox `rec`) and returns
 * 16 kHz mono 16-bit PCM WAV bytes when stopped. No native modules.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RecorderKind = "ffmpeg" | "sox";

export function detectRecorder(): RecorderKind | undefined {
	for (const [bin, kind] of [
		["ffmpeg", "ffmpeg"],
		["rec", "sox"],
	] as const) {
		const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
		if (r.status === 0) return kind;
	}
	return undefined;
}

export function recorderInstallHint(): string {
	if (process.platform === "darwin") return "brew install ffmpeg   (or: brew install sox)";
	if (process.platform === "linux") return "sudo apt install ffmpeg   (or sox)";
	return "install ffmpeg and put it on PATH";
}

export interface Recording {
	readonly startedAt: number;
	/** Stop and return WAV bytes. */
	stop(): Promise<Buffer>;
	/** Stop and discard. */
	cancel(): Promise<void>;
	readonly stopped: boolean;
}

export interface RecorderOptions {
	kind?: RecorderKind;
	/** ffmpeg avfoundation device index or pulse/alsa device name. */
	device?: string;
	maxSeconds?: number;
	sampleRate?: number;
}

function ffmpegInputArgs(device: string | undefined): string[] {
	switch (process.platform) {
		case "darwin":
			return ["-f", "avfoundation", "-i", `:${device ?? "0"}`];
		case "linux":
			return ["-f", "pulse", "-i", device ?? "default"];
		case "win32":
			return ["-f", "dshow", "-i", `audio=${device ?? "default"}`];
		default:
			return ["-f", "alsa", "-i", device ?? "default"];
	}
}

export function startRecording(options: RecorderOptions = {}): Recording {
	const kind = options.kind ?? detectRecorder();
	if (!kind) throw new Error(`No audio recorder found. ${recorderInstallHint()}`);
	const sampleRate = options.sampleRate ?? 16000;
	const file = join(tmpdir(), `reflex-voice-${process.pid}-${Date.now()}.wav`);

	let child: ChildProcess;
	let stderr = "";
	if (kind === "ffmpeg") {
		child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...ffmpegInputArgs(options.device), "-ac", "1", "-ar", String(sampleRate), "-c:a", "pcm_s16le", "-y", file], { stdio: ["ignore", "ignore", "pipe"] });
	} else {
		child = spawn("rec", ["-q", "-r", String(sampleRate), "-c", "1", "-b", "16", "-e", "signed-integer", file], { stdio: ["ignore", "ignore", "pipe"] });
	}
	child.stderr?.on("data", (d) => {
		stderr += String(d);
	});

	const exited = new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		child.once("error", () => resolve());
	});
	let spawnError: Error | undefined;
	child.once("error", (e) => {
		spawnError = e;
	});

	const startedAt = Date.now();
	let stopped = false;
	const maxTimer = setTimeout(() => void stopProcess(), (options.maxSeconds ?? 120) * 1000);

	async function stopProcess(): Promise<void> {
		if (stopped) return;
		stopped = true;
		clearTimeout(maxTimer);
		// SIGINT makes ffmpeg/sox finalize the WAV header.
		child.kill("SIGINT");
		const killer = setTimeout(() => child.kill("SIGKILL"), 3000);
		await exited;
		clearTimeout(killer);
	}

	return {
		startedAt,
		get stopped() {
			return stopped;
		},
		async stop() {
			await stopProcess();
			if (spawnError) throw new Error(`Recorder failed to start: ${spawnError.message}. ${recorderInstallHint()}`);
			if (!existsSync(file)) {
				throw new Error(`No audio captured${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}. On macOS, grant your terminal Microphone access in System Settings → Privacy & Security.`);
			}
			const data = readFileSync(file);
			try {
				unlinkSync(file);
			} catch {}
			if (data.length < 1000) throw new Error("Recording too short.");
			return data;
		},
		async cancel() {
			await stopProcess();
			try {
				unlinkSync(file);
			} catch {}
		},
	};
}

// ---------------------------------------------------------------------------
// Tiny WAV helpers (PCM s16le) used to chunk long recordings for 30 s APIs.
// ---------------------------------------------------------------------------

export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	dataOffset: number;
	dataLength: number;
}

export function parseWav(buf: Buffer): WavInfo {
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
	let offset = 12;
	let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
		} else if (id === "data") {
			if (!fmt) throw new Error("WAV data before fmt");
			const dataLength = Math.min(size === 0xffffffff || size === 0 ? buf.length - body : size, buf.length - body);
			return { ...fmt, dataOffset: body, dataLength };
		}
		offset = body + size + (size % 2);
	}
	throw new Error("WAV data chunk not found");
}

export function buildWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = (sampleRate * channels * bitsPerSample) / 8;
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** Split a WAV into chunks of at most `maxSeconds` (used for Sarvam's 30 s REST limit). */
export function splitWav(buf: Buffer, maxSeconds: number): Buffer[] {
	const info = parseWav(buf);
	const bytesPerSecond = (info.sampleRate * info.channels * info.bitsPerSample) / 8;
	const chunkBytes = Math.floor(bytesPerSecond * maxSeconds);
	const pcm = buf.subarray(info.dataOffset, info.dataOffset + info.dataLength);
	if (pcm.length <= chunkBytes) return [buf];
	const out: Buffer[] = [];
	for (let i = 0; i < pcm.length; i += chunkBytes) out.push(buildWav(pcm.subarray(i, Math.min(i + chunkBytes, pcm.length)), info.sampleRate, info.channels, info.bitsPerSample));
	return out;
}

export function wavDurationSeconds(buf: Buffer): number {
	try {
		const info = parseWav(buf);
		return info.dataLength / ((info.sampleRate * info.channels * info.bitsPerSample) / 8);
	} catch {
		return 0;
	}
}
