import { requestUrl } from "obsidian";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { md5Hex } from "./md5";
import type { Song, SubsonicClient } from "./subsonic";

/** Temporary files stay available while the system clipboard points at them. */
const DOWNLOAD_DIR = path.join(os.tmpdir(), "obsidian-stereo");

const MIME_EXTENSIONS: Record<string, string> = {
	"audio/aac": "aac",
	"audio/flac": "flac",
	"audio/mp3": "mp3",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/mpeg3": "mp3",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/vnd.wave": "wav",
	"audio/wav": "wav",
	"audio/webm": "webm",
	"audio/x-flac": "flac",
	"audio/x-m4a": "m4a",
	"audio/x-mp3": "mp3",
	"audio/x-mpeg": "mp3",
	"audio/x-ms-wma": "wma",
	"audio/x-wav": "wav",
};

export type ClipboardMode = "file" | "path";

export interface DownloadedTrack {
	fileName: string;
	filePath: string;
	/** `file` means the system clipboard holds the file itself. */
	mode: ClipboardMode;
	/** True when an existing download was reused instead of fetched again. */
	cached: boolean;
}

function headerValue(
	headers: Record<string, string>,
	name: string
): string {
	const direct = headers[name] ?? headers[name.toLowerCase()];
	if (direct !== undefined) return direct;
	const key = Object.keys(headers).find(
		(header) => header.toLowerCase() === name.toLowerCase()
	);
	return key ? headers[key] ?? "" : "";
}

/** Pull a file name out of a Content-Disposition header. */
export function filenameFromDisposition(value: string): string | null {
	const extended = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value);
	const extendedValue = extended?.[1];
	if (extendedValue) {
		let raw = extendedValue.trim();
		if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}

	const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(value);
	if (plain) {
		return (plain[1] ?? plain[2] ?? "").trim() || null;
	}
	return null;
}

/** Map a response content type to a sensible file extension. */
export function extensionForContentType(contentType: string): string {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return MIME_EXTENSIONS[type] ?? "mp3";
}

/** Remove characters that Windows and other file systems reject. */
export function sanitizeFileName(name: string): string {
	let result = name
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	if (!result) result = "track";
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(result)) {
		result = `_${result}`;
	}
	if (result.length > 180) {
		const extension = path.extname(result);
		const stem = result.slice(0, Math.max(1, 180 - extension.length));
		result = `${stem}${extension}`;
	}
	return result;
}

/** Build a safe local file name from the track and the download response. */
export function downloadFileName(
	song: Song,
	headers: Record<string, string> = {}
): string {
	const disposition = headerValue(headers, "content-disposition");
	const fromHeader = disposition ? filenameFromDisposition(disposition) : null;
	const contentType =
		headerValue(headers, "content-type") || song.contentType || "";
	const fallback = [song.artist, song.title].filter(Boolean).join(" - ");
	let name = fromHeader?.trim() || fallback || `track-${song.id}`;
	if (!path.extname(name)) {
		name += `.${extensionForContentType(contentType)}`;
	}
	return sanitizeFileName(name);
}

export function buildPowerShellClipboardCommand(filePath: string): string {
	return `Set-Clipboard -LiteralPath '${filePath.replace(/'/g, "''")}'`;
}

function runExecFile(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: 15_000, windowsHide: true },
			(error, _stdout, stderr) => {
				if (error) {
					reject(new Error(stderr?.trim() || error.message));
					return;
				}
				resolve();
			}
		);
	});
}

