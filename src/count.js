// Anonymous counts, sent to GoatCounter: a visit, and an action such as playing a song. Only the live site counts. No
// cookies, and never a file, a song or the part of the address after # that holds a shared song or point. GoatCounter's own script
// is not loaded: this sends the same request (https://www.goatcounter.com/help/pixel), so no outside code runs here.

const ENDPOINT = 'https://mundana.goatcounter.com/count';
const LIVE = 'mundana.anxchywl.dev';

const send = (params) => {
  if (location.hostname !== LIVE || navigator.webdriver) return;
  const q = new URLSearchParams({...params, s: String(screen.width), rnd: Math.random().toString(36).slice(2, 7)});
  try {
    navigator.sendBeacon?.(`${ENDPOINT}?${q}`);
  } catch {
    // a count is never worth an error in the app
  }
};

/** one visit: where it came from, without any part of the link after # */
export const countVisit = () => {
  if (document.visibilityState === 'prerender') return;
  send({p: location.pathname, t: 'Mundana', r: document.referrer, q: location.search});
};

/** an action, as a named event on the dashboard */
export const countAction = (name) => send({p: name, t: name, e: 'true'});

const once = new Set();
/** an action that counts one time per visit, however many times it is done */
export const countOnce = (name) => {
  if (once.has(name)) return;
  once.add(name);
  countAction(name);
};
