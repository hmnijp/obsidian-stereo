import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

async function load(entry) {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "obsidian-double",
				setup(builder) {
					builder.onResolve({ filter: /^obsidian$/ }, () => ({
						path: "obsidian",
						namespace: "double",
					}));
					builder.onLoad(
						{ filter: /.*/, namespace: "double" },
						() => ({
							contents: `
								export function requestUrl() {
									throw new Error("Unexpected network request");
								}
							`,
						})
					);
				},
			},
		],
	});
	return import(
		`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
	);
}

const navidrome = await load("src/navidrome.ts");
const downloads = await load("src/track-download.ts");

test("builds album and playlist web routes with a clean base", () => {
	assert.equal(
		navidrome.navidromeAlbumUrl("https://music.example.com/", "album/one"),
		"https://music.example.com/app/#/album/album%2Fone/show"
	);
	assert.equal(
		navidrome.navidromePlaylistUrl(
			"https://music.example.com/navidrome//",
			"list one"
		),
		"https://music.example.com/navidrome/app/#/playlist/list%20one/show"
	);
	assert.equal(navidrome.navidromeAlbumUrl("", "one"), "");
});

test("tracks open their album page, and missing albums are rejected", () => {
	assert.equal(
		navidrome.navidromeTrackUrl("https://music.example.com", {
			albumId: "album-one",
		}),
		"https://music.example.com/app/#/album/album-one/show"
	);
	assert.equal(
		navidrome.navidromeTrackUrl("https://music.example.com", {}),
		null
	);
});

test("download names use the response header or track metadata", () => {
	assert.equal(
		downloads.downloadFileName(
			{
				id: "one",
				title: "Song",
				artist: "Artist",
				contentType: "audio/flac",
			},
			{ "content-type": "audio/flac" }
		),
		"Artist - Song.flac"
	);
	assert.equal(
		downloads.downloadFileName(
			{ id: "two", title: "A/B", artist: "AC:DC" },
			{}
		),
		"AC_DC - A_B.mp3"
	);
	assert.equal(
		downloads.downloadFileName(
			{ id: "three", title: "Title", artist: "Artist" },
			{
				"content-disposition":
					"attachment; filename*=UTF-8''Artist%20-%20Title.flac",
			}
		),
		"Artist - Title.flac"
	);
	assert.equal(
		downloads.downloadFileName({ id: "four", title: "CON", artist: "" }),
		"_CON.mp3"
	);
});

test("content types and Windows clipboard commands are safe", () => {
	assert.equal(
		downloads.extensionForContentType("audio/x-flac; charset=binary"),
		"flac"
	);
	assert.equal(downloads.extensionForContentType("application/octet-stream"), "mp3");
	assert.equal(
		downloads.buildPowerShellClipboardCommand(
			"C:\\Temp\\O'Brien.mp3"
		),
		"Set-Clipboard -LiteralPath 'C:\\Temp\\O''Brien.mp3'"
	);
	assert.equal(
		downloads.filenameFromDisposition(
			'attachment; filename="Artist - Title.mp3"'
		),
		"Artist - Title.mp3"
	);
});

test("macOS and Linux clipboard payloads point at the local file", () => {
	const filePath = "/tmp/Artist - Title.mp3";
	const uri = pathToFileURL(filePath).href;
	assert.equal(
		downloads.linuxClipboardPayload(filePath, "text/uri-list"),
		`${uri}\r\n`
	);
	assert.equal(
		downloads.linuxClipboardPayload(
			filePath,
			"x-special/gnome-copied-files"
		),
		`copy\n${uri}`
	);
	const mac = downloads.macClipboardScript(filePath);
	assert.match(mac, /^set the clipboard to \(POSIX file "/);
	assert.match(downloads.macClipboardScript(filePath, true), /Finder/);
});
