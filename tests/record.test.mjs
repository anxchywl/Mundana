// The parts of video recording that need no browser: the composite's size, the file name, the size estimate, the type.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compositeSize, fileName, estimate, sizeText, pickType, support, extOf, TYPES} from '../src/cantus/record.js';

test('the composite: the stage times the pixel ratio, at most 1,920 by 1,080 either way up, even, never scaled up', () => {
  assert.deepEqual(compositeSize(1920, 1080, 2), {width: 1920, height: 1080});
  assert.deepEqual(compositeSize(1280, 800, 2), {width: 1728, height: 1080});
  assert.deepEqual(compositeSize(390, 844, 3), {width: 886, height: 1920});
  assert.deepEqual(compositeSize(360, 640, 2), {width: 720, height: 1280});
  assert.deepEqual(compositeSize(768, 1024, 1), {width: 768, height: 1024});
  assert.deepEqual(compositeSize(801, 601, 1), {width: 800, height: 600});
  for (const [w, h, d] of [[1280, 800, 2], [390, 844, 3], [2560, 1440, 2]]) {
    const s = compositeSize(w, h, d);
    assert.ok(Math.abs(s.width / s.height - w / h) < 0.01, 'the aspect is kept');
  }
});

test('the file name keeps letters, digits, spaces and hyphens', () => {
  assert.equal(fileName('Ode to Joy (live)/2024: "take" 3', 'video/mp4'), 'Ode to Joy live 2024 take 3 - Mundana.mp4');
  assert.equal(fileName('Ünïcødé - Zürich', 'video/webm;codecs=vp9,opus'), 'Ünïcødé - Zürich - Mundana.webm');
  assert.equal(fileName('../../etc', 'video/webm'), 'etc - Mundana.webm');
  assert.equal(fileName('', 'video/mp4'), 'Song - Mundana.mp4');
  assert.equal(extOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2'), 'mp4');
});

test('the size estimate: 5 Mbps of picture and 128 kbps of sound', () => {
  assert.equal(estimate(240), ((5e6 + 128e3) / 8) * 240);
  assert.equal(sizeText(estimate(240)), '154 MB');
  assert.equal(sizeText(estimate(30)), '19 MB');
  assert.equal(sizeText(3.2e6), '3.2 MB');
  assert.equal(sizeText(2.5e9), '2.5 GB');
});

test('the type: the first the browser records, in order; none without captureStream or MediaRecorder', () => {
  const g = (types) => ({
    HTMLCanvasElement: {prototype: {captureStream() {}}},
    MediaRecorder: Object.assign(function () {}, {isTypeSupported: (t) => types.includes(t)}),
  });
  assert.equal(pickType(support(g(['video/webm', 'video/webm;codecs=vp9,opus']))), 'video/webm;codecs=vp9,opus');
  assert.equal(pickType(support(g(TYPES))), TYPES[0]);
  assert.equal(pickType(support(g([]))), null);
  assert.equal(pickType(support({})), null);
});
