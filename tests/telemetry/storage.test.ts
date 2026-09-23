import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlTraceSink } from "../../src/telemetry/jsonl.js";
import { keyedHash } from "../../src/telemetry/privacy.js";
import {
  dataDirectory,
  installationKey,
  tracePath,
} from "../../src/telemetry/storage.js";
import { workspace } from "../helpers.js";
import { schemaValidator, traceFixture } from "./helpers.js";

describe("local private telemetry storage", () => {
  it("resolves data paths and rejects ambiguous relative destinations", () => {
    expect(dataDirectory({ home: "/home/test", env: {} })).toBe(
      "/home/test/.local/share/skilldispatch",
    );
    expect(
      dataDirectory({ home: "/home/test", env: { XDG_DATA_HOME: "/xdg" } }),
    ).toBe("/xdg/skilldispatch");
    expect(
      dataDirectory({
        home: "/home/test",
        env: { SKILLDISPATCH_DATA_DIR: "/override", XDG_DATA_HOME: "/xdg" },
      }),
    ).toBe("/override");
    expect(
      dataDirectory({ home: "/home/test", env: { XDG_DATA_HOME: "relative" } }),
    ).toBe("/home/test/.local/share/skilldispatch");
    expect(() =>
      dataDirectory({
        home: "/home/test",
        env: { SKILLDISPATCH_DATA_DIR: "relative" },
      }),
    ).toThrow();
    expect(
      tracePath({ home: "/home/test", env: {} }, "~/private/events.jsonl"),
    ).toBe("/home/test/private/events.jsonl");
    expect(
      tracePath({ home: "/home/test", env: {} }, "/private/events.jsonl"),
    ).toBe("/private/events.jsonl");
    expect(() =>
      tracePath({ home: "/home/test", env: {} }, "relative.jsonl"),
    ).toThrow();
  });
  it("publishes one complete random key under concurrent creation and reuses it", async () => {
    const ctx = await workspace();
    const directory = join(ctx.root, "private/data");
    const keys = await Promise.all(
      Array.from({ length: 20 }, () => installationKey(directory)),
    );
    expect(
      keys.every(
        (key) => key.length === 32 && key.equals(keys[0] ?? Buffer.alloc(0)),
      ),
    ).toBe(true);
    expect(
      (await installationKey(directory)).equals(keys[0] ?? Buffer.alloc(0)),
    ).toBe(true);
    expect(await readdir(directory)).toEqual(["install.key"]);
    const other = await installationKey(join(ctx.root, "other/data"));
    expect(keyedHash(other, "prompt", "same")).not.toBe(
      keyedHash(keys[0] ?? Buffer.alloc(0), "prompt", "same"),
    );
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "install.key"))).mode & 0o777).toBe(
        0o600,
      );
    }
  });
  it.each([0, 16, 33])(
    "rejects corrupt key length %s without replacing it",
    async (length) => {
      const ctx = await workspace();
      const directory = join(ctx.root, "data");
      await mkdir(directory, { mode: 0o700 });
      const original = Buffer.alloc(length, 1);
      await writeFile(join(directory, "install.key"), original, {
        mode: 0o600,
      });
      await expect(installationKey(directory)).rejects.toThrow();
      expect(await readFile(join(directory, "install.key"))).toEqual(original);
    },
  );
  it("rejects key symlinks and public permissions without modifying their target", async () => {
    const ctx = await workspace();
    const directory = join(ctx.root, "data");
    await mkdir(directory, { mode: 0o700 });
    const target = join(ctx.root, "secret");
    await writeFile(target, Buffer.alloc(32, 9), { mode: 0o600 });
    await symlink(target, join(directory, "install.key"));
    await expect(installationKey(directory)).rejects.toThrow();
    if (process.platform !== "win32") {
      const unsafe = join(ctx.root, "public");
      await mkdir(unsafe, { mode: 0o755 });
      await chmod(unsafe, 0o755);
      await expect(installationKey(unsafe)).rejects.toThrow();
    }
    expect(await readFile(target)).toEqual(Buffer.alloc(32, 9));
  });
  it("writes one parseable JSON line per event sequentially and concurrently", async () => {
    const ctx = await workspace();
    const path = join(ctx.root, "new/private/traces.jsonl");
    const sink = new JsonlTraceSink(path);
    await sink.write(traceFixture());
    await sink.write(traceFixture());
    await Promise.all(
      Array.from({ length: 20 }, () =>
        new JsonlTraceSink(path).write(traceFixture()),
      ),
    );
    const source = await readFile(path, "utf8");
    expect(source.endsWith("\n")).toBe(true);
    const lines = source.trimEnd().split("\n");
    expect(lines).toHaveLength(22);
    const validate = await schemaValidator();
    for (const line of lines) expect(validate(JSON.parse(line))).toBe(true);
    expect(source).not.toMatch(/PRIVATE_|synthetic-api-key/);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("does not append to symlinks, directories, or files with unsafe permissions", async () => {
    const ctx = await workspace();
    const data = join(ctx.root, "data");
    await mkdir(data, { mode: 0o700 });
    const target = join(data, "target");
    await writeFile(target, "unchanged", { mode: 0o600 });
    const path = join(data, "traces.jsonl");
    await symlink(target, path);
    await expect(
      new JsonlTraceSink(path).write(traceFixture()),
    ).resolves.toBeUndefined();
    await expect(
      new JsonlTraceSink(data).write(traceFixture()),
    ).resolves.toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("unchanged");
    if (process.platform !== "win32") {
      await chmod(target, 0o644);
      await new JsonlTraceSink(target).write(traceFixture());
      expect(await readFile(target, "utf8")).toBe("unchanged");
    }
  });
  it("does not create directories or serialize an invalid trace with forbidden fields", async () => {
    const ctx = await workspace();
    const path = join(ctx.root, "data/traces.jsonl");
    await new JsonlTraceSink(path).write({
      ...traceFixture(),
      cwd: "private",
    } as unknown as ReturnType<typeof traceFixture>);
    await expect(stat(join(ctx.root, "data"))).rejects.toThrow();
  });
});
