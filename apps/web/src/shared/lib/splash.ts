export const SPLASH_DURATION_MS = 1400;
export const SPLASH_FADE_MS = 200;
const SPLASH_STORAGE_KEY = 'manawg:splash-shown';
/** Opt-in for screenshot runs: shows the splash even under automation. */
const SPLASH_DEMO_KEY = 'manawg:splash-demo';

/**
 * Runs before first paint: the splash shows once per PWA window (a cold start), never in a
 * plain browser tab and never under automation (navigator.webdriver), unless the demo key is set.
 */
export const SPLASH_BOOTSTRAP_SCRIPT = `(function(){try{var s=sessionStorage;var demo=s.getItem('${SPLASH_DEMO_KEY}');var app=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;var skip=s.getItem('${SPLASH_STORAGE_KEY}')||(!demo&&(navigator.webdriver||!app));s.setItem('${SPLASH_STORAGE_KEY}','1');if(skip)document.documentElement.dataset.splash='off';}catch(e){document.documentElement.dataset.splash='off';}})();`;
