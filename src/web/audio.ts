/**
 * Convert browser audio (webm/opus, mp4, ogg) to 16 kHz mono WAV with ffmpeg when available.
 * WAV input passes through untouched.
 */
import { spawn } from "node:child_process";
import { detectRecorder } from "../extensions/voice/recorder.js";

export async function convertToWav(input: Buffer, mime: string): Promise<Buffer> {
	if (mime.includes("wav") || (input.length > 12 && input.toString("ascii", 0, 4) === "RIFF")) return input;
	if (detectRecorder() !== "ffmpeg") throw new Error("ffmpeg is needed to convert browser audio (brew install ffmpeg)");
	return new Promise<Buffer>((resolve, reject) => {
		const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		let err = "";
		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => {
			err += String(d);
		});
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg conversion failed: ${err.trim().split("\n").pop()}`))));
		child.stdin.end(input);
	});
}
