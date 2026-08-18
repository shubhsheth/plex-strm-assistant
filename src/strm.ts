import fs from 'fs';
import path from 'path';

/**
 * Normalises a URL from a .strm file so it is safe to use in an HTTP Location
 * header: percent-encodes spaces and non-ASCII characters while leaving
 * existing percent-encoding intact. Returns null if not a valid HTTP(S) URL.
 */
export function normaliseStrmUrl(raw: string): string | null {
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) return null;
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/** Reads a .strm file and returns the URL it contains, or null if unreadable/invalid. */
export function readStrmUrl(filePath: string): string | null {
  try {
    return normaliseStrmUrl(fs.readFileSync(filePath, 'utf-8').trim());
  } catch {
    return null;
  }
}

/** Converts a local on-disk path to the container path Plex recorded in its DB. */
export function toContainerPath(localPath: string, rebase: string): string {
  const sep = rebase.indexOf(':');
  if (sep === -1) return localPath;
  // path.resolve normalises any ".." segments that the shell may leave unresolved
  const localPrefix = path.resolve(rebase.slice(0, sep));
  const containerPrefix = rebase.slice(sep + 1);
  return localPath.startsWith(localPrefix)
    ? containerPrefix + localPath.slice(localPrefix.length)
    : localPath;
}

/**
 * Builds the stable proxy URL for a container path.
 * Each path segment is percent-encoded so spaces and special chars are valid in the URL.
 * e.g. /media/strm/Movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).strm
 *   -> http://strm-proxy:3000/Movies/Big%20Buck%20Bunny%20(2008)/Big%20Buck%20Bunny%20(2008).strm
 */
export function toProxyUrl(containerPath: string, rebase: string, proxyBase: string): string {
  const sep = rebase.indexOf(':');
  const containerRoot = sep === -1 ? '' : rebase.slice(sep + 1);
  const relativePath = containerPath.startsWith(containerRoot)
    ? containerPath.slice(containerRoot.length)
    : containerPath;
  const encodedPath = relativePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return proxyBase.replace(/\/$/, '') + encodedPath;
}

/** Recursively walks a directory and returns paths to all .strm files found. */
export function walkStrm(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkStrm(full));
    } else if (entry.isFile() && entry.name.endsWith('.strm')) {
      results.push(full);
    }
  }
  return results;
}
