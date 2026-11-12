/**
 * Rancho El Principio: navegación sin recargar la página.
 *
 * Al pasar de una página a otra de la tienda se descarga la página nueva y solo se reemplazan el
 * encabezado, el contenido y el pie. Lo demás (música de fondo, carrito, buscador) no se destruye,
 * así que la música sigue sonando sin cortes.
 *
 * Cualquier cosa que no sepa manejar (pago, cuenta, archivos, otro dominio, errores) cae a la
 * navegación normal del navegador, así que en el peor caso la página solo se recarga como antes.
 */

const REGIONS = ['#header-group', '#MainContent', '.page-wrapper > footer'];
const FULL_RELOAD_PATHS = /^\/(checkout|checkouts|account|challenge|password|admin|apps|tools|services|cart\/(add|change|update|clear))/;
const FILE_EXT = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp3|mp4|xml|json|js|css|txt)$/i;
const CACHE_MS = 30000;

/** @type {Map<string, {time: number, promise: Promise<string>}>} */
const cache = new Map();
let renderedPath = location.pathname;
let navigationId = 0;

const scrollModule = import('@theme/scroll-container').catch(() => null);
const eventsModule = import('@shopify/events').catch(() => null);

// Para revisar en la consola: sessionStorage.setItem('repNavDebug', '1')
let DEBUG = false;
try { DEBUG = sessionStorage.getItem('repNavDebug') === '1'; } catch (e) {}
const debug = (...args) => { if (DEBUG) console.log('[rep-nav]', ...args); };

function fullReload(url, reason) {
  debug('full reload:', reason, url);
  window.location.href = url;
}

/** @param {URL} url */
function canHandle(url) {
  if (url.origin !== location.origin) return false;
  if (FULL_RELOAD_PATHS.test(url.pathname)) return false;
  if (FILE_EXT.test(url.pathname)) return false;
  return true;
}

/** @param {MouseEvent} event */
function isPlainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** @param {string} href */
function fetchPage(href) {
  const hit = cache.get(href);
  if (hit && Date.now() - hit.time < CACHE_MS) return hit.promise;

  const promise = fetch(href, { credentials: 'same-origin', headers: { Accept: 'text/html' } }).then((response) => {
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !type.includes('text/html')) throw new Error('not-html');
    if (response.redirected && new URL(response.url).origin !== location.origin) throw new Error('offsite');
    return response.text();
  });
  promise.catch(() => cache.delete(href));
  cache.set(href, { time: Date.now(), promise });
  return promise;
}

/** Recreates a <script> so the browser runs it (scripts inserted from another document don't run). */
function revive(oldScript) {
  const type = oldScript.getAttribute('type');
  if (type && type !== 'module' && type !== 'text/javascript') return; // JSON, ld+json, importmap…
  const script = document.createElement('script');
  for (const { name, value } of oldScript.attributes) script.setAttribute(name, value);
  script.textContent = oldScript.textContent;
  oldScript.replaceWith(script);
}

/** Adds scripts and stylesheets from the new <head> that this page hasn't loaded yet. */
function syncHead(newDoc) {
  const loaded = new Set(
    [...document.head.querySelectorAll('script[src], link[href]')].map((el) => el.getAttribute('src') || el.getAttribute('href'))
  );

  for (const el of newDoc.head.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]')) {
    const key = el.getAttribute('src') || el.getAttribute('href');
    if (loaded.has(key)) continue;
    if (el.tagName === 'SCRIPT') {
      const script = document.createElement('script');
      for (const { name, value } of el.attributes) script.setAttribute(name, value);
      document.head.appendChild(script);
    } else {
      document.head.appendChild(el.cloneNode(true));
    }
  }

  document.title = newDoc.title;
  for (const selector of ['meta[name="description"]', 'link[rel="canonical"]', 'meta[property="og:title"]', 'meta[property="og:url"]', 'meta[property="og:description"]', 'meta[property="og:image"]', 'meta[property="og:image:secure_url"]']) {
    const fresh = newDoc.head.querySelector(selector);
    const current = document.head.querySelector(selector);
    if (fresh && current) current.replaceWith(fresh.cloneNode(true));
    else if (fresh) document.head.appendChild(fresh.cloneNode(true));
    else current?.remove();
  }
}

/** Closes the cart drawer, search and any other open dialog before swapping the page. */
function closeOverlays() {
  document.querySelectorAll('theme-drawer[open]').forEach((drawer) => drawer.close?.());
  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    let owner = dialog.parentElement;
    while (owner && typeof owner.closeDialog !== 'function') owner = owner.parentElement;
    if (owner) owner.closeDialog();
    else dialog.close();
  });
}

function setProgress(active) {
  let bar = document.getElementById('rep-nav-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'rep-nav-progress';
    document.body.appendChild(bar);
  }
  bar.classList.toggle('is-on', active);
}

