#!/usr/bin/env node
import fs from 'fs';
import http from 'http';
import path from 'path';
import { normaliseStrmUrl } from './strm';

const STRM_ROOT = path.resolve(process.env.STRM_ROOT ?? '/strm');
const PORT = Number(process.env.PORT ?? 3000);

http
  .createServer((req, res) => {
    // Strip query string and fragment, decode percent-encoding.
    // Avoid new URL() -- it can reject literal spaces sent by some HTTP clients.
    const rawPath = (req.url ?? '/').split(/[?#]/)[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }

    let filePath = path.resolve(STRM_ROOT, '.' + decodedPath);

    if (!filePath.startsWith(STRM_ROOT + path.sep) && filePath !== STRM_ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // Plex stores the proxy URL with a .mp4 extension (so it treats it as video).
    // Map it back to the real .strm file on disk.
    if (!fs.existsSync(filePath)) {
      const strmPath = filePath.replace(/\.[^./]+$/, '.strm');
      if (fs.existsSync(strmPath)) {
        filePath = strmPath;
      }
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    // Normalise before redirecting -- raw spaces or non-ASCII characters in the
    // Location header are rejected by Node and by upstream servers
    const url = normaliseStrmUrl(raw);
    if (!url) {
      res.writeHead(422).end('Not a valid HTTP URL');
      return;
    }
    console.log(`302  ${decodedPath}  ->  ${url}`);
    res.writeHead(302, { Location: url }).end();
  })
  .listen(PORT, () => console.log(`strm-proxy on :${PORT}  root: ${STRM_ROOT}`));
