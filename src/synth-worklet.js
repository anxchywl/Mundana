// The audio thread's side of the instrument: a thin host around one Voice (src/voice.js), which holds the sound
// itself. It forwards the page's messages to the voice and tells the page when the orbit escapes.

import {Voice} from './voice.js?v=23';

class OrbitVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voice = new Voice(sampleRate);
    this.voice.onEscape = () => this.port.postMessage({type: 'escaped'});
    this.port.onmessage = (e) => this.voice.message(e.data);
  }

  process(_inputs, outputs) {
    const L = outputs[0][0];
    const R = outputs[0][1] || L;
    this.voice.render(L, R, 0, L.length);
    return true;
  }
}

registerProcessor('orbit-synth', OrbitVoice);
