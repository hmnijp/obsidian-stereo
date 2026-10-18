import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const result = await build({
	entryPoints: ["src/external.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { isExternalId } = await import(
	`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

test("octo-fiesta external IDs are detected by their prefix", () => {
	assert.equal(isExternalId("ext-deezer-album-123"), true);
	assert.equal(isExternalId("ext-qobuz-song-456"), true);
	assert.equal(isExternalId("ext-yandex-artist-789"), true);
	assert.equal(isExternalId("ext-deezer-123"), true);
});

test("local IDs and missing IDs are not external", () => {
	assert.equal(isExternalId("a1b2c3d4e5"), false);
	assert.equal(isExternalId("album-uuid"), false);
	assert.equal(isExternalId(""), false);
	assert.equal(isExternalId(undefined), false);
});
