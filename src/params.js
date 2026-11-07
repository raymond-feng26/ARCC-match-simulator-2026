// Every tunable of the match simulator. Rule values: ARCC Season 2 Events Manual V1.0 (cited by
// section); robot sizes, masses and drive values are guesses until mechanical / embedded measure
// them (marked GUESS).

export const RULES = {
  battleSeconds: 300,        // 3: five-minute Battle
  vpToWin: 300,              // 3.3.4
  vp: { cubePerSec: 1, donutPerSec: 5, pipe: 30, kill: 20 },
  // 3.3.3 passive Gold Coins at remaining time (s)
  gold: [[299, 80], [239, 80], [179, 80], [119, 80], [59, 120]],
  goldPer42: 10,
  penaltyZoneSeconds: 3,     // R48
  penaltyRepeatSeconds: 10,  // R48 / R51: a further Yellow Card every 10 s
  yellow: { offenderHp: 0.15, othersHp: 0.05, sentryChassisOff: 2, offenderBlock: 5, othersBlock: 2 },
  respawnFirst: 5, respawnStep: 5,   // 3.3.2.2
  respawnHp: 0.2, invincibleSeconds: 10,
  healPerSec: 0.25,          // 3.3.2.1, in own Resupply Zone
  heat: { per17: 10, per42: 100, extra17: 100, extra42: 200 },   // 3.3.1.3
};

// Robot classes (3.1 / RBS 2.4). Body: chassis box (skirt) + upper box; z from the floor.
export const ROBOTS = {
  hero: {
    id: 1, name: 'Hero', maxHp: 350, powerW: 80, launcher: '42',
    heatMax: 200, coolPerSec: 24, fireRateHz: 2, ammo: 0, rangeM: 9,
    gimbalYawRate: 12,                           // rad/s (GUESS)
    mass: 30,                                    // GUESS (limit 39 kg)
    chassis: [0.65, 0.65, 0.015, 0.24],          // GUESS length, width, skirt bottom, top
    upper: [0.36, 0.36, 0.55],                   // GUESS length, width, top (height)
  },
  engineer: {
    id: 2, name: 'Engineer', maxHp: 600, powerW: 80, launcher: null,
    mass: 30,                                    // GUESS (limit 39 kg)
    chassis: [0.55, 0.55, 0.015, 0.22],          // GUESS
    upper: [0.40, 0.40, 0.45],                   // GUESS
    // grab point: reach beyond the chassis front, lift height above the floor under the robot
    reach: [0.05, 0.45], lift: [0.03, 0.75], reachRate: 0.6, liftRate: 0.6, grabRadius: 0.22,   // grab: objective within this of the grab point (0.16 until 11-05)
  },
  sentry: {
    id: 7, name: 'Sentry', maxHp: 400, powerW: 80, launcher: '17',
    heatMax: 260, coolPerSec: 30, fireRateHz: 15, ammo: 750, rangeM: 8,
    gimbalYawRate: 8.2,                          // rad/s, measured 2026-11-07: 10 turns in 7.7 s
    mass: 26,                                    // GUESS (limit 28 kg)
    chassis: [0.55, 0.55, 0.015, 0.20],          // skirt ~15 mm (team: the sentry has a skirt)
    upper: [0.30, 0.30, 0.57],                   // robot.yaml robot_height 0.57
  },
};

// Chassis model: a powered rigid body. Force towards the commanded velocity, limited by wheel
// traction (mu m g) and by power (P / v). Losses make the power-limited top speed.
export const DRIVE = {
  maxSpeed: 3.0,           // m/s, motor speed cap (GUESS)
  responseHz: 8,           // how hard the speed controller pushes towards the command
  tractionMu: 0.5,         // omni wheels (GUESS): 0.5 g ~ 4.9 m/s^2 at most
  efficiency: 0.7,         // electrical -> wheel power
  rollingN: 0.03,          // rolling resistance x m g
  dragPerMs: 4.4,          // N per m/s, with the above: ~2.8 m/s top speed at 80 W
  maxYawRate: 6.0,         // rad/s
  yawFollowGain: 8,        // 1/s: chassis turns towards the view heading (unless spinning)
  spinYawRate: 6.0,        // rad/s, spin (top) mode
  yawResponseHz: 10,
  capJ: 1500,              // usable supercapacitor energy (GUESS, limit 2000 J nominal)
  capBoostW: 120,          // extra power while boost is held and the capacitor has energy
  capChargeEff: 0.8,
};

