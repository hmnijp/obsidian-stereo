import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const obsidianDouble = `
	export class PluginSettingTab {}
	export class App {}
	export class Modal {}
	export class ConfirmationModal {}
	export class ItemView {}
	export class Notice {}
	export class FuzzySuggestModal {}
	export class Setting {}
	export function setIcon() {}
	export function requestUrl() { throw new Error("Unexpected network request"); }
`;

async function bundle(entry) {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		plugins: [
			{
				name: "host-double",
				setup(builder) {
					builder.onResolve({ filter: /^obsidian$/ }, () => ({
						path: "host",
						namespace: "double",
					}));
					builder.onLoad({ filter: /.*/, namespace: "double" }, () => ({
						contents: obsidianDouble,
					}));
				},
			},
		],
	});
	return import(
		`data:text/javascript;base64,${Buffer.from(
			result.outputFiles[0].text
		).toString("base64")}`
	);
}

const settings = await bundle("src/settings.ts");
const { DEFAULT_SETTINGS, EXTRA_BUTTONS, normalizeExtrasOrder } = settings;
const ids = EXTRA_BUTTONS.map((button) => button.id);

test("the default extras order follows the button table", () => {
	assert.deepEqual(DEFAULT_SETTINGS.extrasOrder, ids);
	assert.deepEqual(normalizeExtrasOrder(DEFAULT_SETTINGS.extrasOrder), ids);
});

test("unknown ids are dropped and duplicates keep their first position", () => {
	assert.deepEqual(normalizeExtrasOrder(["volume", "gone", "volume", "repeat"]), [
		"volume",
		"repeat",
		...ids.filter((id) => id !== "volume" && id !== "repeat"),
	]);
});

test("buttons missing from the stored order are appended in table order", () => {
	const stored = ["favorite", "volume"];
	const result = normalizeExtrasOrder(stored);
	assert.deepEqual(result.slice(0, stored.length), stored);
	assert.deepEqual(
		result.slice(stored.length),
		ids.filter((id) => !stored.includes(id))
	);
});

test("a missing or malformed order falls back to every button", () => {
	for (const value of [undefined, null, "nope", 42, {}, []]) {
		assert.deepEqual(normalizeExtrasOrder(value), ids);
	}
});

test("normalizing returns a fresh array and leaves the defaults alone", () => {
	const result = normalizeExtrasOrder(DEFAULT_SETTINGS.extrasOrder);
	assert.notEqual(result, DEFAULT_SETTINGS.extrasOrder);
	result.reverse();
	assert.deepEqual(DEFAULT_SETTINGS.extrasOrder, ids);
});

test("every button points at exactly one boolean toggle", () => {
	const keys = new Set(EXTRA_BUTTONS.map((button) => button.key));
	assert.equal(keys.size, EXTRA_BUTTONS.length);
	for (const button of EXTRA_BUTTONS) {
		assert.equal(
			typeof DEFAULT_SETTINGS[button.key],
			"boolean",
			`${button.id} → ${button.key}`
		);
	}
});
