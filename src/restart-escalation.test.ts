import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { alertText, readHealth, recordLaunch, restartConfig, restartHealth } from "./restart-escalation.ts";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rs-")), "r.json");
const MIN = 60_000;

test("N launches within the window escalate; the alert is due once per window", () => {
  const p = tmp();
  let t = 1_000_000;
  const res = [];
  for (let i = 0; i < 6; i++) res.push(recordLaunch(p, (t += 60_000), 5, 15 * MIN));
  assert.deepEqual(res.map((r) => r.health.escalated), [false, false, false, false, true, true]);
  assert.deepEqual(res.map((r) => r.alertDue), [false, false, false, false, true, false]);
  assert.match(alertText(res[5].health, "keeper"), /restarted 6x in 15min/);
});

test("old launches fall out of the window (a slow restart cadence never escalates)", () => {
  const p = tmp();
  let t = 0;
  for (let i = 0; i < 20; i++) assert.equal(recordLaunch(p, (t += 5 * MIN), 5, 15 * MIN).health.escalated, false);
});

test("readHealth does not mutate; restartHealth is null without a path; config from env", () => {
  const p = tmp();
  recordLaunch(p, 1000, 2, 15 * MIN);
  const before = fs.readFileSync(p, "utf8");
  assert.equal(readHealth(p, 2000, 2, 15 * MIN).launchesInWindow, 1);
  assert.equal(fs.readFileSync(p, "utf8"), before);
  assert.equal(restartHealth({}), null);
  assert.deepEqual(restartConfig({ KEEPER_HEALTH_FILE: "/x/h.json", KEEPER_RESTART_ALERT_N: "3" }), { path: "/x/h.json.restarts.json", threshold: 3, windowMs: 15 * MIN });
});

test("a corrupt file or unwritable path never throws", () => {
  const p = tmp();
  fs.writeFileSync(p, "{not json");
  assert.equal(recordLaunch(p, 1, 5, MIN).health.launchesInWindow, 1);
  assert.doesNotThrow(() => recordLaunch("/nonexistent-dir/x.json", 1, 5, MIN));
});