export const SHOOT = {
  hitProbability: { hero: 0.3, sentry: 0.4 },   // adjustable in the UI
  damage: { '17': 20, '42': 200 },               // 3.3.1.1 Table 3-8
  guardHeat: true,                               // stop firing before exceeding the heat limit
  aimLockM: 3,
  sentryLockM: 3,     // a Sentry on Auto locks on all round, but only this close (team choice 11-05)        // a player's auto-aim locks on only this close; farther, aim by hand (barrel on the target)
  aimConeDeg: 60,     // a player's auto-aim locks on only this far either side of the view (chase camera
                      // shows ~±38°); a Sentry on Auto aims all round
};

// Fixed targets on the Blue side (field x, y, z of the floor under them; yaw deg; HP).
export const TARGETS = [
  { name: 'Target A', x: 8.0, y: 2.0, yaw: 180, hp: 400 },
  { name: 'Target B', x: 9.6, y: 5.3, yaw: 180, hp: 350 },
  { name: 'Target C', x: 7.1, y: 7.0, yaw: 180, hp: 600 },   // on the Central High Ground
];
export const TARGET_RESPAWN_S = 10;

// Sentry auto mode: patrol loop in the own half, home to heal; routes planned on the field
// (planner.js); stop when another robot is close ahead. Red coordinates; Blue's are mirrored
// (x -> 12 - x).
export const SENTRY_AUTO = {
  patrol: [[3.6, 3.5], [5.3, 2.2], [5.3, 5.2], [3.6, 5.2]],
  homeSpot: [0.6, 1.5],     // in the Resupply Zone, clear of the Hero and Engineer start spots; the way there is planned
  speed: 2.0,               // m/s, = the real Sentry's navigation limit (robot.yaml max_speed, 2026-11-07)
  retreatHp: 0.25,          // team decision 2026-11-05: retreat at 25 % HP
  leaveHealedAt: 0.95,
  stopGap: 0.35,            // m between bodies along the travel direction
  stopSideMargin: 0.05,     // m: counts as in the way when sideways closer than both bodies + this
  detourAfter: 0.8,         // s stopped before trying to go round
  detourFor: 0.8,           // s on a detour heading before trying the path again
  spin: false,
};

// Objectives (3.2.4). Masses are GUESSES.
export const OBJECTIVES = {
  cube: { size: 0.1, mass: 0.25 },
  donut: { outer: 0.05, inner: 0.025, thick: 0.025, mass: 0.12 },
  pipe: { radius: 0.01335, length: 0.5, mass: 0.18 },
  bucket: { radius: 0.1, height: 0.25, wall: 0.006, mass: 0.8 },
  pipeTurnInRadius: 0.16,   // grab point within this of the Pipe Chute centre turns the pipe in
  bucketSpillDeg: 25,       // the pipes left in the bucket fall out when it leans further
};

export const PHYSICS = {
  dt: 1 / 120, maxSubSteps: 6, gravity: 9.81,
  // most a body may leave a physics step with (m/s, rad/s): above any real motion here (3 m/s
  // drive, 15 deg ramps, 0.41 m drops), below what a solver blow-up gives
  limits: { robotXY: 4.5, robotUp: 1.5, robotSpin: 12, objective: 8, objectiveSpin: 400, fall: 8 },   // a pipe rolling at 1 m/s spins at 75 rad/s
};

// Gamepad: right stick left / right turns at this share of DRIVE.maxYawRate at full deflection
// (keys always turn at the full rate). Adjustable in Settings.
export const GAMEPAD = { turnSensitivity: 0.75 };

// Key bindings (KeyboardEvent.code). Engineer: action = grab / release.
export const KEYSETS = {
  wasd: {
    label: 'Keyboard WASD',
    up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', rotL: 'KeyQ', rotR: 'KeyE',
    action: 'Space', liftUp: 'KeyR', liftDown: 'KeyF', reachOut: 'KeyT', reachIn: 'KeyG',
    boost: 'ShiftLeft', buy: 'KeyB', spin: 'KeyC',
  },
  arrows: {
    label: 'Keyboard Arrows',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    rotL: 'Comma', rotR: 'Period', action: 'Enter', liftUp: 'Semicolon', liftDown: 'Slash',
    reachOut: 'BracketRight', reachIn: 'BracketLeft', boost: 'ShiftRight', buy: 'Backslash',
    spin: 'Quote',
  },
};
