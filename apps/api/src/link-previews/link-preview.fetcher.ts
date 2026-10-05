import { Injectable } from '@nestjs/common';
import type { LinkPreview } from '@videochat/shared';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from './ssrf.js';

export const FETCH_TIMEOUT_MS = 3000;
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'VideochatLinkPreview/1.0 (+https://github.com/maxkerro/videochat)';

export class LinkPreviewRefused extends Error {}

/** Decodes the handful of HTML entities that show up in titles and descriptions. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

function clean(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The page's text in its declared charset: the Content-Type header's, else a `<meta charset>` /
 * `http-equiv` in the first 2 KB, else UTF-8. Unknown labels fall back to UTF-8 too.
 */
export function decodeHtml(body: Buffer, contentType: string): string {
  const charset =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta\b[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(
      body.subarray(0, 2048).toString('latin1'),
    )?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(body);
  } catch {
    return body.toString('utf8');
  }
}

/** Reads `<meta property|name="..." content="...">` in either attribute order. */
function metaContent(html: string, names: string[]): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content =
      /\bcontent\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag)?.[1];
    if (content) return content;
  }
  return undefined;
}

/** CHAT-031: OpenGraph first, then plain `<title>` / meta description. Null without a title. */
export function parsePreview(html: string, pageUrl: string): LinkPreview | null {
  const title = clean(
    metaContent(html, ['og:title', 'twitter:title']) ??
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
    300,
  );
  if (!title) return null;
  let imageUrl: string | null = null;
  const rawImage = metaContent(html, ['og:image', 'og:image:secure_url', 'twitter:image']);
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage.trim()), pageUrl);
      // https only: an http image on an https page is mixed content, and a data:/javascript:
      // URL isn't an image we should hand to clients at all.
      if (resolved.protocol === 'https:' && resolved.href.length <= 2048) imageUrl = resolved.href;
    } catch {
      // Unparseable image URL: just no image.
    }
  }
  return {
    url: pageUrl,
    title,
    description: clean(
      metaContent(html, ['og:description', 'twitter:description', 'description']),
      500,
    ),
    siteName: clean(metaContent(html, ['og:site_name']), 100),
    imageUrl,
  };
}

/**
 * CHAT-031: fetches a page's HTML for a link preview, safely:
 * - http/https on the default ports only;
 * - every connection's resolved address must be public (see `isPublicAddress`) -- the check runs
 *   inside the socket's DNS lookup, so the address checked is the address connected to (no DNS-
 *   rebinding gap between "check" and "connect");
 * - redirects re-checked the same way, at most 3;
 * - 3 s total, at most 1 MB read, HTML only, decoded in the page's own charset.
 */
@Injectable()
export class LinkPreviewFetcher {
  /** Overridable in tests, which need to reach a server on loopback. */
  protected isAllowedAddress(address: string): boolean {
    return isPublicAddress(address);
  }

  async fetchPreview(url: string): Promise<LinkPreview | null> {
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.checkUrl(current);
      const res = await this.get(current, deadline);
      if (res.redirect) {
        current = new URL(res.redirect, current);
        continue;
      }
      return res.html === null ? null : parsePreview(res.html, current.href);
    }
    throw new LinkPreviewRefused('Too many redirects');
  }

  private checkUrl(url: URL): void {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new LinkPreviewRefused('Only http(s) links get previews');
    }
    if (url.username || url.password) throw new LinkPreviewRefused('No credentials in URLs');
    if (url.port && url.port !== '80' && url.port !== '443') {
      throw new LinkPreviewRefused('Only default ports');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !this.isAllowedAddress(host)) {
      throw new LinkPreviewRefused('Address not allowed');
    }
  }

  private get(url: URL, deadline: number): Promise<{ redirect?: string; html: string | null }> {
    const lookup: LookupFunction = (hostname, options, callback) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as LookupAddress[];
        const bad = list.find((a) => !this.isAllowedAddress(a.address));
        if (bad || list.length === 0) {
          return callback(new LinkPreviewRefused('Address not allowed'), '', 0);
        }
        if ((options as { all?: boolean }).all) {
          return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        }
        callback(null, list[0]!.address, list[0]!.family);
      });
    };
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const remaining = Math.max(1, deadline - Date.now());
      const req = client.get(
        url,
        {
          lookup,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml;q=0.9',
            'Accept-Language': 'en,de;q=0.8',
          },
          timeout: remaining,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            resolve({ redirect: res.headers.location, html: null });
            return;
          }
          const type = String(res.headers['content-type'] ?? '').toLowerCase();
          if (status !== 200 || !(type.includes('text/html') || type.includes('xhtml'))) {
            res.resume();
            resolve({ html: null });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve({ html: decodeHtml(Buffer.concat(chunks), type) });
          };
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            const room = MAX_BODY_BYTES - size;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += Math.min(chunk.length, room);
            // The tags we want are in <head>; stop at the cap rather than reading the whole page.
            if (size >= MAX_BODY_BYTES) {
              finish();
              res.destroy();
            }
          });
          res.on('end', finish);
          res.on('error', (err) => (done ? undefined : reject(err)));
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('Link preview timed out')), remaining);
      req.on('timeout', () => req.destroy(new Error('Link preview timed out')));
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.on('close', () => clearTimeout(timer));
    });
  }
}
