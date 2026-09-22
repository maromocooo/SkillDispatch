import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function auditTarball(tarball) {
  const read = (args) => {
    const result = spawnSync("tar", args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, "Cannot inspect package tarball");
    return result.stdout;
  };
  const files = read(["-tzf", resolve(tarball)])
    .trim()
    .split("\n")
    .filter((p) => !p.endsWith("/"))
    .sort();
  for (const path of files) {
    assert.ok(
      path.startsWith("package/") && !path.split("/").includes(".."),
      "Unsafe tar path",
    );
    assert.match(
      path,
      /^package\/(?:dist\/.+\.(?:js|map|ts)|schemas\/[a-z-]+\.schema\.json|examples\/(?:[^/]+\.yaml|demo\/(?:README\.md|run\.mjs|skills\/[a-z-]+\/SKILL\.md))|evals\/example\.yaml|package\.json|README\.md|LICENSE|CHANGELOG\.md)$/u,
      "Unexpected public package file",
    );
    const content = read(["-xOzf", resolve(tarball), path]);
    assert.ok(
      !/\/Users\/[A-Za-z0-9._-]+\/|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:gh[pousr]_|npm_)[A-Za-z0-9]{30,}/u.test(
        content,
      ),
      "Sensitive content detected in package",
    );
  }
  for (const file of [
    "dist/cli/index.js",
    "dist/index.js",
    "dist/index.d.ts",
    "schemas/route-trace.schema.json",
    "schemas/skill-invocation.schema.json",
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
  ])
    assert.ok(
      files.includes(`package/${file}`),
      "Missing required package asset",
    );
  const metadata = JSON.parse(
    read(["-xOzf", resolve(tarball), "package/package.json"]),
  );
  assert.equal(metadata.name, "skilldispatch");
  assert.equal(metadata.version, "0.1.0");
  assert.equal(metadata.license, "MIT");
  return files;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(auditTarball(process.argv[2]).join("\n"));
  } catch {
    console.error(
      "Tarball audit failed; inspect the allowlist and package locally.",
    );
    process.exitCode = 1;
  }
}
