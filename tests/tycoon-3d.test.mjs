import test from "node:test";
import assert from "node:assert/strict";

import {
  computePerspectiveRigPose,
  readTycoonVisualPrefs,
  resolveLabelCollisionLayout,
  resolveWorkstationLodMode,
  shortestAngleDelta,
  writeTycoonVisualPrefs,
} from "../public/tycoon-3d.js";
import { renderTycoonHudHtml } from "../public/mission-overview.js";

test("shortestAngleDelta wraps cleanly across +/-PI without full-circle jitter", () => {
  const from = Math.PI - 0.1;
  const to = -Math.PI + 0.1;
  const delta = shortestAngleDelta(from, to);
  assert.ok(Math.abs(delta - 0.2) < 1e-9, `expected ~0.2, got ${delta}`);

  const rev = shortestAngleDelta(to, from);
  assert.ok(Math.abs(rev + 0.2) < 1e-9, `expected ~-0.2, got ${rev}`);
});

test("computePerspectiveRigPose couples zoom >= 1.4 to ~24 deg pitch and elevated lookY", () => {
  const overview = computePerspectiveRigPose({ x: 0, z: 0, zoom: 0.92, blend: 1 });
  assert.equal(Math.round(overview.fov), 36);
  assert.ok(overview.pitchDeg >= 39 && overview.pitchDeg <= 41);
  assert.equal(overview.lookY, 0);

  const focused = computePerspectiveRigPose({ x: -10, z: -8, zoom: 1.42, blend: 1 });
  assert.equal(Math.round(focused.fov), 36);
  assert.ok(focused.pitchDeg <= 24.5 && focused.pitchDeg >= 23.8, `pitchDeg=${focused.pitchDeg}`);
  assert.ok(focused.lookY >= 1.1 && focused.lookY <= 1.2, `lookY=${focused.lookY}`);

  const midBlend = computePerspectiveRigPose({ x: 0, z: 0, zoom: 1, blend: 0 });
  assert.equal(Math.round(midBlend.fov), 6);
  assert.equal(midBlend.lookY, 0);
});

test("resolveWorkstationLodMode enforces 3-level zoom LOD while keeping pending and focused cards full", () => {
  assert.equal(resolveWorkstationLodMode({ zoom: 0.72, isResting: true }), "micro");
  assert.equal(resolveWorkstationLodMode({ zoom: 0.72, isResting: false }), "mid");
  assert.equal(resolveWorkstationLodMode({ zoom: 0.72, isResting: false, isPending: true }), "full");
  assert.equal(resolveWorkstationLodMode({ zoom: 0.72, isResting: true, isSelected: true }), "full");

  assert.equal(resolveWorkstationLodMode({ zoom: 1.0, isResting: true }), "mid");
  assert.equal(resolveWorkstationLodMode({ zoom: 1.0, isResting: false, isHovered: true }), "full");
  assert.equal(resolveWorkstationLodMode({ zoom: 1.0, isResting: true, isSearchHit: true }), "full");

  assert.equal(resolveWorkstationLodMode({ zoom: 1.35, isResting: true }), "full");
});

test("resolveLabelCollisionLayout keeps higher-priority pending label anchored and displaces lower-priority overlap", () => {
  const layout = resolveLabelCollisionLayout([
    { id: "ws:resting", ax: 400, ay: 300, w: 120, h: 32, priority: 10, visible: true },
    { id: "ws:pending", ax: 405, ay: 302, w: 140, h: 48, priority: 82, visible: true },
  ], { w: 1280, h: 720 });

  const pendingBox = layout.get("ws:pending");
  const restingBox = layout.get("ws:resting");
  assert.ok(pendingBox && restingBox);
  assert.equal(pendingBox.dist, 0);
  assert.ok(restingBox.dist > 10, `expected displaced resting label dist > 10, got ${restingBox.dist}`);
});

test("readTycoonVisualPrefs / writeTycoonVisualPrefs safely fall back and persist", () => {
  const defaults = readTycoonVisualPrefs();
  assert.deepEqual(defaults, { perspective: false, tiltShift: false, bloom: true });

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    const saved = writeTycoonVisualPrefs({ perspective: true, tiltShift: true, bloom: false });
    assert.deepEqual(saved, { perspective: true, tiltShift: true, bloom: false });
    assert.deepEqual(readTycoonVisualPrefs(), { perspective: true, tiltShift: true, bloom: false });
  } finally {
    delete globalThis.localStorage;
  }
});

test("renderTycoonHudHtml includes visual toggles and Space pending shortcut hint", () => {
  const pendingThread = {
    id: "codex:default:pend-1",
    provider: "codex",
    profileId: "default",
    title: "待拍板测试",
    pendingCount: 1,
    live: false,
    updatedAt: Math.floor(Date.now() / 1000) - 20,
  };
  const overview = {
    domains: [{
      id: "indie-lab",
      name: "软件研发室",
      topics: [{
        id: "t1",
        domainId: "indie-lab",
        name: "测试产线",
        pendingCount: 1,
        liveCount: 0,
        pipeline: { stageIndex: 2, stageLabel: "研发", readyToHarvest: false },
        activeThreads: [pendingThread],
        archivedThreads: [],
      }],
    }],
    topics: [{ id: "t1", name: "测试产线" }],
    bossFocus: [],
    incubator: { eggs: [], chilled: [], totalActive: 0, chilledCount: 0 },
    unassignedActive: [],
    radar: { liveThreads: [], pendingThreads: [pendingThread], totalActiveCount: 1, driftedCount: 0, harvestReadyCount: 0 },
    meta: {},
  };

  const html = renderTycoonHudHtml(overview, {});
  assert.match(html, /data-tycoon-toggle-vis="perspective"/);
  assert.match(html, /36° 透视/);
  assert.match(html, /data-tycoon-toggle-vis="tiltShift"/);
  assert.match(html, /移轴景深/);
  assert.match(html, /data-tycoon-toggle-vis="bloom"/);
  assert.match(html, /泛光/);
  assert.match(html, /tycoon-space-kbd">Space<\/kbd>/);
});
