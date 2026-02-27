import fs from "node:fs";
import path from "node:path";

// Keep defaults to OS-managed immutable bins only.
// User/package-manager bins must be opted in via tools.exec.safeBinTrustedDirs.
const DEFAULT_SAFE_BIN_TRUSTED_DIRS = ["/bin", "/usr/bin"];

type TrustedSafeBinDirsParams = {
  pathEnv?: string | null;
  delimiter?: string;
  baseDirs?: readonly string[];
};

type TrustedSafeBinPathParams = {
  resolvedPath: string;
  trustedDirs?: ReadonlySet<string>;
  pathEnv?: string | null;
  delimiter?: string;
};

type TrustedSafeBinCache = {
  key: string;
  dirs: Set<string>;
};

export type WritableTrustedSafeBinDir = {
  dir: string;
  groupWritable: boolean;
  worldWritable: boolean;
};

let trustedSafeBinCache: TrustedSafeBinCache | null = null;
const STARTUP_PATH_ENV = process.env.PATH ?? process.env.Path ?? "";

function normalizeTrustedDir(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed);
}

function buildTrustedSafeBinCacheKey(pathEnv: string, delimiter: string): string {
  return `${delimiter}\u0000${pathEnv}`;
}

export function buildTrustedSafeBinDirs(params: TrustedSafeBinDirsParams = {}): Set<string> {
  const delimiter = params.delimiter ?? path.delimiter;
  const pathEnv = params.pathEnv ?? "";
  const baseDirs = params.baseDirs ?? DEFAULT_SAFE_BIN_TRUSTED_DIRS;
  const trusted = new Set<string>();

  for (const entry of baseDirs) {
    const normalized = normalizeTrustedDir(entry);
    if (normalized) {
      trusted.add(normalized);
    }
  }

  const pathEntries = pathEnv
    .split(delimiter)
    .map((entry) => normalizeTrustedDir(entry))
    .filter((entry): entry is string => Boolean(entry));
  for (const entry of pathEntries) {
    trusted.add(entry);
  }

  return trusted;
}

export function getTrustedSafeBinDirs(
  params: {
    pathEnv?: string | null;
    delimiter?: string;
    refresh?: boolean;
  } = {},
): Set<string> {
  const delimiter = params.delimiter ?? path.delimiter;
  const pathEnv = params.pathEnv ?? STARTUP_PATH_ENV;
  const key = buildTrustedSafeBinCacheKey(pathEnv, delimiter);

  if (!params.refresh && trustedSafeBinCache?.key === key) {
    return trustedSafeBinCache.dirs;
  }

  const dirs = buildTrustedSafeBinDirs({
    pathEnv,
    delimiter,
  });
  trustedSafeBinCache = { key, dirs };
  return dirs;
}

export function isTrustedSafeBinPath(params: TrustedSafeBinPathParams): boolean {
  const trustedDirs =
    params.trustedDirs ??
    getTrustedSafeBinDirs({
      pathEnv: params.pathEnv,
      delimiter: params.delimiter,
    });
  const resolvedDir = path.dirname(path.resolve(params.resolvedPath));
  return trustedDirs.has(resolvedDir);
}

export function listWritableExplicitTrustedSafeBinDirs(
  entries?: readonly string[] | null,
): WritableTrustedSafeBinDir[] {
  if (process.platform === "win32") {
    return [];
  }
  const resolved = resolveTrustedSafeBinDirs(normalizeTrustedSafeBinDirs(entries));
  const hits: WritableTrustedSafeBinDir[] = [];
  for (const dir of resolved) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const mode = stat.mode & 0o777;
    const groupWritable = (mode & 0o020) !== 0;
    const worldWritable = (mode & 0o002) !== 0;
    if (!groupWritable && !worldWritable) {
      continue;
    }
    hits.push({ dir, groupWritable, worldWritable });
  }
  return hits;
}
