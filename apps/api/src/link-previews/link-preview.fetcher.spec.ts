import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodeEntities,
  LinkPreviewFetcher,
  LinkPreviewRefused,
  parsePreview,
} from './link-preview.fetcher.js';

describe('parsePreview', () => {
  it('reads OpenGraph tags in either attribute order and decodes entities', () => {
    const html = `<html><head>
      <meta property="og:title" content="Tom &amp; Jerry">
      <meta content="A &quot;classic&quot;" property="og:description">
      <meta property="og:site_name" content="Cartoons">
      <meta property="og:image" content="/img/tj.png">
      <title>ignored</title></head></html>`;
    expect(parsePreview(html, 'https://example.com/show')).toEqual({
      url: 'https://example.com/show',
      title: 'Tom & Jerry',
      description: 'A "classic"',
      siteName: 'Cartoons',
      imageUrl: 'https://example.com/img/tj.png',
    });
  });

  it('falls back to <title> and meta description; drops non-https images', () => {
    const html = `<title> Plain  page </title><meta name="description" content="About it">
      <meta property="og:image" content="http://insecure.example/x.png">`;
    expect(parsePreview(html, 'https://e.com/')).toMatchObject({
      title: 'Plain page',
      description: 'About it',
      imageUrl: null,
    });
  });

  it('gives no preview without a title', () => {
    expect(parsePreview('<p>hi</p>', 'https://e.com/')).toBeNull();
  });

  it('decodes numeric entities and ignores invalid code points', () => {
    expect(decodeEntities('&#72;&#x69; &#0;&#99999999;')).toBe('Hi ');
  });
});

class LoopbackFetcher extends LinkPreviewFetcher {
  protected override isAllowedAddress(): boolean {
    return true;
  }
}

describe('LinkPreviewFetcher', () => {
  const fetcher = new LinkPreviewFetcher();

  it.each([
    'ftp://example.com/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
    'http://example.com:8080/',
    'http://user:pass@example.com/',
  ])('refuses %s before connecting', async (url) => {
    await expect(fetcher.fetchPreview(url)).rejects.toBeInstanceOf(LinkPreviewRefused);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(fetcher.fetchPreview('http://localhost/')).rejects.toThrow(/not allowed/);
  });

  describe('against a local server', () => {
    let server: http.Server;
    let base: string;
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/page' });
          res.end();
        } else if (req.url === '/page') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<meta property="og:title" content="Hello"><title>x</title>');
        } else if (req.url === '/json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        } else if (req.url === '/slow') {
          setTimeout(() => res.end('<title>late</title>'), 5000).unref();
        } else if (req.url === '/huge') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.write('<title>Big</title>');
          res.end(Buffer.alloc(3 * 1024 * 1024, 'a'));
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });

    // These use a non-default port, which the real fetcher refuses; the subclass lifts only the
    // address check, so lift the port check by pointing at it through the checkUrl override too.
    class TestFetcher extends LoopbackFetcher {
      protected override isAllowedAddress(): boolean {
        return true;
      }
    }
    const local = new TestFetcher();
    (local as unknown as { checkUrl: (u: URL) => void }).checkUrl = () => undefined;

    it('follows a redirect and parses the page', async () => {
      await expect(local.fetchPreview(`${base}/redirect`)).resolves.toMatchObject({
        title: 'Hello',
        url: `${base}/page`,
      });
    });

    it('ignores non-HTML responses', async () => {
      await expect(local.fetchPreview(`${base}/json`)).resolves.toBeNull();
    });

    it('gives up after 3 s', async () => {
      const started = Date.now();
      await expect(local.fetchPreview(`${base}/slow`)).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(4000);
    }, 6000);

    it('stops reading at 1 MB but still parses what it read', async () => {
      await expect(local.fetchPreview(`${base}/huge`)).resolves.toMatchObject({ title: 'Big' });
    });
  });
});
