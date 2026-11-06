// Keyboard (two key sets) and up to three gamepads. read() gives a command in the screen frame:
// mx = right, my = forward (away from the camera); main.js turns it into the field frame.
import { KEYSETS, GAMEPAD } from './params.js';

export const BINDINGS = [
  ['none', 'None'], ['wasd', KEYSETS.wasd.label], ['arrows', KEYSETS.arrows.label],
  ['pad0', 'Gamepad 1'], ['pad1', 'Gamepad 2'], ['pad2', 'Gamepad 3'], ['pad3', 'Gamepad 4'], ['auto', 'Auto (sentry)'],
  ['any', 'Keyboard or gamepad'],
];

const DEAD = 0.15;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Input {
  constructor() {
    this.padTurn = GAMEPAD.turnSensitivity;   // Settings
    this.down = new Set();
    this.prev = {};
    const bound = new Set(Object.values(KEYSETS).flatMap((k) => Object.values(k)));
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      this.down.add(e.code);
      if (bound.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  // Connected gamepads in connection order (a browser shows a pad only after one of its buttons was
  // pressed on this page). Button numbers follow the 'standard' layout (Xbox style); a pad the
  // browser does not map ('' mapping) may number them differently.
  pads() {
    return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  }

  raw(binding) {
    // online: one player per computer, so both key sets and the first gamepad all drive it
    if (binding === 'any') {
      const rs = ['wasd', 'arrows', 'pad0'].map((b) => this.raw(b)).filter(Boolean);
      const sum = (f) => Math.max(-1, Math.min(1, rs.reduce((a, r) => a + r[f], 0)));
      const any = (f) => rs.some((r) => r[f]);
      return { mx: sum('mx'), my: sum('my'), rot: sum('rot'), action: any('action'), liftUp: any('liftUp'), liftDown: any('liftDown'),
        reachOut: any('reachOut'), reachIn: any('reachIn'), boost: any('boost'), buy: any('buy'), spin: any('spin') };
    }
    const k = KEYSETS[binding];
    if (k) {
      const d = (code) => this.down.has(code);
      return {
        mx: (d(k.right) ? 1 : 0) - (d(k.left) ? 1 : 0), my: (d(k.up) ? 1 : 0) - (d(k.down) ? 1 : 0),
        rot: (d(k.rotL) ? 1 : 0) - (d(k.rotR) ? 1 : 0), action: d(k.action),
        liftUp: d(k.liftUp), liftDown: d(k.liftDown), reachOut: d(k.reachOut), reachIn: d(k.reachIn),
        boost: d(k.boost), buy: d(k.buy), spin: d(k.spin),
      };
    }
    const m = /^pad(\d)$/.exec(binding);
    if (m) {
      const p = this.pads()[+m[1]];
      if (!p) return null;
      const b = (i) => !!p.buttons[i]?.pressed;
      return {
        mx: dz(p.axes[0] ?? 0), my: -dz(p.axes[1] ?? 0), rot: -dz(p.axes[2] ?? 0) * this.padTurn,
        action: b(7) || b(0), liftUp: b(12), liftDown: b(13), reachOut: b(5), reachIn: b(4),
        boost: b(6), buy: b(2), spin: b(3),
      };
    }
    return null;
  }

  // Command with press edges (true for the first read after the button went down).
  read(binding) {
    const r = this.raw(binding);
    if (!r) return null;
    const p = this.prev[binding] ?? {};
    this.prev[binding] = r;
    return { ...r, actionEdge: r.action && !p.action, buyEdge: r.buy && !p.buy, spinEdge: r.spin && !p.spin };
  }
}
