import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFaceToGaze, GazeSmoother } from '../../../src/desktop/gazeTracking.ts';

test('front camera coordinates turn toward the viewer on both axes', () => {
  assert.ok(cameraFaceToGaze(.25, .5).x > 0);
  assert.ok(cameraFaceToGaze(.75, .5).x < 0);
  assert.ok(cameraFaceToGaze(.5, .25).y > 0);
  assert.ok(cameraFaceToGaze(.5, .75).y < 0);
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
