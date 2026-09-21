import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

export async function workspace() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "skilldispatch-test-")),
  );
  temporaryPaths.push(root);
  await cp(
    fileURLToPath(new URL("./fixtures/discovery", import.meta.url)),
    root,
    { recursive: true },
  );
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"));
  return {
    root,
    repo,
    home: join(root, "home"),
    cwd: join(repo, "packages/web"),
    env: {},
  };
}

export async function write(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

export const skillText = (name: string, description = "A test skill.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n`;
