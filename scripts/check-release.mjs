import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tag =
  process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : null;
assert.match(
  pkg.version,
  /^\d+\.\d+\.\d+$/,
  "Release versions must be stable major.minor.patch values.",
);
if (tag)
  assert.equal(
    tag,
    `v${pkg.version}`,
    "Git tag must match package.json version.",
  );
if (process.argv.includes("--artifacts")) {
  const metadata = yaml.load(fs.readFileSync("release/latest.yml", "utf8"));
  assert.equal(metadata.version, pkg.version);
  const expected = `Alpha-Setup-${pkg.version}-x64.exe`;
  assert.equal(metadata.path, expected);
  const installer = fs.readFileSync(path.join("release", expected));
  const digest = createHash("sha512").update(installer).digest("base64");
  assert.equal(metadata.sha512, digest);
  assert.equal(metadata.files[0].url, expected);
  assert.equal(metadata.files[0].sha512, digest);
  assert.equal(metadata.files[0].size, installer.length);
  assert.ok(fs.statSync(path.join("release", expected + ".blockmap")).size > 0);
  const feed = yaml.load(
    fs.readFileSync("release/win-unpacked/resources/app-update.yml", "utf8"),
  );
  assert.equal(feed.provider, "github");
  assert.equal(feed.owner, "william-pyle");
  assert.equal(feed.repo, "Alpha");
  assert.ok(
    !feed.token,
    "Credentials must never be embedded in the update feed.",
  );
  console.log(
    "Installer SHA-512, metadata, blockmap and GitHub feed verified.",
  );
} else console.log(`Release version verified: ${pkg.version}`);
