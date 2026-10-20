// Recording a show as a video file, picture and sound together, on the device. Each frame the fractal canvas and the
// orbit canvas are drawn into a third canvas that is not on the page, with a small caption; that canvas is captured
// one frame per frame of the show, and the sound is taken from the page's volume node, the same one the speakers
// hear. MediaRecorder joins them into one file. The top of this file is plain JavaScript, so Node runs it in the tests.

/** the file types to record, best first */
export const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const VIDEO_BITS = 5000000;
export const AUDIO_BITS = 128000;
export const MAX_LONG = 1920; // the composite's longer side, and its shorter one
export const MAX_SHORT = 1080;
export const SLICE_MS = 1000;
export const COUNT_IN_MS = 1000;

/** what this browser can do: {captureStream, requestFrame, mediaRecorder, types: [[type, supported]]} */
export const support = (g = globalThis) => {
  const MR = g.MediaRecorder;
  const track = g.CanvasCaptureMediaStreamTrack;
  return {
    captureStream: typeof g.HTMLCanvasElement?.prototype?.captureStream === 'function',
    requestFrame: !!track && typeof track.prototype.requestFrame === 'function',
    mediaRecorder: typeof MR === 'function',
    types: TYPES.map((t) => [t, typeof MR?.isTypeSupported === 'function' && MR.isTypeSupported(t)]),
  };
};

/** the first type this browser records, or null when it cannot record video at all */
export const pickType = (s = support()) => (s.captureStream && s.mediaRecorder ? s.types.find(([, ok]) => ok)?.[0] ?? null : null);

/** the file extension for a type */
export const extOf = (type) => (/^video\/mp4/.test(type) ? 'mp4' : 'webm');

/**
 * The composite's size in pixels: the stage times the pixel ratio, scaled down (never up) so the longer side is at
 * most 1,920 and the shorter at most 1,080, keeping the aspect; both sides even, as video encoders want.
 */
export const compositeSize = (w, h, dpr = 1) => {
  const W = Math.max(2, w * dpr);
  const H = Math.max(2, h * dpr);
  const long = Math.max(W, H);
  const short = Math.min(W, H);
  const k = Math.min(1, MAX_LONG / long, MAX_SHORT / short);
  const even = (v) => Math.max(2, 2 * Math.floor((v * k + 1e-6) / 2));
  return {width: even(W), height: even(H)};
};

/** the bytes a recording of `seconds` takes at the bit rates */
export const estimate = (seconds, video = VIDEO_BITS, audio = AUDIO_BITS) => ((video + audio) / 8) * Math.max(0, seconds);

/** "12 MB", "1.4 GB" */
export const sizeText = (bytes) => {
  const mb = bytes / 1e6;
  if (mb < 1) return 'under 1 MB';
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString('en')} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
};

/** "<title> - Mundana.<ext>", the title cleaned of anything but letters, digits, spaces and hyphens */
export const fileName = (title, type) => {
  const clean = String(title ?? '')
    .replace(/[^\p{L}\p{N} -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${clean || 'Song'} - Mundana.${extOf(type)}`;
};

// ---------- the page ----------

/**
 * One recording. `fractal` and `overlay` are the page's canvases, `ctx` and `gain` its AudioContext and volume node,
 * `title` the song's, `type` from pickType. Call frame() after every frame of the show is drawn; stop() resolves to
 * the file as a Blob. `bytes` is what has been recorded so far.
 */
export class Recorder {
  constructor({fractal, overlay, ctx, gain, title, type, stageW, stageH, dpr, paper, bits = VIDEO_BITS}) {
    this.fractal = fractal;
    this.overlay = overlay;
    this.title = String(title ?? '');
    this.type = type;
    this.paper = paper;
    const size = compositeSize(stageW, stageH, dpr);
    this.canvas = document.createElement('canvas');
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.g = this.canvas.getContext('2d', {alpha: false});
    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    // with no requestFrame the stream takes frames on its own clock
    if (typeof this.track.requestFrame !== 'function') {
      this.track.stop();
      this.stream = this.canvas.captureStream(60);
      this.track = this.stream.getVideoTracks()[0];
    }
    this.gain = gain;
    this.dest = ctx.createMediaStreamDestination();
    gain.connect(this.dest);
    const both = new MediaStream([this.track, ...this.dest.stream.getAudioTracks()]);
    this.chunks = [];
    this.bytes = 0;
    this.frames = 0;
    this.media = new MediaRecorder(both, {mimeType: type, videoBitsPerSecond: bits, audioBitsPerSecond: AUDIO_BITS});
    this.media.ondataavailable = (e) => {
      if (e.data?.size) {
        this.chunks.push(e.data);
        this.bytes += e.data.size;
      }
    };
    this.frame();
  }

  start() {
    this.started = performance.now();
    this.media.start(SLICE_MS);
  }

  /** the picture as it is now, with the caption, as the next frame of the video */
  frame() {
    const {g, canvas} = this;
    const w = canvas.width;
    const h = canvas.height;
    g.drawImage(this.fractal, 0, 0, w, h);
    g.drawImage(this.overlay, 0, 0, w, h);
    const px = Math.max(12, Math.round(Math.min(w, h) / 45));
    g.font = `500 ${px}px Jost, system-ui, sans-serif`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = this.paper;
    const caption = this.title ? `${this.title}  ·  Mundana` : 'Mundana';
    g.fillText(caption, Math.round(px * 1.2), h - Math.round(px * 1.1), w - px * 2.4);
    if (this.track.requestFrame) this.track.requestFrame();
    this.frames++;
  }

  /** stop and give the file */
  stop() {
    return new Promise((resolve) => {
      const done = () => {
        const blob = new Blob(this.chunks, {type: this.type.split(';')[0]});
        this.release();
        resolve(blob);
      };
      if (this.media.state === 'inactive') return done();
      this.media.onstop = done;
      this.media.stop();
    });
  }

  release() {
    this.chunks = [];
    try {
      this.gain.disconnect(this.dest);
    } catch {
      // already apart
    }
    for (const t of this.stream.getTracks()) t.stop();
    for (const t of this.dest.stream.getTracks()) t.stop();
  }
}
