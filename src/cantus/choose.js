// The panel's menus: a button and a list drawn by the page, so they match the rest of it. The real <select> stays,
// hidden, and keeps the value and the change event, so the code that builds the panel need not know.

const PAD = 8; // from the edge of the window
const KEEP_MS = 600;
const MAX_LIST = 380; // px: a long list scrolls, with the chosen option in its middle

let layer = null;
let menu = null;
let open = null; // {select, trigger}
let active = -1;
let typed = '';
let typedAt = 0;
let keep = '';
let keepUntil = 0;

const labelOf = (select) => select.getAttribute('aria-label') || (select.id && document.querySelector(`label[for="${select.id}"]`)?.textContent) || '';

const close = () => {
  if (!open) return;
  layer.hidden = true;
  open.trigger.setAttribute('aria-expanded', 'false');
  open.trigger.removeAttribute('aria-activedescendant');
  open = null;
};

const setActive = (i) => {
  const items = menu.children;
  items[active]?.classList.remove('active');
  active = Math.max(0, Math.min(items.length - 1, i));
  items[active].classList.add('active');
  items[active].scrollIntoView({block: 'nearest'});
  open.trigger.setAttribute('aria-activedescendant', items[active].id);
};

/** a change rebuilds the panel, once or a few times: the keys stay on the same menu */
const keepFocus = () => {
  if (!keep || performance.now() > keepUntil) return;
  const same = [...document.querySelectorAll('select')].find((s) => labelOf(s) === keep);
  same?.chooser?.focus({preventScroll: true});
};

const choose = (i) => {
  const {select, trigger} = open;
  const label = labelOf(select);
  close();
  if (select.selectedIndex === i) return;
  select.selectedIndex = i;
  sync(select);
  select.dispatchEvent(new Event('change', {bubbles: true}));
  keep = label;
  keepUntil = performance.now() + KEEP_MS;
  keepFocus();
};

const build = () => {
  layer = document.createElement('div');
  layer.className = 'c-menu-layer';
  layer.hidden = true;
  menu = document.createElement('ul');
  menu.className = 'c-menu';
  menu.setAttribute('role', 'listbox');
  layer.appendChild(menu);
  document.body.appendChild(layer);
  // a click beside the list only closes it, and the focus stays on the button
  layer.addEventListener('click', (e) => {
    e.stopPropagation(); // the page takes a click outside the panel as closing it
    const item = e.target.closest('li');
    if (item) choose(Number(item.dataset.i));
    else close();
  });
  layer.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('mousemove', (e) => {
    const item = e.target.closest('li');
    if (item && Number(item.dataset.i) !== active) setActive(Number(item.dataset.i));
  });
  window.addEventListener('resize', close);
};

const show = (select, trigger) => {
  if (!layer) build();
  open = {select, trigger};
  active = -1;
  menu.replaceChildren();
  [...select.options].forEach((o, i) => {
    const li = document.createElement('li');
    li.id = `c-menu-${i}`;
    li.dataset.i = String(i);
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === select.selectedIndex));
    li.textContent = o.textContent;
    menu.appendChild(li);
  });
  menu.setAttribute('aria-label', labelOf(select));
  layer.hidden = false;
  // the chosen option sits on the button, in the middle of the list, with the others above and below it
  const r = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  menu.style.minWidth = `${Math.round(r.width)}px`;
  menu.style.maxHeight = `${Math.min(MAX_LIST, vh - 2 * PAD)}px`;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const room = menu.scrollHeight - menu.clientHeight;
  const chosen = menu.children[Math.max(0, select.selectedIndex)];
  const middle = chosen.offsetTop + chosen.offsetHeight / 2;
  const onButton = r.top + r.height / 2;
  const scrollFor = (top) => Math.max(0, Math.min(room, middle - (onButton - top)));
  let scroll = Math.max(0, Math.min(room, middle - h / 2));
  // near the window's edge, or at either end of the list, the list slides and the option stays on the button if it can
  const top = Math.max(PAD, Math.min(vh - PAD - h, onButton - (middle - scroll)));
  scroll = scrollFor(top);
  menu.scrollTop = scroll;
  menu.style.left = `${Math.round(Math.max(PAD, Math.min(r.left, window.innerWidth - w - PAD)))}px`;
  menu.style.top = `${Math.round(top)}px`;
  trigger.setAttribute('aria-expanded', 'true');
  trigger.focus({preventScroll: true});
  setActive(Math.max(0, select.selectedIndex));
};

const onKey = (e, select, trigger) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  const isOpen = open?.select === select;
  if (k === 'Tab') {
    close();
    return;
  }
  const letter = k.length === 1 && k !== ' ';
  if (!isOpen) {
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      show(select, trigger);
    } else if (k === 'Enter' || k === ' ') e.stopPropagation(); // the button's own click opens it
    return;
  }
  // while the list is open every key is the list's, not the page's shortcuts
  e.stopPropagation();
  if (k === 'Escape') close();
  else if (k === 'Enter' || k === ' ') choose(active);
  else if (k === 'ArrowDown') setActive(active + 1);
  else if (k === 'ArrowUp') setActive(active - 1);
  else if (k === 'Home') setActive(0);
  else if (k === 'End') setActive(select.options.length - 1);
  else if (letter) {
    const now = performance.now();
    typed = now - typedAt < 700 ? typed + k.toLowerCase() : k.toLowerCase();
    typedAt = now;
    const hit = [...select.options].findIndex((o) => o.textContent.toLowerCase().startsWith(typed));
    if (hit >= 0) setActive(hit);
  } else return;
  e.preventDefault();
};

const sync = (select) => {
  const b = select.chooser;
  const text = select.selectedOptions[0]?.textContent ?? '';
  b.firstChild.textContent = text;
  b.setAttribute('aria-label', `${labelOf(select)}: ${text}`);
};

/** give every <select> under root a menu of ours, and show what each one holds now */
export const enhanceSelects = (root) => {
  for (const select of root.querySelectorAll('select')) {
    if (!select.chooser) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'c-choose';
      b.setAttribute('aria-haspopup', 'listbox');
      b.setAttribute('aria-expanded', 'false');
      b.appendChild(document.createElement('span'));
      if (select.id) {
        b.id = `${select.id}-menu`;
        const label = document.querySelector(`label[for="${select.id}"]`);
        if (label) {
          select.setAttribute('aria-label', label.textContent);
          label.htmlFor = b.id;
        }
      }
      b.addEventListener('click', () => (open?.select === select ? close() : show(select, b)));
      b.addEventListener('keydown', (e) => onKey(e, select, b));
      select.hidden = true;
      select.chooser = b;
      select.after(b);
    }
    sync(select);
  }
  if (open && !open.trigger.isConnected) close();
  keepFocus();
};
