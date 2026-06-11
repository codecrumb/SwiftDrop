// SwiftDrop service worker — share_target handler only.
const SHARE_CACHE = 'swiftdrop-share-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/share') {
    event.respondWith(handleShare(event));
    return;
  }
  // Everything else: let the network handle it (no app-shell caching).
});

async function handleShare(event) {
  const redirect = Response.redirect('/?shared=1', 303);
  try {
    const formData = await event.request.formData();
    const files = formData.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f && 'size' in f);
    const title = formData.get('title') || '';
    const text = formData.get('text') || '';
    const sharedUrl = formData.get('url') || '';

    const cache = await caches.open(SHARE_CACHE);

    // Clear any previous shared payload so we never surface stale files.
    const keys = await cache.keys();
    await Promise.all(keys.map((k) => cache.delete(k)));

    const manifest = {
      ts: Date.now(),
      title: String(title),
      text: String(text),
      url: String(sharedUrl),
      files: []
    };

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = '/__shared__/' + i + '/' + encodeURIComponent(f.name || ('file-' + i));
      await cache.put(
        new Request(key),
        new Response(f, {
          headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'X-Shared-Name': encodeURIComponent(f.name || ('file-' + i))
          }
        })
      );
      manifest.files.push({
        key,
        name: f.name || ('file-' + i),
        type: f.type || 'application/octet-stream',
        size: typeof f.size === 'number' ? f.size : 0
      });
    }

    await cache.put(
      new Request('/__shared__/manifest.json'),
      new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/json' }
      })
    );

    return redirect;
  } catch (err) {
    return Response.redirect('/?shared=error', 303);
  }
}
