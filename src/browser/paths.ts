import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export const DEFAULT_BROWSER_TMP_DIR = resolvePreferredOpenClawTmpDir();
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");

type InvalidPathResult = { ok: false; error: string };

function invalidPath(scopeLabel: string): InvalidPathResult {
  return {
    ok: false,
    error: `Invalid path: must stay within ${scopeLabel}`,
  };
}

async function resolveRealPathIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return undefined;
  }
}

async function resolveTrustedRootRealPath(rootDir: string): Promise<string | undefined> {
  try {
    const rootLstat = await fs.lstat(rootDir);
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
      return undefined;
    }
    return await fs.realpath(rootDir);
  } catch {
    return undefined;
  }
}

async function validateCanonicalPathWithinRoot(params: {
  rootRealPath: string;
  candidatePath: string;
  expect: "directory" | "file";
}): Promise<"ok" | "not-found" | "invalid"> {
  try {
    const candidateLstat = await fs.lstat(params.candidatePath);
    if (candidateLstat.isSymbolicLink()) {
      return "invalid";
    }
    if (params.expect === "directory" && !candidateLstat.isDirectory()) {
      return "invalid";
    }
    if (params.expect === "file" && !candidateLstat.isFile()) {
      return "invalid";
    }
    const candidateRealPath = await fs.realpath(params.candidatePath);
    return isPathInside(params.rootRealPath, candidateRealPath) ? "ok" : "invalid";
  } catch (err) {
    return isNotFoundPathError(err) ? "not-found" : "invalid";
  }
}

export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const root = path.resolve(params.rootDir);
  const raw = params.requestedPath.trim();
  if (!raw) {
    if (!params.defaultFileName) {
      return { ok: false, error: "path is required" };
    }
    return { ok: true, path: path.join(root, params.defaultFileName) };
  }
  const resolved = path.resolve(root, raw);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `Invalid path: must stay within ${params.scopeLabel}` };
  }
  return { ok: true, path: resolved };
}

export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const lexical = resolvePathWithinRoot(params);
  if (!lexical.ok) {
    return lexical;
  }

  const rootDir = path.resolve(params.rootDir);
  const rootRealPath = await resolveTrustedRootRealPath(rootDir);
  if (!rootRealPath) {
    return invalidPath(params.scopeLabel);
  }

  const requestedPath = lexical.path;
  const parentDir = path.dirname(requestedPath);
  const parentStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: parentDir,
    expect: "directory",
  });
  if (parentStatus !== "ok") {
    return invalidPath(params.scopeLabel);
  }

  const targetStatus = await validateCanonicalPathWithinRoot({
    rootRealPath,
    candidatePath: requestedPath,
    expect: "file",
  });
  if (targetStatus === "invalid") {
    return invalidPath(params.scopeLabel);
  }

  return lexical;
}

export function resolvePathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): { ok: true; paths: string[] } | { ok: false; error: string } {
  const resolvedPaths: string[] = [];
  for (const raw of params.requestedPaths) {
    const pathResult = resolvePathWithinRoot({
      rootDir: params.rootDir,
      requestedPath: raw,
      scopeLabel: params.scopeLabel,
    });
    if (!pathResult.ok) {
      return { ok: false, error: pathResult.error };
    }
    resolvedPaths.push(pathResult.path);
  }
  return { ok: true, paths: resolvedPaths };
}