async function scrollAfterNavigation(url, savedTop) {
  const mod = await scrollModule;
  if (url.hash) {
    const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target) return target.scrollIntoView();
  }
  const top = typeof savedTop === 'number' ? savedTop : 0;
  if (mod?.scrollTo) mod.scrollTo({ top, behavior: 'instant' });
  else window.scrollTo(0, top);
}

async function trackPageView() {
  const mod = await eventsModule;
  if (!mod?.PageViewEvent) return;
  const template = document.querySelector('main[data-template]')?.dataset.template || '';
  if (!template) return; // policy pages have no template name and Shopify rejects an empty one
  document.dispatchEvent(new mod.PageViewEvent({ page: { template, title: document.title, url: location.href } }));
}

/**
 * @param {string} href
 * @param {{ push?: boolean, savedTop?: number }} [options]
 */
async function navigate(href, { push = true, savedTop } = {}) {
  const url = new URL(href, location.href);
  if (!canHandle(url)) return fullReload(url.href, 'cannot handle');

  const id = ++navigationId;
  setProgress(true);

  let html;
  try {
    html = await fetchPage(url.href);
  } catch (error) {
    return fullReload(url.href, 'fetch failed: ' + error.message);
  }
  if (id !== navigationId) return; // a newer click won

  const newDoc = new DOMParser().parseFromString(html, 'text/html');
  const parts = REGIONS.map((selector) => [document.querySelector(selector), newDoc.querySelector(selector)]);
  if (parts.some(([current, fresh]) => !current || !fresh)) return fullReload(url.href, 'missing region');

  closeOverlays();
  if (push) history.pushState({ repNav: true }, '', url.href);

  syncHead(newDoc);

  for (const [current, fresh] of parts) {
    if (current.id === 'MainContent') {
      for (const { name, value } of fresh.attributes) current.setAttribute(name, value);
    }
    current.replaceChildren(...fresh.childNodes);
    current.querySelectorAll('script').forEach(revive);
  }

  renderedPath = url.pathname;
  window.measureHeaderHeights?.();
  setProgress(false);
  await scrollAfterNavigation(url, savedTop);

  debug('done', url.href);
  document.dispatchEvent(new CustomEvent('rep:page-load', { detail: { url: url.href } }));
  trackPageView();
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || !isPlainClick(event)) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  if (link.target && link.target !== '_self') return;
  if (link.hasAttribute('download') || link.hasAttribute('data-full-reload')) return;

  const url = new URL(link.href, location.href);
  if (!canHandle(url)) return;
  // Anchor on the same page: let the browser scroll.
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;

  event.preventDefault();
  debug('link click →', url.href);
  navigate(url.href);
});

// Product cards on the collection page navigate with JavaScript when the image is clicked
// (product-card.js); send those through here too.
document.addEventListener(
  'click',
  (event) => {
    if (!isPlainClick(event) || !(event.target instanceof Element)) return;
    const card = event.target.closest('product-card');
    if (!card || card.hasAttribute('data-no-navigation')) return;
    if (event.target.closest('a, button, input, label, select, [tabindex="1"]')) return;
    const link = card.querySelector('a[ref="productCardLink"]');
    if (!link?.href || !canHandle(new URL(link.href))) return;
    event.stopPropagation();
    navigate(link.href);
  },
  true
);

// Search form (GET) without reloading.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
  if ((form.method || 'get').toLowerCase() !== 'get') return;
  const url = new URL(form.action || location.href, location.href);
  if (!canHandle(url) || !/^\/search\/?$/.test(url.pathname)) return;
  url.search = new URLSearchParams(new FormData(form)).toString();
  event.preventDefault();
  debug('link click →', url.href);
  navigate(url.href);
});

// Back/forward: only when the page (path) changes. Filters and pagination change the query
// string and handle their own history.
window.addEventListener('popstate', () => {
  if (location.pathname === renderedPath) return;
  const savedTop = history.state?.scrollTop;
  navigate(location.href, { push: false, savedTop: typeof savedTop === 'number' ? savedTop : undefined });
});

// Desktop only: preload a page when the mouse rests on its link, so the change feels instant.
// Never on touch (scrolling a phone touches many links, and a burst of requests gets the visitor
// rate-limited by Shopify), and only one preload at a time.
let hoverTimer = 0;
let prefetching = false;
function prefetch(event) {
  if (event.pointerType !== 'mouse') return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  clearTimeout(hoverTimer);
  if (!link || link.target === '_blank') return;
  const url = new URL(link.href, location.href);
  if (!canHandle(url) || url.pathname === location.pathname) return;
  hoverTimer = setTimeout(() => {
    if (prefetching || cache.has(url.href)) return;
    prefetching = true;
    fetchPage(url.href).catch(() => {}).finally(() => { prefetching = false; });
  }, 65);
}
document.addEventListener('pointerover', prefetch, { passive: true });
document.addEventListener('pointerout', () => clearTimeout(hoverTimer), { passive: true });

// Keep the first entry recognisable for back/forward.
if (!history.state) history.replaceState({ repNav: true }, '');

window.repNavigate = navigate;
