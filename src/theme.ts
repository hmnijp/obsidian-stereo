/** Theme helpers: reading live Obsidian variables out of the DOM. */

/**
 * Resolve a theme CSS variable to a literal colour string.
 *
 * The probe is attached to the document's body on purpose. Themes may redefine
 * variables deeper in the tree — Minimal repoints `--background-secondary` to
 * `--background-primary` inside the right sidebar — so a value read on the
 * element that uses it can be a different colour than the one used outside the
 * pane. Reading it on the body pins the answer to the document-wide value and
 * returns a concrete colour, free of any `var()` indirection left in the theme.
 */
export function resolveThemeColor(variable: string, doc: Document): string {
	const probe = doc.body.createDiv();
	probe.style.display = "none";
	probe.style.backgroundColor = `var(${variable})`;
	const color = probe.win.getComputedStyle(probe).backgroundColor;
	probe.remove();
	return color;
}
