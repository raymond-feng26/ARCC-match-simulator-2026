// Room server for online play. CLOUD_SERVER: the Cloudflare Worker (net/cloudflare, printed by
// `wrangler deploy`). A page served by the local room server (net/local_server.mjs) uses that
// server instead; ?server=wss://... in the address overrides both.
export const CLOUD_SERVER = 'wss://arcc-match-rooms.ursaworks.workers.dev';   // deployed 2026-11-05

export async function roomServer() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q.replace(/^http/, 'ws').replace(/\/$/, '');
  try {
    const r = await fetch('/room-server-info', { cache: 'no-store' });
    if (r.ok && (await r.text()).trim() === 'local') return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  } catch { /* not the local server */ }
  return CLOUD_SERVER.replace(/^http/, 'ws').replace(/\/$/, '');
}
