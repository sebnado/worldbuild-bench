import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (walks up from this module; works from src/ and dist/). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("worldbuild-bench: package root not found");
}

function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** realpath that tolerates missing leaf paths and dangling symlinks. */
function realResolve(p: string, depth = 0): string {
  if (depth > 40) throw new Error(`too many symbolic links: ${p}`);
  const remainder: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return remainder.length > 0 ? path.join(real, ...remainder) : real;
    } catch {
      let isLink = false;
      try {
        isLink = fs.lstatSync(cur).isSymbolicLink();
      } catch {
        /* cur does not exist at all — walk up */
      }
      if (isLink) {
        const target = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
        return realResolve(
          remainder.length > 0 ? path.join(target, ...remainder) : target,
          depth + 1,
        );
      }
      const parent = path.dirname(cur);
      if (parent === cur) return remainder.length > 0 ? path.join(cur, ...remainder) : cur;
      remainder.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Resolve `p` under `root`, checking lexically and after symlink resolution. */
export function resolveInside(root: string, p: string): string {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, p);
  if (!within(rootAbs, abs)) throw new Error(`path escapes workspace: ${p}`);
  const rootReal = realResolve(rootAbs);
  const absReal = realResolve(abs);
  if (!within(rootReal, absReal)) throw new Error(`path escapes workspace (via symlink): ${p}`);
  return abs;
}

export function timestampSlug(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
