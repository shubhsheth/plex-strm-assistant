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
