import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFaceToGaze, FACE_LOSS_GRACE_MS, GazeSmoother } from '../../../src/desktop/gazeTracking.ts';

test('front camera coordinates turn toward the viewer on both axes', () => {
  assert.ok(cameraFaceToGaze(.25, .5).x > 0);
  assert.ok(cameraFaceToGaze(.75, .5).x < 0);
  assert.ok(cameraFaceToGaze(.5, .25).y > 0);
  assert.ok(cameraFaceToGaze(.5, .75).y < 0);
  assert.equal(cameraFaceToGaze(0, .5).x, .85);
});

test('small detector jitter is held and larger movement eases toward the face', () => {
  const filter = new GazeSmoother();
  const initial = filter.update(cameraFaceToGaze(.5, .5), 1000);
  const jitter = filter.update(cameraFaceToGaze(.49, .51), 1080);
  assert.deepEqual(jitter, initial);
  const movement = filter.update(cameraFaceToGaze(.2, .3), 1160);
  assert.ok(movement.x > 0 && movement.x < .6);
  assert.ok(movement.y > 0 && movement.y < .4);
  const continued = filter.update(cameraFaceToGaze(.2, .3), 1240);
  assert.ok(continued.x > movement.x && continued.y > movement.y);
});

test('lost detections hold the last gaze and reacquisition cannot snap the head', () => {
  const filter = new GazeSmoother();
  assert.equal(filter.update(cameraFaceToGaze(.1, .5), 1000).x, 0);
  const first = filter.update(cameraFaceToGaze(.1, .5), 1080);
  assert.ok(first.x > 0 && first.x <= .0521);
  const held = filter.update({ x: 0, y: 0, found: false }, 1500);
  assert.deepEqual(held, { x: first.x, y: first.y, found: true });
  const heldAfterTurningAway = filter.update({ x: 0, y: 0, found: false }, 1080 + FACE_LOSS_GRACE_MS - 100);
  assert.equal(heldAfterTurningAway.x, first.x);
  const recentering = filter.update({ x: 0, y: 0, found: false }, 1080 + FACE_LOSS_GRACE_MS + 100);
  assert.ok(recentering.x < first.x && recentering.x >= 0);
  const reacquired = filter.update(cameraFaceToGaze(.9, .5), 1080 + FACE_LOSS_GRACE_MS + 180);
  assert.ok(Math.abs(reacquired.x - recentering.x) <= .0521);
});

test('a single far-off detector box has only a small effect', () => {
  const filter = new GazeSmoother();
  filter.update(cameraFaceToGaze(.5, .5), 1000);
  const spike = filter.update(cameraFaceToGaze(0, .5), 1080);
  assert.ok(spike.x > 0 && spike.x <= .0521);
  const recovered = filter.update(cameraFaceToGaze(.5, .5), 1160);
  assert.ok(recovered.x <= spike.x);
});
