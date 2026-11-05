// The page in English, Russian or Kazakh. English is the source: every other language is a table from the English
// text to its translation, so a missing entry shows the English instead of a hole. The choice is kept on the device;
// a first visit takes the browser's language. Changing it redraws the page in place, so a playing song keeps going.
//
// Text written in index.html is found by walking the page: each text node and each aria-label, title and placeholder
// is looked up as it stands, in English or in either translation, so the walk works from any language to any other.
// Text the code writes uses tr(), and the code redraws it when the language changes (onLang).

import ru from './i18n/ru.js?v=42';
import kk from './i18n/kk.js?v=42';

export const LANGS = [
  ['en', 'English'],
  ['ru', 'Русский'],
  ['kk', 'Қазақша'],
];
const TABLES = {ru, kk};
const KEY = 'mundana-lang';
const ATTRS = ['aria-label', 'title', 'placeholder'];

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// any translation back to its English source
const back = new Map();
for (const table of Object.values(TABLES)) for (const [en, text] of Object.entries(table.text)) if (typeof text === 'string') back.set(norm(text), en);

const stored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const fromBrowser = () => {
  for (const l of (typeof navigator !== 'undefined' && navigator.languages) || []) {
    const code = l.toLowerCase().slice(0, 2);
    if (code === 'kk') return 'kk';
    if (code === 'ru') return 'ru';
    if (code === 'en') return 'en';
  }
  return 'en';
};

let lang = typeof window === 'undefined' ? 'en' : LANGS.some(([c]) => c === stored()) ? stored() : fromBrowser();
export const getLang = () => lang;

/** the text in the current language, with {name} filled in from vars */
export const tr = (en, vars) => {
  const s = lang === 'en' ? en : TABLES[lang].text[en] ?? TABLES[lang].text[norm(en)] ?? en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
};

// how a count reads: English one or many, Russian one, few or many, Kazakh the same word after any number
const pluralIndex = (n) => {
  if (lang === 'ru') {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return 2;
    if (b === 1) return 0;
    if (b >= 2 && b <= 4) return 1;
    return 2;
  }
  if (lang === 'kk') return 0;
  return n === 1 ? 0 : 1;
};
const EN_WORDS = {
  note: ['note', 'notes'],
  section: ['section', 'sections'],
  semitone: ['semitone', 'semitones'],
  chordNote: ['chord note', 'chord notes'],
  bassNote: ['bass note', 'bass notes'],
  drumHit: ['drum hit', 'drum hits'],
  lowerNote: ['lower note', 'lower notes'],
  shortNote: ['very short note', 'very short notes'],
};
/** "5 notes", "5 нот", "5 нота" */
export const countWord = (n, word) => {
  const forms = lang === 'en' ? EN_WORDS[word] : TABLES[lang].words[word];
  return `${n.toLocaleString('en')} ${forms[Math.min(pluralIndex(n), forms.length - 1)]}`;
};

/** a fractal's or a family's name, note or slider name */
export const fractalText = (f, field) => (lang === 'en' ? f[field] : TABLES[lang].fractals[f.key]?.[field] ?? f[field]);
export const paramName = (f) => (lang === 'en' ? f.param.name : TABLES[lang].params[f.param.name] ?? f.param.name);

const sourceOf = (s) => {
  const k = norm(s);
  return back.get(k) ?? k;
};

/** the page's own text, from whatever language it is in now to the current one */
export const translatePage = (root = document.body) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      !n.nodeValue.trim() || n.parentElement?.closest('script, style, svg, canvas, [data-no-tr]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = n.nodeValue;
    const en = sourceOf(v);
    // only text the tables know: song titles, numbers and names stay as they are
    if (ru.text[en] === undefined) continue;
    const lead = v.match(/^\s*/)[0];
    const tail = v.match(/\s*$/)[0];
    n.nodeValue = lead + tr(en) + tail;
  }
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    if (el.closest('[data-no-tr]')) continue;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const en = sourceOf(v);
      if (ru.text[en] !== undefined) el.setAttribute(a, tr(en));
    }
  }
  document.documentElement.lang = lang;
};

const listeners = [];
/** run fn now and again whenever the language changes */
export const onLang = (fn) => {
  listeners.push(fn);
};

export const setLang = (next) => {
  if (!LANGS.some(([c]) => c === next) || next === lang) return;
  lang = next;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    // the choice still holds for this visit
  }
  translatePage();
  for (const fn of listeners) fn(lang);
};
