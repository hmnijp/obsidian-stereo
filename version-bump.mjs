import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// Keep manifest.json in step with package.json, preserving minAppVersion.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);

// Record the app compatibility of the new version; re-tagging an existing
// version must not silently overwrite its historical minAppVersion.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
}
