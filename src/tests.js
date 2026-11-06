// Headless scenarios: each builds its own Sim (no rendering) and checks one behaviour.
// Run from the page: matchSim.runTests(), or open index.html?test.
import { Sim, ZERO_CMD, spawnOf } from './sim.js';
import { PHYSICS, ROBOTS } from './params.js';
import { quatFromYaw } from './geom.js';
import { HostSession } from './online.js';

const cmd = (o) => ({ ...ZERO_CMD, ...o });

function run(sim, seconds, cmds = () => ({}), each = null) {
  const n = Math.round(seconds / PHYSICS.dt);
  for (let i = 0; i < n; i++) {
    sim.step(cmds(i * PHYSICS.dt));
    if (each) each(sim, i * PHYSICS.dt);
  }
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const pos = (sim, key) => sim.robots[key].body.translation();
const yawOfBody = (r) => { const q = r.body.rotation(); return Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)); };
// one physics step with the action button just pressed (grab / release)
const press = (sim, key) => sim.step({ [key]: cmd({ action: true, actionEdge: true }) });

export async function runTests(RAPIER) {
  const out = [];
  // The single-alliance checks run against the fixed targets; mode '3v3' for both alliances.
  const test = (name, fn, mode = 'targets') => {
    try {
      const sim = new Sim(RAPIER, { random: seeded(1), mode });
      const r = fn(sim);
      out.push({ name, ...r });
    } catch (e) {
      out.push({ name, pass: false, detail: `error: ${e.message}` });
    }
  };

  test('settle: robots and bucket at rest after 3 s', (sim) => {
    run(sim, 3);
    const moved = ['red_hero', 'red_engineer', 'red_sentry'].map((k) => Math.hypot(pos(sim, k).x - spawnOf(k)[0], pos(sim, k).y - spawnOf(k)[1]));
    const b = sim.objectives.find((o) => o.type === 'bucket').body.translation();
    const pipesIn = sim.objectives.filter((o) => o.type === 'pipe').every((o) => {
      const t = o.body.translation();
      return Math.hypot(t.x - b.x, t.y - b.y) < 0.12 && t.z > 0.15;
    });
    const tilt = ['red_hero', 'red_engineer', 'red_sentry'].map((k) => { const q = sim.robots[k].body.rotation(); return 2 * Math.asin(Math.hypot(q.x, q.y)) * 57.3; });
    return { pass: Math.max(...moved) < 0.03 && pipesIn && Math.max(...tilt) < 2,
      detail: `robot drift ${moved.map((m) => m.toFixed(3)).join('/')} m, tilt ${tilt.map((x) => x.toFixed(1)).join('/')} deg, pipes in bucket ${pipesIn}` };
  });

  test('drive: sentry full speed along the bottom passage', (sim) => {
    sim.place('red_sentry', 2.9, 0.6, 0);   // 6.5 m straight up to the Blue side limbo bar
    let maxP = 0, maxA = 0, prev = 0, t2 = null;
    const speeds = {};
    run(sim, 2.6, () => ({ red_sentry: cmd({ mx: 1 }) }), (s, t) => {
      const v = s.robots.red_sentry.body.linvel(), sp = Math.hypot(v.x, v.y);
      maxA = Math.max(maxA, (sp - prev) / PHYSICS.dt); prev = sp;
      maxP = Math.max(maxP, s.robots.red_sentry.powerW);
      if (t2 === null && sp >= 2) t2 = t;
      for (const at of [0.5, 1, 2, 2.5]) if (Math.abs(t - at) < PHYSICS.dt / 2) speeds[at] = sp.toFixed(2);
    });
    const top = +speeds[2.5];
    return { pass: top > 2.2 && top < 3.0 && maxP <= ROBOTS.sentry.powerW + 0.5 && maxA < 5.2,
      detail: `speed at 0.5/1/2/2.5 s ${[0.5, 1, 2, 2.5].map((k) => speeds[k]).join(' / ')} m/s, 0-2 m/s ${t2?.toFixed(2)} s, max accel ${maxA.toFixed(1)} m/s^2 (traction 0.5 g), max power ${maxP.toFixed(1)} W` };
  });

  test('drive: boost with the capacitor goes faster, then the capacitor runs out', (sim) => {
    sim.place('red_sentry', 3.3, 0.6, 0);
    let maxP = 0;
    run(sim, 2.0, () => ({ red_sentry: cmd({ mx: 1, boost: true }) }), (s) => { maxP = Math.max(maxP, s.robots.red_sentry.powerW); });
    const v = sim.robots.red_sentry.body.linvel();
    return { pass: maxP > ROBOTS.sentry.powerW + 20 && sim.robots.red_sentry.cap < 1500,
      detail: `speed after 2 s ${Math.hypot(v.x, v.y).toFixed(2)} m/s, max power ${maxP.toFixed(0)} W, capacitor ${sim.robots.red_sentry.cap.toFixed(0)} J` };
  });

  test('ramp: sentry climbs the Central High Ground and holds on the slope', (sim) => {
    sim.place('red_sentry', 3.3, 7.0, 0);
    run(sim, 2.2, () => ({ red_sentry: cmd({ mx: 0.6 }) }));
    const top = pos(sim, 'red_sentry');
    sim.place('red_sentry', 4.1, 7.0, 0);
    run(sim, 0.5);
    const a = pos(sim, 'red_sentry');
    run(sim, 3);
    const b = pos(sim, 'red_sentry');
    return { pass: top.z > 0.19 && top.x > 4.5 && Math.abs(b.x - a.x) < 0.05,
      detail: `after 2.2 s at 1.8 m/s: x ${top.x.toFixed(2)} z ${top.z.toFixed(3)}; parked on the ramp: slid ${(b.x - a.x).toFixed(3)} m in 3 s` };
  });

  test('limbo: sentry cannot pass under the central limbo bar (420 mm)', (sim) => {
    sim.place('red_sentry', 5.3, 5.7, 0);
    run(sim, 3, () => ({ red_sentry: cmd({ mx: 0.5 }) }));
    const p = pos(sim, 'red_sentry');
    return { pass: p.x < 6.0, detail: `sentry x after 3 s pushing: ${p.x.toFixed(2)} (bar at 5.96-6.04)` };
  });

  test('push: hero pushes the cube on the floor', (sim) => {
    const cube = sim.objectives.find((o) => o.type === 'cube');
    sim.placeObjective(cube, 4.6, 4.0, 0.05);
    sim.place('red_hero', 4.0, 4.0, 0);
    run(sim, 1.5, () => ({ red_hero: cmd({ mx: 0.4 }) }));
    const c = cube.body.translation();
    return { pass: c.x > 4.9, detail: `cube x 4.60 -> ${c.x.toFixed(2)}, z ${c.z.toFixed(3)}` };
  });

  test('engineer: cube onto the Red Scoring Area scores 1 VP/s', (sim) => {
    const cube = sim.objectives.find((o) => o.type === 'cube');
    sim.placeObjective(cube, 1.0, 5.85, 0.05);
    sim.place('red_engineer', 1.0, 5.42, 90);
    run(sim, 0.3);
    press(sim, 'red_engineer');
    const held = !!sim.robots.red_engineer.held;
    sim.robots.red_engineer.lift = 0.16;
    sim.place('red_engineer', 0.95, 6.55, 90);
    run(sim, 0.3);
    press(sim, 'red_engineer');
    run(sim, 0.3, () => ({ red_engineer: cmd({ my: -0.5 }) }));
    run(sim, 1);
    sim.start();
    run(sim, 5.05);
    return { pass: held && cube.scoring === 'red' && sim.vp.red === 5,
      detail: `grabbed ${held}, scoring ${cube.scoring}, red VP after 5 s ${sim.vp.red}` };
  });

  test('engineer: donut off the Red Side High Ground pole, scores 5 VP/s', (sim) => {
    const d = sim.objectives.find((o) => o.type === 'donut' && o.start === 'red');
    sim.place('red_engineer', 3.375, 2.8, 180);
    sim.robots.red_engineer.reach = 0.15;
    sim.robots.red_engineer.lift = 0.22;
    run(sim, 0.4, () => ({ red_engineer: cmd({ reachOut: true }) }));
    press(sim, 'red_engineer');
    const held = !!sim.robots.red_engineer.held;
    sim.place('red_engineer', 1.0, 6.4, 90);
    sim.robots.red_engineer.reach = 0.3;
    sim.robots.red_engineer.lift = 0.1;
    run(sim, 0.2);
    press(sim, 'red_engineer');
    sim.place('red_engineer', 1.0, 5.5, 90);
    run(sim, 1.5);
    sim.start();
    run(sim, 3.05);
    return { pass: held && d.scoring === 'red' && sim.vp.red === 15,
      detail: `grabbed ${held}, scoring ${d.scoring}, red VP after 3 s ${sim.vp.red}` };
  });

  test('engineer: pipe turned in at the Red Pipe Chute = +30 for its colour', (sim) => {
    sim.start();
    const pipe = sim.objectives.find((o) => o.type === 'pipe' && o.color === 'red');
    sim.placeObjective(pipe, 1.0, 5.85, 0.0134, { x: 0, y: 0, z: 0, w: 1 });  // lying along y
    sim.place('red_engineer', 1.0, 5.42, 90);
    sim.robots.red_engineer.lift = 0.03;
    run(sim, 0.3);
    press(sim, 'red_engineer');
    const held = !!sim.robots.red_engineer.held;
    sim.place('red_engineer', 0.95, 7.55, 90);
    sim.robots.red_engineer.lift = 0.6;
    run(sim, 0.2);
    press(sim, 'red_engineer');
    return { pass: held && pipe.turnedIn && sim.vp.red === 30, detail: `grabbed ${held}, turned in ${pipe.turnedIn}, red VP ${sim.vp.red}` };
  });

  test('penalty: Hero in the Blue Resupply Zone > 3 s gets a Yellow Card', (sim) => {
    sim.place('red_sentry', 4.0, 4.0, 0);   // out of the Red Resupply Zone, where robots heal
    sim.place('red_engineer', 4.0, 5.2, 0);
    sim.start();
    sim.place('red_hero', 11.0, 1.0, 0);
    run(sim, 3.2);
    const r = sim.robots;
    return { pass: r.red_hero.hp === 350 - 53 && r.red_sentry.hp === 400 - 20 && sim.t < r.red_hero.blockedUntil && sim.t < r.red_sentry.blockedUntil,
      detail: `HP hero ${r.red_hero.hp} (350 -15 %), sentry ${r.red_sentry.hp} (-5 %), hero blocked ${(r.red_hero.blockedUntil - sim.t).toFixed(1)} s` };
  });

  test('shooting: sentry fires at Target A, hit probability 1', (sim) => {
    sim.hitProbability.red_sentry = 1;
    sim.start();
    sim.place('red_sentry', 6.6, 2.0, 0);
    let shots = 0;
    run(sim, 6, () => ({ red_sentry: cmd({ action: true }) }), (s) => { if (s.t - s.robots.red_sentry.lastShot < PHYSICS.dt / 2) shots += 1; });
    const down = sim.targets.filter((t) => t.deaths > 0).map((t) => t.name);
    return { pass: sim.targets[0].deaths === 1 && sim.vp.red === 20 * down.length && sim.robots.red_sentry.heat <= ROBOTS.sentry.heatMax,
      detail: `${shots} shots, defeated ${down.join(', ')} (A first, then the next in range), red VP ${sim.vp.red}, heat ${sim.robots.red_sentry.heat.toFixed(0)} / ${ROBOTS.sentry.heatMax}` };
  });

  test('shooting: hit probability 0.3 gives ~30 % hits', (sim) => {
    sim.hitProbability.red_sentry = 0.3;
    sim.place('red_sentry', 6.6, 2.0, 0);
    let shots = 0;
    run(sim, 6, () => ({ red_sentry: cmd({ action: true }) }), (s) => { if (s.t - s.robots.red_sentry.lastShot < PHYSICS.dt / 2) shots += 1; });
    const hits = (400 - sim.targets[0].hp) / 20;
    return { pass: shots > 20 && Math.abs(hits / shots - 0.3) < 0.15, detail: `${hits} hits / ${shots} shots` };
  });

  test('sentry auto: stops when a robot is in its way, goes on when clear', (sim) => {
    sim.place('red_sentry', 3.6, 3.6, 0);
    sim.place('red_hero', 4.6, 3.1, 0);   // on the first patrol leg towards (5.3, 2.2)
    let stopped = false, minGap = 9;
    run(sim, 4, () => ({ red_sentry: cmd({ auto: true }) }), (s) => {
      stopped ||= s.robots.red_sentry.auto.stopped;
      const a = pos(s, 'red_sentry'), b = pos(s, 'red_hero');
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
    });
    sim.place('red_hero', 1.0, 1.0, 0);
    const before = pos(sim, 'red_sentry');
    run(sim, 3, () => ({ red_sentry: cmd({ auto: true }) }));
    const after = pos(sim, 'red_sentry');
    return { pass: stopped && minGap > 0.65 && Math.hypot(after.x - before.x, after.y - before.y) > 0.5,
      detail: `stopped ${stopped}, closest centre distance ${minGap.toFixed(2)} m, moved ${Math.hypot(after.x - before.x, after.y - before.y).toFixed(2)} m after the way cleared` };
  });

  test('sentry auto: leaves the Resupply Zone at the start without touching the others', (sim) => {
    let stopped = false, minGap = 9;
    run(sim, 8, () => ({ red_sentry: cmd({ auto: true }) }), (s) => {
      stopped ||= s.robots.red_sentry.auto.stopped;
      const a = pos(s, 'red_sentry'), b = pos(s, 'red_engineer');
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
    });
    const p = pos(sim, 'red_sentry'), e = pos(sim, 'red_engineer');
    const em = Math.hypot(e.x - spawnOf('red_engineer')[0], e.y - spawnOf('red_engineer')[1]);
    return { pass: p.y > 2.5 && em < 0.02,
      detail: `sentry at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), state ${sim.robots.red_sentry.auto.state}, closest to engineer ${minGap.toFixed(2)} m, engineer moved ${em.toFixed(3)} m` };
  });

  test('sentry auto: goes round a robot parked on its patrol path', (sim) => {
    sim.place('red_sentry', 3.6, 3.6, 0);
    sim.place('red_hero', 4.45, 2.9, 0);   // on the leg towards (5.3, 2.2)
    let passed = false, minGap = 9;
    run(sim, 8, () => ({ red_sentry: cmd({ auto: true }) }), (s2) => {
      passed ||= s2.robots.red_sentry.auto.idx === 2;   // reached (5.3, 2.2), on to the next point
      const a = pos(s2, 'red_sentry'), b = pos(s2, 'red_hero');
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
    });
    const h = pos(sim, 'red_hero');
    const hm = Math.hypot(h.x - 4.45, h.y - 2.9);
    return { pass: passed && hm < 0.05 && minGap > 0.65,
      detail: `got past it to the next patrol point: ${passed}, closest centre distance ${minGap.toFixed(2)} m, hero moved ${hm.toFixed(3)} m` };
  });

  test('sentry auto: retreats home below 25 % HP and heals', (sim) => {
    sim.place('red_engineer', 4.0, 6.5, 0);   // out of the Resupply Zone
    sim.place('red_hero', 2.5, 4.6, 0);
    sim.place('red_sentry', 4.0, 4.5, 0);
    sim.robots.red_sentry.hp = 90;
    let reachedHome = false;
    run(sim, 12, () => ({ red_sentry: cmd({ auto: true }) }), (s) => { reachedHome ||= s.robots.red_sentry.auto.state === 'heal'; });
    return { pass: reachedHome && sim.robots.red_sentry.hp > 300, detail: `reached home ${reachedHome}, HP ${Math.round(sim.robots.red_sentry.hp)}, state ${sim.robots.red_sentry.auto.state}` };
  });

  // 2026-11-05: the Hero flew out of the field after meeting the pipes.
  test('pipes: hero drives into the bucket full of pipes and stays on the ground', (sim) => {
    sim.place('red_hero', 4.0, 1.0, 0);
    let maxZ = 0, maxTilt = 0;
    run(sim, 4, () => ({ red_hero: cmd({ mx: 1 }) }), (s) => {
      const b = s.robots.red_hero.body, q = b.rotation();
      maxZ = Math.max(maxZ, b.translation().z);
      maxTilt = Math.max(maxTilt, 2 * Math.asin(Math.min(1, Math.hypot(q.x, q.y))) * 57.3);
    });
    return { pass: maxZ < 0.06 && maxTilt < 15 && sim.limited.robot === 0 && sim.limited.objective === 0,
      detail: `highest ${maxZ.toFixed(3)} m, most tilt ${maxTilt.toFixed(1)} deg, velocity limits hit ${sim.limited.robot} (robot) / ${sim.limited.objective} (objectives)` };
  });

  test('pipes: random driving among scattered pipes, nothing thrown', (sim) => {
    const rnd = seeded(11);
    let maxZ = 0, maxV = 0, limited = 0;
    for (let n = 0; n < 6; n++) {
      const s = new Sim(sim.R, { random: seeded(n), mode: 'targets' });
      const hx = 1.0 + rnd() * 0.6, hy = 2.5 + rnd();
      s.place('red_hero', hx, hy, rnd() * 360);
      s.objectives.filter((o) => o.type === 'pipe').forEach((o) => {
        let x, y;
        do { x = 1.0 + rnd(); y = 2.1 + rnd() * 1.7; } while (Math.hypot(x - hx, y - hy) < 0.75);
        if (rnd() < 0.5) x = 1.985;   // against the Red Side High Ground
        s.placeObjective(o, x, y, 0.0136 + (rnd() < 0.3 ? 0.027 : 0), quatFromYaw(rnd() * Math.PI));
      });
      let c = cmd({});
      run(s, 10, (t) => {
        if (Math.abs(t % 0.75) < PHYSICS.dt / 2) c = cmd({ mx: rnd() * 2 - 1, my: rnd() * 2 - 1, rot: rnd() < 0.5 ? 0 : rnd() * 2 - 1, boost: rnd() < 0.3 });
        return { red_hero: c };
      }, (x) => {
        const b = x.robots.red_hero.body, v = b.linvel();
        maxZ = Math.max(maxZ, b.translation().z);
        maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z));
      });
      limited += s.limited.robot;
    }
    return { pass: maxZ < 0.1 && maxV < 3.5 && limited === 0,
      detail: `6 x 10 s: highest ${maxZ.toFixed(3)} m, fastest ${maxV.toFixed(2)} m/s, velocity limits hit ${limited}` };
  });

  test('release: a pipe picked up and put down in front of the Engineer lies still', (sim) => {
    sim.place('red_engineer', 3.8, 3.0, 0);
    run(sim, 0.3);
    const e = sim.robots.red_engineer, pipe = sim.objectives.find((o) => o.type === 'pipe');
    e.reach = 0.15; e.lift = 0.03;
    const g = sim.grabPoint(e);
    sim.placeObjective(pipe, g.x, g.y, 0.0134);
    run(sim, 0.2);
    press(sim, 'red_engineer');
    const held = e.held === pipe;
    run(sim, 0.8, () => ({ red_engineer: cmd({ liftUp: true }) }));
    run(sim, 0.8, () => ({ red_engineer: cmd({ liftDown: true }) }));
    press(sim, 'red_engineer');
    let maxV = 0;
    run(sim, 1.5, () => ({}), (s) => { const v = pipe.body.linvel(); maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); });
    const ep = pos(sim, 'red_engineer'), t = pipe.body.translation();
    return { pass: held && !pipe.ghost && maxV < 1 && Math.hypot(ep.x - 3.8, ep.y - 3.0) < 0.01 && t.z < 0.02,
      detail: `held ${held}, in the Engineer after letting go: ${pipe.ghost}, pipe fastest ${maxV.toFixed(2)} m/s, lies at z ${t.z.toFixed(3)}, Engineer moved ${Math.hypot(ep.x - 3.8, ep.y - 3.0).toFixed(3)} m` };
  });

  test('release: a pipe let go inside the Hero does not throw it', (sim) => {
    sim.place('red_engineer', 3.8, 3.0, 0);   // clear floor (not on the Side High Ground corner)
    sim.place('red_hero', 4.42, 3.0, 90);
    run(sim, 0.3);
    const e = sim.robots.red_engineer, pipe = sim.objectives.find((o) => o.type === 'pipe');
    e.reach = 0.05; e.lift = 0.3;
    const g = sim.grabPoint(e);
    sim.placeObjective(pipe, g.x, g.y, g.z);
    press(sim, 'red_engineer');
    const held = e.held === pipe;
    e.reach = 0.15; e.lift = 0.1;   // grab point now inside the Hero's chassis
    run(sim, 0.1);
    const before = pos(sim, 'red_hero');
    press(sim, 'red_engineer');
    const ghost = pipe.ghost;
    let maxV = 0;
    run(sim, 2, () => ({}), (s) => { const v = s.robots.red_hero.body.linvel(); maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); });
    const after = pos(sim, 'red_hero');
    sim.place('red_hero', 4.6, 1.2, 0);
    run(sim, 0.5);
    return { pass: held && ghost && !e.held && maxV < 0.2 && Math.hypot(after.x - before.x, after.y - before.y) < 0.02 && !pipe.ghost,
      detail: `held ${held}, let go into the Hero: passes robots ${ghost}, Hero moved ${Math.hypot(after.x - before.x, after.y - before.y).toFixed(3)} m (fastest ${maxV.toFixed(2)} m/s); solid again once the Hero left: ${!pipe.ghost}` };
  });

  test('release: put down on top of a field element, or kept when there is no room', (sim) => {
    const cube = sim.objectives.find((o) => o.type === 'cube');
    const e = sim.robots.red_engineer;
    sim.place('red_engineer', 1.5, 2.5, 0);   // facing the Red Side High Ground lower step (x 2-3, 0.21 m)
    run(sim, 0.3);
    e.reach = 0.05; e.lift = 0.1;
    const g = sim.grabPoint(e);
    sim.placeObjective(cube, g.x, g.y, g.z);
    press(sim, 'red_engineer');
    e.reach = 0.35;                         // grab point 0.13 m into the step
    run(sim, 0.05);
    press(sim, 'red_engineer');
    run(sim, 1);
    const c = cube.body.translation();
    const onTop = !e.held && c.x > 2.0 && Math.abs(c.z - 0.26) < 0.02;
    // the Central Wall is 1.4 m high: no room above
    sim.place('red_engineer', 5.4, 3.5, 0);
    run(sim, 0.3);
    e.reach = 0.05; e.lift = 0.3;
    const g2 = sim.grabPoint(e);
    sim.placeObjective(cube, g2.x, g2.y, g2.z);
    press(sim, 'red_engineer');
    e.reach = 0.35;
    run(sim, 0.05);
    press(sim, 'red_engineer');
    const kept = e.held === cube;
    return { pass: onTop && kept, detail: `cube put down at (${c.x.toFixed(2)}, ${c.z.toFixed(3)}) on the 0.21 m step: ${onTop}; inside the Central Wall it stays held: ${kept}` };
  });

  test('drive: no push while in the air', (sim) => {
    const b = sim.robots.red_hero.body;
    run(sim, 0.1);
    b.setTranslation({ x: 4.0, y: 4.0, z: 0.6 }, true);
    let maxH = 0, landed = false;
    run(sim, 0.3, () => ({ red_hero: cmd({ mx: 1 }) }), (s) => {
      if (s.robots.red_hero.grounded > 0) landed = true;
      if (!landed) { const v = b.linvel(); maxH = Math.max(maxH, Math.hypot(v.x, v.y)); }
    });
    return { pass: maxH < 0.01, detail: `horizontal speed before landing ${maxH.toFixed(3)} m/s (full throttle)` };
  });

  // ---------------------------------------------------------------- 3v3
  const far = (sim, key) => Math.hypot(pos(sim, key).x - spawnOf(key)[0], pos(sim, key).y - spawnOf(key)[1]);

  test('3v3: six robots (Blue mirrored) at rest after 3 s', (sim) => {
    run(sim, 3);
    const b = pos(sim, 'blue_hero');
    return { pass: sim.keys.length === 6 && Math.max(...sim.keys.map((k) => far(sim, k))) < 0.03 && Math.abs(b.x - (12 - 1.1)) < 0.03,
      detail: `${sim.keys.length} robots, most drift ${Math.max(...sim.keys.map((k) => far(sim, k))).toFixed(3)} m, Blue Hero at x ${b.x.toFixed(2)} (Red's 1.10 mirrored)` };
  }, '3v3');

  test('3v3: both Sentries on Auto leave their zones and patrol their own half', (sim) => {
    let crossed = false;
    run(sim, 10, () => ({ red_sentry: cmd({ auto: true }), blue_sentry: cmd({ auto: true }) }), (x) => {
      if (pos(x, 'red_sentry').x > 6 || pos(x, 'blue_sentry').x < 6) crossed = true;
    });
    const r = pos(sim, 'red_sentry'), b = pos(sim, 'blue_sentry');
    const others = Math.max(...['red_hero', 'red_engineer', 'blue_hero', 'blue_engineer'].map((k) => far(sim, k)));
    return { pass: r.y > 2.5 && b.y > 2.5 && !crossed && others < 0.02,
      detail: `Red at (${r.x.toFixed(2)}, ${r.y.toFixed(2)}) ${sim.robots.red_sentry.auto.state}, Blue at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) ${sim.robots.blue_sentry.auto.state}, crossed the centre ${crossed}, others moved ${others.toFixed(3)} m` };
  }, '3v3');

  test('3v3: Red Sentry on Auto shoots the Blue Hero; the kill is +20 Red; not aimed at while invincible', (sim) => {
    sim.hitProbability.red_sentry = 1;
    sim.start();
    sim.place('red_sentry', 4.5, 1.2, 0);
    sim.place('blue_hero', 7.0, 1.2, 180);
    let killedAt = null;
    run(sim, 3, () => ({ red_sentry: cmd({ auto: true }) }), (x) => { if (killedAt === null && !x.robots.blue_hero.alive) killedAt = x.t; });
    const vp = sim.vp.red;
    run(sim, 3, () => ({ red_sentry: cmd({ auto: true }) }));   // respawn after 5 s
    const h = sim.robots.blue_hero;
    let aimedAtInvincible = false;
    run(sim, 2, () => ({ red_sentry: cmd({ auto: true }) }), (x) => { if (x.robots.red_sentry.aimTarget?.ref === h) aimedAtInvincible = true; });
    return { pass: killedAt !== null && vp === 20 && h.alive && h.weakened && sim.t < h.invincibleUntil && !aimedAtInvincible,
      detail: `Blue Hero defeated after ${killedAt?.toFixed(2)} s, Red VP ${vp}; respawned: alive ${h.alive}, weakened ${h.weakened}, invincible ${sim.t < h.invincibleUntil}, aimed at while invincible ${aimedAtInvincible}` };
  }, '3v3');

  test('3v3: Blue Hero in the Red Resupply Zone > 3 s: Yellow Card for Blue only', (sim) => {
    sim.place('red_hero', 4.0, 4.5, 0);   // Red out of its zone (it would heal there)
    sim.place('red_engineer', 4.0, 5.6, 0);
    sim.place('red_sentry', 4.0, 3.3, 0);
    sim.place('blue_engineer', 8.0, 5.6, 180);   // Blue out of its zone too
    sim.place('blue_sentry', 8.0, 3.3, 180);
    sim.start();
    sim.place('blue_hero', 0.8, 1.0, 180);
    run(sim, 3.2);
    const R = sim.robots;
    return { pass: R.blue_hero.hp === 350 - 53 && R.blue_sentry.hp === 400 - 20 && R.blue_engineer.hp === 600 - 30 && R.red_hero.hp === 350 && R.red_sentry.hp === 400,
      detail: `Blue: Hero ${R.blue_hero.hp}, Engineer ${R.blue_engineer.hp}, Sentry ${R.blue_sentry.hp}; Red: Hero ${R.red_hero.hp}, Sentry ${R.red_sentry.hp}` };
  }, '3v3');

  test('3v3: Blue Engineer puts the cube on the Blue Scoring Area: 1 VP/s for Blue', (sim) => {
    const cube = sim.objectives.find((o) => o.type === 'cube');
    sim.placeObjective(cube, 11.0, 5.85, 0.05);
    sim.place('blue_engineer', 11.0, 5.42, 90);
    run(sim, 0.3);
    press(sim, 'blue_engineer');
    const held = !!sim.robots.blue_engineer.held;
    sim.robots.blue_engineer.lift = 0.16;
    sim.place('blue_engineer', 11.05, 6.55, 90);
    run(sim, 0.3);
    press(sim, 'blue_engineer');
    run(sim, 0.3, () => ({ blue_engineer: cmd({ my: -0.5 }) }));
    run(sim, 1);
    sim.start();
    run(sim, 5.05);
    return { pass: held && cube.scoring === 'blue' && sim.vp.blue === 5 && sim.vp.red === 0,
      detail: `grabbed ${held}, scoring ${cube.scoring}, VP after 5 s Blue ${sim.vp.blue} Red ${sim.vp.red}` };
  }, '3v3');

  test('3v3: Gold for both alliances; the Blue Hero buys in the Blue Resupply Zone', (sim) => {
    sim.start();
    run(sim, 1.1);
    const gold = { ...sim.gold };
    sim.step({ blue_hero: cmd({ buy: true, buyEdge: true }) });
    return { pass: gold.red === 80 && gold.blue === 80 && sim.gold.blue === 70 && sim.robots.blue_hero.ammo === 1 && sim.gold.red === 80,
      detail: `Gold after 1 s: Red ${gold.red}, Blue ${gold.blue}; after one buy: Blue ${sim.gold.blue}, Blue Hero ammo ${sim.robots.blue_hero.ammo}` };
  }, '3v3');

  test('spin: the view heading stays while the chassis spins, and the chassis follows the view', (sim) => {
    sim.place('red_hero', 4.0, 3.0, 0);
    run(sim, 0.2);
    sim.step({ red_hero: cmd({ spinEdge: true }) });
    let wz = 0;
    run(sim, 1.5, () => ({}), (x) => { wz = x.robots.red_hero.body.angvel().z; });
    const r = sim.robots.red_hero, viewWhileSpinning = r.viewYaw;
    sim.step({ red_hero: cmd({ spinEdge: true }) });
    run(sim, 0.5, () => ({ red_hero: cmd({ rot: 1 }) }));
    const view = r.viewYaw;
    run(sim, 1.5);
    const err = Math.abs(Math.atan2(Math.sin(view - yawOfBody(r)), Math.cos(view - yawOfBody(r))));
    return { pass: Math.abs(viewWhileSpinning) < 1e-6 && wz > 2 && Math.abs(view - 3) < 0.1 && err < 0.05,   // spin rate: power-limited (~2.6 rad/s with these guesses)
      detail: `spinning at ${wz.toFixed(1)} rad/s, view heading ${viewWhileSpinning.toFixed(3)} rad; turned the view to ${view.toFixed(2)} rad, chassis ${err.toFixed(3)} rad off it 1.5 s later` };
  });

  test('aim: a player\'s Hero locks on only ahead of its view; all round when set so', (sim) => {
    sim.place('blue_engineer', 8.0, 5.6, 180);   // the other Blue robots out of the line of fire
    sim.place('blue_sentry', 8.0, 3.3, 180);
    sim.place('red_hero', 5.0, 0.6, 0);    // open floor along the bottom passage
    sim.place('blue_hero', 3.6, 0.6, 0);   // 1.4 m behind it
    run(sim, 0.5, () => ({ red_hero: cmd({ action: true }) }));
    const behind = sim.robots.red_hero.aimTarget?.ref ?? null;
    run(sim, Math.PI / 6, () => ({ red_hero: cmd({ rot: 1 }) }));   // turn the view round (6 rad/s)
    run(sim, 0.6, () => ({ red_hero: cmd({ action: true }) }));
    const turned = sim.robots.red_hero.aimTarget?.ref ?? null;
    sim.place('red_hero', 5.0, 0.6, 0);
    sim.aimConeDeg = 180;
    run(sim, 0.5, () => ({ red_hero: cmd({ action: true }) }));
    const allRound = sim.robots.red_hero.aimTarget?.ref ?? null;
    const h = sim.robots.blue_hero;
    return { pass: behind === null && turned === h && allRound === h,
      detail: `enemy behind: aimed at ${behind ? sim.name(behind) : 'nothing'}; after turning the view round: ${turned === h ? 'at it' : 'no'}; with all-round aim: ${allRound === h ? 'at it' : 'no'}` };
  }, '3v3');

  test('sentry auto: defeated, respawns Weakened, goes home, heals, patrols again', (sim) => {
    sim.place('red_sentry', 4.5, 3.0, 0);
    run(sim, 0.5, () => ({ red_sentry: cmd({ auto: true }) }));
    sim.defeat(sim.robots.red_sentry, 'test');
    const seen = [];
    let firedWeakened = false;
    run(sim, 30, () => ({ red_sentry: cmd({ auto: true }) }), (x) => {
      const r = x.robots.red_sentry, st = r.alive ? r.auto.state : 'defeated';
      if (seen[seen.length - 1] !== st) seen.push(st);
      if (r.weakened && x.t - r.lastShot < PHYSICS.dt / 2) firedWeakened = true;
    });
    const r = sim.robots.red_sentry, p = pos(sim, 'red_sentry');
    return { pass: seen.join(' ').startsWith('defeated home heal') && seen.includes('patrol') && !r.weakened && !firedWeakened && p.y > 2.5,
      detail: `states ${seen.join(' -> ')}; now HP ${Math.round(r.hp)}, weakened ${r.weakened}, at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}); fired while weakened ${firedWeakened}` };
  }, '3v3');

  test('aim: beyond 3 m a player aims by hand: hits with the barrel on the target, not 20° off', (sim) => {
    sim.place('blue_engineer', 8.0, 5.6, 180);   // out of the line of fire
    sim.place('blue_sentry', 8.0, 3.3, 180);
    sim.place('red_hero', 4.0, 0.6, 0);
    sim.place('blue_hero', 8.0, 0.6, 180);   // 4 m straight ahead
    const h = sim.robots.red_hero, b = sim.robots.blue_hero;
    h.ammo = 10;
    sim.hitProbability.red_hero = 1;
    run(sim, 0.3);
    run(sim, 0.3, () => ({ red_hero: cmd({ action: true }) }));   // one shot (2 per second)
    const locked = !!h.aimTarget, onTarget = b.hp;
    sim.place('red_hero', 4.0, 0.6, 20);
    h.heat = 0;
    const ammo = h.ammo;
    run(sim, 0.3, () => ({ red_hero: cmd({ action: true }) }));
    return { pass: !locked && onTarget === 350 - 200 && b.hp === onTarget && h.ammo < ammo,
      detail: `auto-aim at 4 m: ${locked ? 'locked (wrong)' : 'no lock'}; barrel on it: Blue Hero ${350} -> ${onTarget}; view 20° off: fired ${ammo - h.ammo}, Blue Hero ${b.hp}` };
  }, '3v3');

  test('limbo: with the setting on both Sentries pass under the side and central bars; a Hero cannot', (sim) => {
    sim.sentryLimbo = { red: true, blue: true };
    sim.place('red_sentry', 1.95, 0.55, 0);    // Red Side Limbo Bar at x 2.43-2.57
    sim.place('blue_sentry', 10.05, 0.55, 180);   // Blue's at x 9.43-9.57
    run(sim, 2.5, () => ({ red_sentry: cmd({ mx: 0.6 }), blue_sentry: cmd({ mx: -0.6 }) }));
    const side = [pos(sim, 'red_sentry').x, pos(sim, 'blue_sentry').x];
    sim.place('red_sentry', 5.3, 5.7, 0);      // Central Limbo Bar at x 5.96-6.04
    run(sim, 2, () => ({ red_sentry: cmd({ mx: 0.5 }) }));
    const central = pos(sim, 'red_sentry').x;
    sim.place('red_hero', 1.95, 0.55, 0);
    run(sim, 2.5, () => ({ red_hero: cmd({ mx: 0.6 }) }));
    const hero = pos(sim, 'red_hero').x;
    return { pass: side[0] > 3.0 && side[1] < 9.0 && central > 6.3 && hero < 2.43,
      detail: `side bars: Red Sentry x ${side[0].toFixed(2)}, Blue Sentry x ${side[1].toFixed(2)}; central bar: x ${central.toFixed(2)}; Hero stops at x ${hero.toFixed(2)}` };
  }, '3v3');

  test('limbo: turning the setting off under a bar: no throw, collides again once clear', (sim) => {
    sim.sentryLimbo = { red: true, blue: false };
    sim.place('red_sentry', 2.5, 0.55, 0);   // right under the Red Side Limbo Bar
    run(sim, 0.3);
    sim.sentryLimbo.red = false;
    let maxV = 0;
    run(sim, 1.5, () => ({ red_sentry: cmd({ mx: 0.5 }) }), (x) => { const v = x.robots.red_sentry.body.linvel(); maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z)); });
    const cleared = pos(sim, 'red_sentry').x, under = sim.robots.red_sentry.underLimbo;
    run(sim, 3, () => ({ red_sentry: cmd({ mx: -0.5 }) }));   // back towards the bar: blocked now
    return { pass: maxV < 2.5 && cleared > 2.9 && !under && pos(sim, 'red_sentry').x > 2.57,
      detail: `drove out at up to ${maxV.toFixed(2)} m/s to x ${cleared.toFixed(2)}, passes bars ${under}; driving back stops at x ${pos(sim, 'red_sentry').x.toFixed(2)}` };
  }, '3v3');

  test('sentry auto: with the bars passable it retreats under the Side Limbo Bar (planned), also past a parked Hero', (sim) => {
    const timeHome = (limbo, heroHome = false) => {
      const x = new Sim(sim.R, { random: seeded(2), mode: '3v3', sentryLimbo: limbo });
      if (!heroHome) { x.place('red_hero', 4.0, 6.0, 0); x.place('red_engineer', 4.0, 7.0, 0); }   // out on the field
      x.place('red_sentry', 5.3, 2.2, 0);
      x.robots.red_sentry.hp = 90;
      let t = null, minY = 9;
      run(x, 20, () => ({ red_sentry: cmd({ auto: true }) }), (y, tt) => {
        if (t === null) minY = Math.min(minY, pos(y, 'red_sentry').y);
        if (t === null && y.robots.red_sentry.auto.state === 'heal') t = tt;
      });
      x.world.free();
      return { t, minY };
    };
    const a = timeHome(false), b = timeHome(true), c = timeHome(true, true);
    return { pass: a.t !== null && b.t !== null && b.minY < 1 && b.t < a.t && c.t !== null,
      detail: `from (5.3, 2.2): bars blocked ${a.t?.toFixed(1)} s; bars passable ${b.t?.toFixed(1)} s (lowest y ${b.minY.toFixed(2)}: under the bar); Hero and Engineer in their start spots: ${c.t?.toFixed(1)} s` };
  });

  test('sentry auto: gets home from the far side of the central wall (both alliances, bars either way)', (sim) => {
    const res = [];
    for (const [key, x, y] of [['blue_sentry', 5.0, 4.0], ['red_sentry', 7.0, 4.0], ['blue_sentry', 5.0, 6.6]]) {
      for (const limbo of [false, true]) {
        const s2 = new Sim(sim.R, { random: seeded(3), mode: '3v3', sentryLimbo: limbo });
        s2.place(key, x, y, key.startsWith('blue') ? 180 : 0);
        s2.robots[key].hp = 80;
        let t = null;
        run(s2, 25, () => ({ [key]: cmd({ auto: true }) }), (z, tt) => { if (t === null && z.robots[key].auto.state === 'heal') t = tt; });
        res.push(`${key.split('_')[0]} from (${x}, ${y})${limbo ? ' bars passable' : ''}: ${t === null ? 'NOT home' : `${t.toFixed(1)} s`}`);
        s2.world.free();
      }
    }
    return { pass: res.every((r) => !r.includes('NOT')), detail: res.join('; ') };
  });

  test('sentry auto: patrols and retreats without a Yellow Card (planned around Penalty Zones)', (sim) => {
    sim.start();
    sim.robots.red_sentry.hp = 90;   // straight home first, then patrol
    run(sim, 40, () => ({ red_sentry: cmd({ auto: true }), blue_sentry: cmd({ auto: true }) }));
    const cards = sim.events.filter((e) => /Yellow Card/.test(e.text));
    return { pass: cards.length === 0, detail: `${cards.length} Yellow Cards in 40 s (${cards.map((e) => e.text).join('; ') || 'none'})` };
  }, '3v3');

  test('limbo: the switch is per Sentry: Red on passes, Blue off is stopped', (sim) => {
    sim.sentryLimbo = { red: true, blue: false };
    sim.place('red_sentry', 1.95, 0.55, 0);
    sim.place('blue_sentry', 10.05, 0.55, 180);
    run(sim, 2.5, () => ({ red_sentry: cmd({ mx: 0.6 }), blue_sentry: cmd({ mx: -0.6 }) }));
    const r = pos(sim, 'red_sentry').x, b = pos(sim, 'blue_sentry').x;
    return { pass: r > 3.0 && b > 9.57, detail: `Red Sentry x ${r.toFixed(2)} (passed), Blue Sentry x ${b.toFixed(2)} (bar at 9.43-9.57)` };
  }, '3v3');

  test('sentry auto: locks on all round but only within 3 m', (sim) => {
    sim.place('blue_engineer', 8.0, 5.6, 180);   // the other Blue robots out of sight
    sim.place('blue_sentry', 8.0, 3.3, 180);
    sim.place('red_sentry', 4.0, 0.6, 0);
    sim.place('blue_hero', 9.0, 0.6, 180);   // 5 m ahead, in sight
    let far = null;
    run(sim, 0.5, () => ({ red_sentry: cmd({ auto: true }) }), (x) => { far ??= x.robots.red_sentry.aimTarget; });
    const p = pos(sim, 'red_sentry');
    sim.place('blue_hero', p.x - 2.5, p.y, 0);   // 2.5 m behind it
    let near = null;
    run(sim, 0.5, () => ({ red_sentry: cmd({ auto: true }) }), (x) => { near ??= x.robots.red_sentry.aimTarget; });
    return { pass: far === null && near?.ref === sim.robots.blue_hero,
      detail: `enemy 5 m ahead: ${far ? 'locked (wrong)' : 'no lock'}; 2.5 m behind: ${near ? `locked on ${near.name}` : 'no lock'}` };
  }, '3v3');

  // Red Scoring Area platform: x 0.8-1.1, y 6.85-7.15, top 0.05 m (field data)
  test('scoring: a cube on a donut does not score (the donut under it does); nor a donut on the cube', (sim) => {
    const stack = (bottom, top) => {
      const x = new Sim(sim.R, { random: seeded(4), mode: 'targets' });
      const o = { cube: x.objectives.find((q) => q.type === 'cube'), donut: x.objectives.find((q) => q.type === 'donut' && q.start === 'red') };
      const h = { cube: 0.1, donut: 0.025 };
      x.placeObjective(o[bottom], 0.95, 7.0, 0.05 + h[bottom] / 2 + 0.002);
      x.placeObjective(o[top], 0.95, 7.0, 0.05 + h[bottom] + h[top] / 2 + 0.004);
      run(x, 1.5);
      x.start();
      run(x, 3.05);
      const res = { [bottom]: o[bottom].scoring, [top]: o[top].scoring, vp: x.vp.red, topZ: o[top].body.translation().z };
      x.world.free();
      return res;
    };
    const a = stack('donut', 'cube'), b = stack('cube', 'donut');
    return { pass: a.donut === 'red' && a.cube === null && a.vp === 15 && b.cube === 'red' && b.donut === null && b.vp === 3,
      detail: `cube on donut: donut ${a.donut}, cube ${a.cube} (z ${a.topZ.toFixed(3)}), Red VP in 3 s ${a.vp}; donut on cube: cube ${b.cube}, donut ${b.donut}, Red VP ${b.vp}` };
  });

  test('online: an empty Sentry seat drives itself only when that is on in the room', (sim) => {
    const host = new HostSession(sim, { send() {} }, { mySeat: null, seats: {}, settings: { autoSentry: { red: false, blue: true } } });
    const c = host.commands(null);
    return { pass: !c.red_sentry.auto && c.blue_sentry.auto && !c.red_hero.auto && c.red_sentry.mx === 0,
      detail: `Red Sentry (off): ${c.red_sentry.auto ? 'Auto' : 'stays'}, Blue Sentry (on): ${c.blue_sentry.auto ? 'Auto' : 'stays'}, empty Hero: ${c.red_hero.auto ? 'Auto' : 'stays'}` };
  }, '3v3');

  return out;
}
