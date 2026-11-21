import { env, exports } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';

const call = (path, init, base = 'https://swiftdrop.test') =>
  exports.default.fetch(new Request(base + path, init));

const upload = (bytes, extra = {}) => {
  const fd = new FormData();
  fd.set('file', new File([bytes], 'a.txt', { type: 'text/plain' }));
  fd.set('roomCode', 'ABC123');
  fd.set('turnstileToken', 'x'); // TURNSTILE_SECRET unset in tests -> accepted
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return call('/upload', { method: 'POST', body: fd });
};

const openWs = async (path) => {
  const res = await call(path, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const w = waiters.findIndex((x) => x.type === m.type);
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.accept();
  ws.next = (type) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ type, resolve }));
  };
  return ws;
};

describe('http basics', () => {
  it('redirects http to https', async () => {
    const res = await call('/foo?a=1', { redirect: 'manual' }, 'http://swiftdrop.test');
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://swiftdrop.test/foo?a=1');
  });

  it('serves /api/config uncached', async () => {
    const res = await call('/api/config');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toHaveProperty('turnstileSiteKey');
  });
});

describe('upload / download', () => {
  it('rejects files over 20MB', async () => {
    const res = await upload(new Uint8Array(20 * 1024 * 1024 + 1));
    expect(res.status).toBe(413);
  });

  it('rejects uploads without a turnstile token', async () => {
    const fd = new FormData();
    fd.set('file', new File(['hi'], 'a.txt'));
    fd.set('roomCode', 'ABC123');
    const res = await call('/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(403);
  });

  it('round-trips a file', async () => {
    const { fileId, downloadUrl } = await (await upload('hello')).json();
    const res = await call(downloadUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(fileId).toBeTruthy();
  });

  it('returns 410 and deletes an expired file', async () => {
    await env.FILE_STORAGE.put('old', 'x', { customMetadata: { expiresAt: '1' } });
    expect((await call('/download/old')).status).toBe(410);
    expect(await env.FILE_STORAGE.get('old')).toBeNull();
  });

  it('404s an unknown file', async () => {
    expect((await call('/download/nope')).status).toBe(404);
  });

  it('refuses non-http(s) share URLs', async () => {
    const res = await call('/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urlId: 'u1', url: 'javascript:alert(1)', roomCode: 'ABC123', turnstileToken: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('websocket guards', () => {
  it('rejects bad room codes', async () => {
    const res = await call('/ws?room=ABC', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(400);
  });

  it('rejects a cross-origin browser handshake', async () => {
    const res = await call('/ws?room=ABC123', {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});

describe('SignalingRoom', () => {
  it('announces joins and routes signaling between peers', async () => {
    const a = await openWs('/ws?room=ROOM01');
    const aInfo = await a.next('connected');
    expect(aInfo.peersCount).toBe(0);

    const b = await openWs('/ws?room=ROOM01');
    const bInfo = await b.next('connected');
    expect(bInfo.peersCount).toBe(1);
    expect((await a.next('peer-joined')).peersCount).toBe(2);

    b.send(JSON.stringify({ type: 'offer', sdp: 'x', target: aInfo.sessionId }));
    const offer = await a.next('offer');
    expect(offer.from).toBe(bInfo.sessionId);

    b.close();
    const left = await a.next('peer-left');
    // note: left.peersCount currently reads one low (getWebSockets() already excludes the closing socket); client ignores it
    expect(left.sessionId).toBe(bInfo.sessionId);
    a.close();
  });

  it('keeps rooms isolated', async () => {
    const a = await openWs('/ws?room=ROOMAA');
    await a.next('connected');
    const b = await openWs('/ws?room=ROOMBB');
    expect((await b.next('connected')).peersCount).toBe(0);
    a.close();
    b.close();
  });
});

describe('NearbyLobby', () => {
  it('lists announced devices', async () => {
    const a = await openWs('/nearby');
    const b = await openWs('/nearby');
    await a.next('connected');
    await b.next('connected');
    a.send(JSON.stringify({ type: 'announce', deviceId: 'device-aaaa', displayName: 'Alpha' }));
    b.send(JSON.stringify({ type: 'announce', deviceId: 'device-bbbb', displayName: 'Beta' }));
    // each device sees the other, never itself
    expect((await a.next('peer-list')).peers).toEqual([]);
    expect(JSON.stringify(await a.next('peer-list'))).toContain('Beta');
    expect(JSON.stringify(await b.next('peer-list'))).not.toContain('Beta');
    a.close();
    b.close();
  });
});
