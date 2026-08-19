import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyUrlToContainerPath, toContainerPath, toLocalPath, toProxyUrl } from '../src/strm';

const rebase = '/strm:/media/strm';

test('toLocalPath is the inverse of toContainerPath', () => {
  const local = '/strm/Movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).strm';
  const container = toContainerPath(local, rebase);
  assert.equal(container, '/media/strm/Movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).strm');
  assert.equal(toLocalPath(container, rebase), local);
});

test('toLocalPath leaves paths outside the container prefix untouched', () => {
  assert.equal(toLocalPath('/somewhere/else/file.strm', rebase), '/somewhere/else/file.strm');
});

test('toLocalPath returns input when rebase has no separator', () => {
  assert.equal(toLocalPath('/media/strm/x.strm', '/media/strm'), '/media/strm/x.strm');
});

test('proxyUrlToContainerPath reverses toProxyUrl (with .mp4 swap)', () => {
  const proxyBase = 'http://strm-proxy:3000';
  const container = '/media/strm/Movies/Big Buck Bunny (2008)/Big Buck Bunny (2008).strm';
  // Plex stores the proxy URL with .mp4, so mimic the setup trigger's transform.
  const proxyUrl = toProxyUrl(container, rebase, proxyBase).replace(/\.strm$/, '.mp4');
  assert.equal(
    proxyUrl,
    'http://strm-proxy:3000/Movies/Big%20Buck%20Bunny%20(2008)/Big%20Buck%20Bunny%20(2008).mp4',
  );
  assert.equal(proxyUrlToContainerPath(proxyUrl, proxyBase, '/media/strm'), container);
});

test('proxyUrlToContainerPath tolerates a trailing slash on proxy base and prefix', () => {
  const container = '/media/strm/Movies/A.strm';
  const proxyUrl = 'http://strm-proxy:3000/Movies/A.mp4';
  assert.equal(
    proxyUrlToContainerPath(proxyUrl, 'http://strm-proxy:3000/', '/media/strm/'),
    container,
  );
});

test('proxyUrlToContainerPath strips query/fragment and returns null off-base', () => {
  const proxyUrl = 'http://strm-proxy:3000/Movies/A.mp4?x=1#frag';
  assert.equal(
    proxyUrlToContainerPath(proxyUrl, 'http://strm-proxy:3000', '/media/strm'),
    '/media/strm/Movies/A.strm',
  );
  assert.equal(
    proxyUrlToContainerPath(
      'http://other-host/Movies/A.mp4',
      'http://strm-proxy:3000',
      '/media/strm',
    ),
    null,
  );
});
