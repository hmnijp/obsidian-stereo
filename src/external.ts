/**
 * octo-fiesta marks content fetched from a streaming provider with an `ext-`
 * prefix (`ext-deezer-album-…`, legacy `ext-deezer-…`). Local Navidrome IDs
 * use their own opaque format instead.
 */
export function isExternalId(id: string | undefined): boolean {
	return !!id && id.startsWith("ext-");
}
