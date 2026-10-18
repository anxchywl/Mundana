// The audio worklet globals, just enough to run src/synth-worklet.js in Node, block by block, with currentFrame.
const SR = 48000;
const registered = [];
globalThis.sampleRate = SR;
globalThis.currentFrame = 0;
globalThis.registerProcessor = (name, cls) => registered.push({name, cls});
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.sent = [];
    this.port = {onmessage: null, postMessage: (m) => this.sent.push(m)};
  }
};
await import('../src/synth-worklet.js');
export const Host = registered.find((r) => r.name === 'orbit-synth').cls;
export {SR};

/** render `seconds` through a host, 128 samples a block; messages at [time, message] arrive before their block */
export const runHost = (host, seconds, timed = []) => {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  let e = 0;
  for (let i = 0; i < n; i += 128) {
    while (e < timed.length && timed[e][0] * SR <= i) host.port.onmessage({data: timed[e++][1]});
    globalThis.currentFrame = i;
    host.process([], [[bl, br]]);
    const m = Math.min(128, n - i);
    L.set(bl.subarray(0, m), i);
    R.set(br.subarray(0, m), i);
  }
  return {L, R};
};
