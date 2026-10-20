// The audio analysis, off the page's thread. The page sends {samples, sr} once, the samples transferred rather than
// copied; this worker answers with {type: 'progress', stage, fraction} as it goes, then {type: 'done', timeline, info}
// or {type: 'error', message}. To cancel, the page ends the worker.

import {analyseAudio} from './analyse.js?v=28';

self.onmessage = (e) => {
  const {samples, sr} = e.data || {};
  try {
    const {timeline, info} = analyseAudio(samples, sr, (stage, fraction) => self.postMessage({type: 'progress', stage, fraction}));
    self.postMessage({type: 'done', timeline, info});
  } catch (err) {
    const message =
      err instanceof RangeError
        ? 'Not enough memory for this song. Try a shorter one.'
        : err instanceof Error && err.message && err.message.length < 80
          ? err.message
          : 'This song could not be read.';
    self.postMessage({type: 'error', message});
  }
};
