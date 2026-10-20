// Plays a ShowPlan on the AudioContext clock. A timer wakes the scheduler every 25 ms, and each wake sends the presses
// and releases that fall within the next 0.1 s, each stamped with the exact context time it must sound at. The timer
// only decides when messages are sent, never when a note plays, so a late wake costs nothing as long as it is within
// the horizon. Song time maps to context time through anchors: ctx = anchor.ctx + (song - anchor.song) / speed.

export const WAKE_MS = 25;
export const HORIZON = 0.1;
export const HORIZON_LATE = 0.3; // after one wake more than 50 ms late, for the rest of the show
export const LATE_S = 0.05;
export const START_DELAY = 0.05; // play and seek start this far ahead, so the first notes are not late
export const MIN_LOOP = 0.25;

/** the index of the first event at or after `time` */
const firstFrom = (events, time) => {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export class Transport {
  /**
   * ctx: the AudioContext (currentTime, getOutputTimestamp, outputLatency, baseLatency are read). send(m): posts a
   * message to the worklet. plan: a ShowPlan. onEnd: called when the song has played to its end. onAnchor(anchor):
   * called with each new anchor {ctx, song} (play, seek, a loop wrap), for sound that must start with the song. timer
   * and wallNow are there for the tests.
   */
  constructor({ctx, send, plan, onEnd = () => {}, onAnchor = () => {}, timer = {set: (f, ms) => setInterval(f, ms), clear: (id) => clearInterval(id)}, wallNow = () => performance.now()}) {
    this.ctx = ctx;
    this.post = send;
    this.plan = plan;
    this.onEnd = onEnd;
    this.onAnchor = onAnchor;
    this.timer = timer;
    this.wallNow = wallNow;
    this.load(plan);
    this.state = 'stopped';
    this.pos = 0;
    this.speed = 1;
    this.horizon = HORIZON;
    this.anchors = [];
    this.cursor = 0;
    this.loop = null;
    this.id = 0;
    this.lastWake = 0;
    this.sent = 0;
    this.minLead = Infinity; // the smallest time between sending a message and its sample, for the report
    this.sentTo = 0; // song time, on the last anchor, up to which messages have been sent
    this.next = null; // a new plan waiting for the next wake
  }

  /** take a plan's presses and releases, in one list by time; at the same time a release comes first, so it never
   * ends a new note */
  load(plan) {
    this.plan = plan;
    this.duration = plan.timeline.duration;
    this.presses = plan.presses;
    this.voices = 1 + plan.presses.reduce((m, p) => Math.max(m, p.voice), 0);
    const events = [];
    for (const p of plan.presses) {
      events.push({time: p.time, kind: 1, press: p});
      events.push({time: p.time + p.duration, kind: 0, press: p});
    }
    events.sort((a, b) => a.time - b.time || a.kind - b.kind);
    this.events = events;
    if (this.loop) {
      this.loop.b = Math.min(this.loop.b, this.duration);
      if (!(this.loop.b - this.loop.a >= MIN_LOOP)) this.loop = null;
    }
  }

  /**
   * A new plan for the same song (the notes were edited). Stopped or paused, it is taken at once. Playing, the show
   * keeps playing and the next wake changes over where the messages sent so far end: every voice is released there,
   * the new plan's notes sounding at that moment are pressed again from where they are, and the rest follow.
   */
  setPlan(plan) {
    if (this.state === 'playing') {
      this.next = plan;
      return;
    }
    this.load(plan);
    this.pos = Math.min(this.pos, this.duration);
  }

  swap() {
    const plan = this.next;
    this.next = null;
    const anchor = this.anchors[this.anchors.length - 1];
    let T = this.sentTo;
    let at = this.ctxOf(anchor, T);
    // a late wake: the change cannot be in the past
    const soonest = this.ctx.currentTime + 0.01;
    if (at < soonest) {
      T = anchor.song + (soonest - anchor.ctx) * this.speed;
      at = soonest;
    }
    const voices = Math.max(this.voices, 1 + plan.presses.reduce((m, p) => Math.max(m, p.voice), 0));
    for (let v = 0; v < voices; v++) this.send({type: 'release', voice: v, at});
    this.load(plan);
    this.cursor = firstFrom(this.events, T);
    this.sentTo = T;
    this.pressHeld(T, at);
  }

  /** the context time that is reaching the speakers right now */
  audibleCtx() {
    const ctx = this.ctx;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) {
      return Math.min(ctx.currentTime, ts.contextTime + (this.wallNow() - ts.performanceTime) / 1000);
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  songAt(ctxTime) {
    const a = this.anchors;
    let k = a.length - 1;
    while (k > 0 && a[k].ctx > ctxTime) k--;
    if (ctxTime < a[k].ctx) return a[k].song;
    return a[k].song + (ctxTime - a[k].ctx) * this.speed;
  }

  ctxOf(anchor, song) {
    return anchor.ctx + (song - anchor.song) / this.speed;
  }

  /** the song time you hear now */
  now() {
    if (this.state !== 'playing') return this.pos;
    return Math.max(0, Math.min(this.duration, this.songAt(this.audibleCtx())));
  }

  /** the song time the speakers play at wall time `ms` (performance.now() time), now or a little ahead: the picture
   * asks for the moment its frame will be on screen */
  songAtWall(ms) {
    if (this.state !== 'playing') return this.pos;
    const ctx = this.ctx;
    const ts = ctx.getOutputTimestamp?.();
    const c =
      ts && ts.performanceTime > 0
        ? ts.contextTime + (ms - ts.performanceTime) / 1000
        : ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) + (ms - this.wallNow()) / 1000;
    return Math.max(0, Math.min(this.duration, this.songAt(c)));
  }

  send(m) {
    this.minLead = Math.min(this.minLead, m.at - this.ctx.currentTime);
    this.sent++;
    this.post(m);
  }

  pressAt(p, at, offset = 0) {
    this.send({type: 'press', voice: p.voice, at, fractal: p.fractal, p: p.point, z0: p.z0, rate: p.rate, velocity: p.velocity, offset, releaseS: p.releaseS});
  }

  /** every note that is sounding at song time t, pressed at context time `at` as if it began `t - start` ago */
  pressHeld(t, at) {
    for (const p of this.presses) {
      if (p.time >= t) break;
      if (p.time + p.duration > t) this.pressAt(p, at, t - p.time);
    }
  }

  startAt(t) {
    if (this.next) this.load(this.next);
    this.next = null;
    t = Math.min(t, this.duration);
    const at = this.ctx.currentTime + START_DELAY;
    this.anchors = [{ctx: at, song: t}];
    this.onAnchor(this.anchors[0]);
    this.cursor = firstFrom(this.events, t);
    this.sentTo = t;
    this.pressHeld(t, at);
    this.state = 'playing';
    this.lastWake = this.wallNow();
    if (!this.id) this.id = this.timer.set(() => this.wake(), WAKE_MS);
    this.wake();
  }

  wake() {
    if (this.state !== 'playing') return;
    const wall = this.wallNow();
    if (wall - this.lastWake > WAKE_MS + LATE_S * 1000) this.horizon = HORIZON_LATE;
    this.lastWake = wall;
    if (this.next) this.swap();
    const limit = this.ctx.currentTime + this.horizon;
    // a loop can wrap more than once within one horizon only if it is very short; MIN_LOOP keeps it to a few
    for (let guard = 0; guard < 8; guard++) {
      const anchor = this.anchors[this.anchors.length - 1];
      const until = anchor.song + (limit - anchor.ctx) * this.speed;
      const end = this.loop ? Math.min(until, this.loop.b) : until;
      const ev = this.events;
      while (this.cursor < ev.length && ev[this.cursor].time < end) {
        const e = ev[this.cursor++];
        const at = this.ctxOf(anchor, e.time);
        if (e.kind) this.pressAt(e.press, at);
        else this.send({type: 'release', voice: e.press.voice, at});
      }
      this.sentTo = Math.max(this.sentTo, end);
      if (!this.loop || until < this.loop.b) break;
      // the wrap is scheduled inside the horizon: the end of the loop and its start share one sample
      const at = this.ctxOf(anchor, this.loop.b);
      for (let v = 0; v < this.voices; v++) this.send({type: 'release', voice: v, at});
      this.anchors.push({ctx: at, song: this.loop.a});
      this.onAnchor(this.anchors[this.anchors.length - 1]);
      this.cursor = firstFrom(ev, this.loop.a);
      this.sentTo = this.loop.a;
      this.pressHeld(this.loop.a, at);
    }
    // anchors the speakers have left behind are dropped
    const heard = this.audibleCtx();
    while (this.anchors.length > 1 && this.anchors[1].ctx <= heard) this.anchors.shift();
    if (!this.loop && this.songAt(heard) >= this.duration) {
      this.stop();
      this.onEnd();
    }
  }

  stopTimer() {
    if (this.id) this.timer.clear(this.id);
    this.id = 0;
  }

  play() {
    if (this.state === 'playing') return;
    if (this.pos >= this.duration) this.pos = 0;
    this.startAt(this.pos);
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this.next) this.load(this.next);
    this.next = null;
    this.pos = Math.min(this.now(), this.duration);
    this.stopTimer();
    this.post({type: 'clear'});
    this.state = 'paused';
  }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, Number(t) || 0));
    if (this.state === 'playing') {
      this.post({type: 'clear'});
      this.startAt(t);
    } else this.pos = t;
  }

  stop() {
    if (this.next) this.load(this.next);
    this.next = null;
    this.stopTimer();
    if (this.state === 'playing') this.post({type: 'clear'});
    this.state = 'stopped';
    this.pos = 0;
  }

  /** loop song time a to b (b - a at least 0.25 s); setLoop(null) ends the loop */
  setLoop(a, b) {
    if (a === null || a === undefined) {
      this.loop = null;
      return;
    }
    a = Math.max(0, Math.min(this.duration, a));
    b = Math.max(0, Math.min(this.duration, b));
    if (!(b - a >= MIN_LOOP)) throw new Error('A loop must be at least a quarter of a second.');
    this.loop = {a, b};
    if (this.state === 'playing') {
      const t = this.now();
      if (t < a || t >= b) this.seek(a);
      // notes past the new end may already be on their way: send again from here
      else if (this.cursor > 0 && this.events[this.cursor - 1].time >= b) this.seek(t);
    } else if (this.pos < a || this.pos >= b) this.pos = a;
  }
}
