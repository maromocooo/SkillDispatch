import {
  chmod,
  link,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JsonlTraceReader,
  MAX_TRACE_LINE_BYTES,
} from "../../src/telemetry/reader.js";
import { workspace } from "../helpers.js";
import { traceFixture } from "./helpers.js";

async function setup() {
  const ctx = await workspace();
  const dir = join(ctx.root, "private");
  await mkdir(dir, { mode: 0o700 });
  const path = join(dir, "traces.jsonl");
  return {
    ctx,
    dir,
    path,
    reader: new JsonlTraceReader(path, [join(dir, "install.key")]),
  };
}
async function collect(reader: JsonlTraceReader) {
  const result = [];
  for await (const item of reader.read()) result.push(item);
  return result;
}
describe("safe streaming trace reader", () => {
  it.each([false, true])(
    "missing/empty dataset (%s), no creation",
    async (exists) => {
      const { path, reader } = await setup();
      if (exists) await writeFile(path, "", { mode: 0o600 });
      expect(await collect(reader)).toEqual([]);
      if (!exists) await expect(readFile(path)).rejects.toThrow();
    },
  );
  it("streams valid lines in file order, including complete final JSON without LF", async () => {
    const { path, reader } = await setup();
    const traces = Array.from({ length: 70 }, traceFixture);
    await writeFile(path, traces.map((t) => JSON.stringify(t)).join("\n"), {
      mode: 0o600,
    });
    expect(await collect(reader)).toEqual(
      traces.map((trace, i) => ({ kind: "valid", line: i + 1, trace })),
    );
  });
  it("isolates invalid JSON, schema errors, blank lines, and truncated tail", async () => {
    const { path, reader } = await setup();
    await writeFile(
      path,
      `broken\n{}\n\n${JSON.stringify(traceFixture())}\n{"truncated":`,
      { mode: 0o600 },
    );
    expect((await collect(reader)).map((r) => r.kind)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "valid",
      "invalid",
    ]);
  });
  it("skips an oversized line without losing the next line", async () => {
    const { path, reader } = await setup();
    await writeFile(
      path,
      `${"x".repeat(MAX_TRACE_LINE_BYTES + 100)}\n${JSON.stringify(traceFixture())}\n`,
      { mode: 0o600 },
    );
    const result = await collect(reader);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      kind: "invalid",
      line: 1,
      code: "line_too_large",
    });
    expect(result[1]?.kind).toBe("valid");
  });
  it("accepts exactly the line byte limit and rejects malformed UTF-8", async () => {
    const { path, reader } = await setup();
    const trace = traceFixture();
    trace.prompt = { storage: "raw", raw: "" };
    const overhead = Buffer.byteLength(JSON.stringify(trace));
    trace.prompt.raw = "x".repeat(MAX_TRACE_LINE_BYTES - overhead);
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(`${JSON.stringify(trace)}\n`),
        Buffer.from([0xff, 10]),
      ]),
      { mode: 0o600 },
    );
    expect((await collect(reader)).map((r) => r.kind)).toEqual([
      "valid",
      "invalid",
    ]);
  });
  it.each([
    "symlink",
    "hardlink",
    "directory",
    "permissions",
    "parent_permissions",
    "parent_symlink",
  ])("rejects %s without changing contents", async (kind) => {
    const { dir, path, reader, ctx } = await setup();
    const target = join(ctx.root, "secret");
    await writeFile(target, "UNCHANGED", { mode: 0o600 });
    if (kind === "symlink") await symlink(target, path);
    if (kind === "hardlink") await link(target, path);
    if (kind === "directory") await mkdir(path);
    if (kind === "permissions") {
      await writeFile(path, "", { mode: 0o600 });
      await chmod(path, 0o644);
    }
    if (kind === "parent_permissions") await chmod(dir, 0o755);
    if (kind === "parent_symlink") {
      const alias = join(ctx.root, "alias");
      await symlink(dir, alias);
      await expect(
        collect(new JsonlTraceReader(join(alias, "traces.jsonl"), [])),
      ).rejects.toThrow();
    } else if (process.platform !== "win32" || !kind.includes("permissions"))
      await expect(collect(reader)).rejects.toThrow("Trace destination");
    expect(await readFile(target, "utf8")).toBe("UNCHANGED");
  });
  it("refuses reserved key/config files and canonical parent aliases", async () => {
    const { ctx, dir } = await setup();
    const secret = join(dir, "credential");
    await writeFile(secret, "SECRET", { mode: 0o600 });
    const alias = join(ctx.root, "alias");
    await symlink(ctx.root, alias);
    for (const path of [
      secret,
      join(alias, "private/credential"),
      join(dir, "install.key"),
    ]) {
      await expect(
        collect(new JsonlTraceReader(path, [secret])),
      ).rejects.toThrow();
    }
  });
  it("uses a file size snapshot and closes an early-stopped iterator", async () => {
    const { path, reader } = await setup();
    const line = `${JSON.stringify(traceFixture())}\n`;
    await writeFile(path, line, { mode: 0o600 });
    const iterator = reader.read()[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.kind).toBe("valid");
    await writeFile(path, line + line);
    expect((await iterator.next()).done).toBe(true);
    for await (const _item of reader.read()) break;
    expect(await collect(reader)).toHaveLength(2);
  });
});
