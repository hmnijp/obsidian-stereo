import { Notice, requestUrl } from "obsidian";
import type { SubsonicClient } from "./subsonic";

function loadImageElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("Could not load the image."));
		img.src = src;
	});
}

function canvasToBlob(
	canvas: HTMLCanvasElement,
	type: string
): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) =>
				blob
					? resolve(blob)
					: reject(new Error("Could not encode the image.")),
			type
		);
	});
}

/** Sniff the common raster formats so the original PNG bytes can be copied
 * directly even when the server sends a generic content type. */
function sniffImageType(buffer: ArrayBuffer): string | null {
	const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength));
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return "image/png";
	}
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return "image/webp";
	}
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
		return "image/gif";
	}
	return null;
}

async function writeClipboardImage(
	blob: Blob,
	type: string
): Promise<void> {
	if (typeof ClipboardItem === "undefined") {
		throw new Error("Image clipboard is not available.");
	}
	await navigator.clipboard.write([
		new ClipboardItem({ [type]: blob }),
	]);
}

/**
 * Copy the track cover to the image clipboard. A PNG original is copied
 * byte-for-byte; other formats (usually JPEG) are decoded and re-encoded
 * losslessly as PNG, because Chromium's clipboard only accepts PNG.
 */
export async function copyCoverToClipboard(
	client: SubsonicClient,
	coverArt: string
): Promise<void> {
	let objectUrl: string | null = null;
	try {
		const response = await requestUrl({
			url: client.coverArtUrl(coverArt),
		});
		const bytes = response.arrayBuffer;
		const headerType =
			(response.headers["content-type"] ?? "")
				.split(";")[0]
				?.trim()
				.toLowerCase() ?? "";
		const type = sniffImageType(bytes) ?? headerType;
		const canCopyOriginal =
			type === "image/png" ||
			(type === "image/jpeg" &&
				typeof ClipboardItem !== "undefined" &&
				typeof ClipboardItem.supports === "function" &&
				ClipboardItem.supports("image/jpeg"));
		if (canCopyOriginal) {
			await writeClipboardImage(new Blob([bytes], { type }), type);
			return;
		}

		const source = new Blob([bytes], {
			type: type.startsWith("image/") ? type : "image/jpeg",
		});
		objectUrl = URL.createObjectURL(source);
		const img = await loadImageElement(objectUrl);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, img.naturalWidth);
		canvas.height = Math.max(1, img.naturalHeight);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Could not create a 2D canvas.");
		ctx.drawImage(img, 0, 0);
		const png = await canvasToBlob(canvas, "image/png");
		await writeClipboardImage(png, "image/png");
	} catch {
		new Notice("Could not copy the cover to the clipboard.");
	} finally {
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	}
}