/** Run a clipboard tool that receives the payload on stdin. */
function runWithInput(
	command: string,
	args: string[],
	input: string
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${command} timed out.`));
		}, 15_000);
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					stderr.trim() || `${command} exited with code ${code ?? "unknown"}.`
				)
			);
		});
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(input);
	});
}

function powershellPath(): string {
	const root = process.env.SystemRoot || process.env.WINDIR;
	return root
		? path.join(
				root,
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe"
		  )
		: "powershell.exe";
}

function runPowerShellClipboard(filePath: string): Promise<void> {
	return runExecFile(powershellPath(), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-STA",
		"-WindowStyle",
		"Hidden",
		"-Command",
		buildPowerShellClipboardCommand(filePath),
	]);
}

function appleScriptString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** AppleScript that puts a file, not just its path, on the pasteboard. */
export function macClipboardScript(
	filePath: string,
	viaFinder = false
): string {
	const target = `POSIX file ${appleScriptString(filePath)}`;
	return viaFinder
		? `tell application "Finder" to set the clipboard to (${target})`
		: `set the clipboard to (${target})`;
}

/** `text/uri-list` and GNOME's file-copy payloads for Linux clipboards. */
export function linuxClipboardPayload(
	filePath: string,
	mimeType: string
): string {
	const uri = pathToFileURL(filePath).href;
	return mimeType === "x-special/gnome-copied-files"
		? `copy\n${uri}`
		: `${uri}\r\n`;
}

/** Last-resort path copy when no native file clipboard is available. */
async function copyPathText(filePath: string): Promise<ClipboardMode> {
	try {
		await navigator.clipboard.writeText(filePath);
		return "path";
	} catch {
		// Fall through to platform tools.
	}
	if (process.platform === "win32") {
		await runWithInput("clip.exe", [], filePath);
		return "path";
	}
	if (process.platform === "darwin") {
		await runWithInput("pbcopy", [], filePath);
		return "path";
	}
	const attempts: Array<[string, string[]]> = [
		["xclip", ["-selection", "clipboard"]],
		["xsel", ["--clipboard", "--input"]],
	];
	for (const [command, args] of attempts) {
		try {
			await runWithInput(command, args, filePath);
			return "path";
		} catch {
			// Try the next clipboard tool.
		}
	}
	throw new Error("Could not copy the file or its path to the clipboard.");
}

async function copyOnMac(filePath: string): Promise<ClipboardMode> {
	for (const viaFinder of [false, true]) {
		try {
			await runExecFile("osascript", [
				"-e",
				macClipboardScript(filePath, viaFinder),
			]);
			return "file";
		} catch {
			// Try the Finder variant, then the plain-text fallback.
		}
	}
	return copyPathText(filePath);
}

async function copyOnLinux(filePath: string): Promise<ClipboardMode> {
	const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
	const gnome = /gnome|unity|cinnamon|mate|budgie/.test(desktop);
	const mimeTypes = gnome
		? ["x-special/gnome-copied-files", "text/uri-list"]
		: ["text/uri-list", "x-special/gnome-copied-files"];
	const wayland =
		!!process.env.WAYLAND_DISPLAY ||
		process.env.XDG_SESSION_TYPE === "wayland";
	const attempts: Array<() => Promise<void>> = [];
	for (const mimeType of mimeTypes) {
		const payload = linuxClipboardPayload(filePath, mimeType);
		if (wayland) {
			attempts.push(() =>
				runWithInput(
					"wl-copy",
					["--type", mimeType],
					payload
				)
			);
		}
		attempts.push(() =>
			runWithInput(
				"xclip",
				["-selection", "clipboard", "-t", mimeType],
				payload
			)
		);
	}
	for (const attempt of attempts) {
		try {
			await attempt();
			return "file";
		} catch {
			// Try the next tool or MIME type.
		}
	}
	return copyPathText(filePath);
}

/**
 * Put a file on the system clipboard. Chromium's async clipboard cannot hold
 * arbitrary audio files, so each desktop uses its native clipboard tools.
 */
export async function copyFileToClipboard(
	filePath: string
): Promise<ClipboardMode> {
	if (process.platform === "win32") {
		try {
			await runPowerShellClipboard(filePath);
			return "file";
		} catch {
			return copyPathText(filePath);
		}
	}
	if (process.platform === "darwin") return copyOnMac(filePath);
	return copyOnLinux(filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Each account and track gets its own folder, so names never accumulate (2). */
function trackDirectory(client: SubsonicClient, song: Song): string {
	const key = `${client.accountKey()}\n${song.id}`;
	return path.join(DOWNLOAD_DIR, md5Hex(key));
}

/** Reuse a finished file from an earlier download of the same track. */
async function existingDownload(directory: string): Promise<string | null> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const file = entries
			.filter(
				(entry) =>
					entry.isFile() &&
					!entry.name.startsWith(".") &&
					!entry.name.endsWith(".part")
			)
			.sort((a, b) => a.name.localeCompare(b.name))[0];
		return file ? path.join(directory, file.name) : null;
	} catch {
		return null;
	}
}

/** Download the original file once, then place that file on the clipboard. */
export async function downloadTrackToClipboard(
	client: SubsonicClient,
	song: Song
): Promise<DownloadedTrack> {
	if (song.streamUrl) {
		throw new Error("Radio streams cannot be downloaded.");
	}

	const directory = trackDirectory(client, song);
	const cachedPath = await existingDownload(directory);
	if (cachedPath) {
		const mode = await copyFileToClipboard(cachedPath);
		return {
			fileName: path.basename(cachedPath),
			filePath: cachedPath,
			mode,
			cached: true,
		};
	}

	const response = await requestUrl({
		url: client.downloadUrl(song.id),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Could not download the track (HTTP ${response.status}).`);
	}
	if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) {
		throw new Error("The server returned an empty file.");
	}

	const fileName = downloadFileName(song, response.headers);
	await fs.mkdir(directory, { recursive: true });
	const filePath = path.join(directory, fileName);
	const partialPath = `${filePath}.part`;
	await fs.writeFile(partialPath, Buffer.from(response.arrayBuffer));
	try {
		await fs.rename(partialPath, filePath);
	} catch (error) {
		// A concurrent download may have finished first; reuse it if so.
		await fs.rm(partialPath, { force: true }).catch(() => undefined);
		if (!(await fileExists(filePath))) throw error;
	}
	const mode = await copyFileToClipboard(filePath);
	return { fileName: path.basename(filePath), filePath, mode, cached: false };
}
