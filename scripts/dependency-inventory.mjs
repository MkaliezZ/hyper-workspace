// Offline declarations from committed npm locks, with installed metadata only
// for missing declarations. This inventories licenses; it does not grant rights.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../", import.meta.url));
const locks = [
  "package-lock.json",
  "runtime/dsh/package-lock.json",
  "runtime/evaluations/package-lock.json",
];
const clean = (value) => String(value).replace(/[\t\r\n]/g, " "),
  hash = (body) => createHash("sha256").update(body).digest("hex");
const rows = [],
  inputs = [],
  licenseTexts = new Map();
for (const lock of locks) {
  const body = await readFile(resolve(root, lock)),
    parsed = JSON.parse(body);
  assert.equal(parsed.lockfileVersion, 3);
  inputs.push("# " + lock + " sha256:" + hash(body));
  for (const [path, pkg] of Object.entries(parsed.packages)) {
    if (!path.includes("node_modules/") || pkg.link) continue;
    let license = pkg.license,
      source = "lock";
    if (!license) {
      const metadata = await readFile(
        resolve(root, dirname(lock), path, "package.json"),
      );
      const installed = JSON.parse(metadata);
      assert.equal(installed.version, pkg.version);
      license = installed.license;
      source = "installed-package-json:sha256:" + hash(metadata);
      if (!license) {
        // Preserve the actual permission text without inventing an SPDX field.
        const raw = await readFile(
          resolve(root, dirname(lock), path, "LICENSE"),
        );
        const name =
          installed.name.replaceAll("/", "_") +
          "-" +
          pkg.version +
          "-LICENSE.txt";
        assert.match(name, /^[A-Za-z0-9@_.-]+$/);
        const relative = "docs/dependencies/license-texts/" + name;
        licenseTexts.set(relative, raw);
        source += ";" + relative + ":sha256:" + hash(raw);
      }
    }
    rows.push(
      [
        lock,
        path,
        pkg.version,
        typeof license === "string"
          ? license
          : license
            ? JSON.stringify(license)
            : "UNKNOWN",
        source,
        pkg.dev === true ? "yes" : "no",
        pkg.optional === true ? "yes" : "no",
      ]
        .map(clean)
        .join("\t"),
    );
  }
}
rows.sort();
const text = [
  "# npm license declarations, including dev/optional and duplicate installations",
  ...inputs,
  "lockfile\tpackage_path\tversion\tdeclared_license\tdeclaration_source\tdev_only\toptional",
  ...rows,
  "",
].join("\n");
const target = resolve(root, "docs/dependencies/npm-licenses.tsv");
if (process.argv[2] === "--write" && process.argv.length === 3) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  for (const [relative, body] of licenseTexts) {
    await mkdir(dirname(resolve(root, relative)), { recursive: true });
    await writeFile(resolve(root, relative), body);
  }
} else if (process.argv[2] === "--check" && process.argv.length === 3) {
  assert.equal(
    await readFile(target, "utf8"),
    text,
    "Dependency declarations drifted; review before regenerating.",
  );
  for (const [relative, body] of licenseTexts)
    assert.deepEqual(await readFile(resolve(root, relative)), body);
} else {
  throw Error(
    "Use --write to generate the fixed inventory or --check to compare it; no network is used.",
  );
}
console.log(
  JSON.stringify({
    installationRecords: rows.length,
    unknownDeclarations: rows.filter((row) => row.split("\t")[3] === "UNKNOWN")
      .length,
    networkUsed: false,
    legalOrWholeImageReview: false,
  }),
);
