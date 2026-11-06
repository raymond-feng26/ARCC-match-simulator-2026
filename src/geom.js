// Small geometry helpers. The whole simulator works in the field frame of
// scripts/gen_arcc_s2_field.py: origin at the Red Resupply Zone corner, x towards Blue (12 m),
// y towards the Central High Ground and Pipe Chutes (8 m), z up, metres.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function quatFromYaw(yaw) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

export function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}

// Rotate vector v by unit quaternion q.
export function rotate(q, v) {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

export function yawOf(q) {
  const f = rotate(q, { x: 1, y: 0, z: 0 });
  return Math.atan2(f.y, f.x);
}

export const inRect = (x, y, r) => x >= r[0][0] && x <= r[0][1] && y >= r[1][0] && y <= r[1][1];

// Does an oriented rectangle (centre, yaw, half length along yaw, half width) overlap an
// axis-aligned rectangle [[x0, x1], [y0, y1]]? Separating-axis test.
export function obbOverlapsRect(cx, cy, yaw, hl, hw, r) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const corners = [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]].map(([a, b]) => [cx + a * c - b * s, cy + a * s + b * c]);
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  if (Math.max(...xs) < r[0][0] || Math.min(...xs) > r[0][1]) return false;
  if (Math.max(...ys) < r[1][0] || Math.min(...ys) > r[1][1]) return false;
  const rc = [[r[0][0], r[1][0]], [r[0][0], r[1][1]], [r[0][1], r[1][0]], [r[0][1], r[1][1]]];
  for (const [ax, ay, h] of [[c, s, hl], [-s, c, hw]]) {
    const proj = rc.map(([x, y]) => (x - cx) * ax + (y - cy) * ay);
    if (Math.max(...proj) < -h || Math.min(...proj) > h) return false;
  }
  return true;
}

// Is a point inside an oriented rectangle?
export function inObb(px, py, cx, cy, yaw, hl, hw) {
  const dx = px - cx, dy = py - cy, c = Math.cos(yaw), s = Math.sin(yaw);
  return Math.abs(dx * c + dy * s) <= hl && Math.abs(-dx * s + dy * c) <= hw;
}
