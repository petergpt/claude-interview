// The scene director: a second, parallel Claude call that produces the visual shown while Claude speaks.
// It streams a one-line JSON header first (a pre-built library scene the page can show immediately),
// then bespoke canvas code that replaces it when complete.
import vm from 'node:vm';

export const SCENE_BASES = ['orbit', 'city', 'growth', 'waves', 'network', 'timeline', 'field', 'strata', 'constellation', 'bloom'];
export const VISUAL_MODES = ['off', 'useful', 'always'];
// Art directions shared with the page's avatar styles (public/styles.js uses the same keys and colours).
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
export const SCENE_STYLES = {
  clawd: { name: 'Clawd papercraft', background: '#f3eadf', ink: '#2a2420', accent: '#dc7d58', text: '#3a342f', font: SERIF, feel: 'a warm papercraft diorama: folded and cut paper shapes with soft shadows and gentle depth, on a cream table; tactile and handmade' },
  bloom: { name: 'Bloom cartoon', background: '#fbf8ee', ink: '#111111', accent: '#dc7656', text: '#111111', font: SERIF, feel: 'flat cheerful cartoon: thick slightly wobbly black marker outlines, flat pastel fills (coral orange, lavender, sky blue), soft pale-yellow to white background, simple and friendly' },
  pixel: { name: 'Clawd 8-bit', background: '#141312', ink: '#f3d27a', accent: '#d97757', text: '#efe6cc', font: 'monospace', feel: 'glowing 8-bit pixel art on near-black: chunky square pixels (draw on a coarse grid), limited palette, parallax layers, sprite-like motion' },
  sun: { name: 'Sun collage', background: '#2e3470', ink: '#fbf7ef', accent: '#e3895f', text: '#f4efe2', font: SERIF, feel: 'paper collage on deep navy: torn paper edges with white fibres, cut-out shapes, paper planes, confetti, a handmade storybook feel' },
  cafe: { name: 'Café sketchbook', background: '#efe4d2', ink: '#2a2320', accent: '#e08a5e', text: '#2a2320', font: SERIF, feel: 'a coloured-pencil storybook illustration: wobbly dark ink outlines, crayon hatching, warm Parisian afternoon light, lived-in and charming' },
  flock: { name: 'Flock', background: '#121316', ink: '#f3e6d0', accent: '#df7f59', text: '#f3e6d0', font: SERIF, feel: 'thousands of glowing particles on near-black forming shapes like murmurations; flowing, organic, luminous' },
  ink: { name: 'Ink', background: '#efe9dd', ink: '#2f2a26', accent: '#bf5b3a', text: '#3a342f', font: SERIF, feel: 'ink line and a little watercolour wash on warm paper; hand-drawn, sparse, lots of paper showing' },
  riso: { name: 'Riso', background: '#f3eee4', ink: '#1f3fb3', accent: '#ff4f7a', text: '#1d2a55', font: '"Helvetica Neue", Arial, sans-serif', feel: 'two-colour risograph print: flat bold shapes, halftone dots, slight misregistration, graphic and playful' },
};

export const CODEX_STYLE = { name: 'Astra blue storybook', background: '#d9e5fa', ink: '#202d68', accent: '#527bec', text: '#202d68', font: SERIF, feel: 'a blue and periwinkle coloured-pencil storybook: soft cloud shapes, paper grain, fine indigo outlines, warm cream light, generous quiet space and tiny unexpected details at the edges' };

const clean = s => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);

// Incremental parser for "header\n---\ncode". Returns {header, code, done} as text arrives.
export class SceneStream {
  text = ''; header = null;
  constructor(normalize = normalizeHeader) { this.normalize = normalize; }
  add(delta) {
    this.text += delta;
    if (!this.header) {
      const body = this.text.replace(/^\s*```[a-z]*\s*/i, '');
      const nl = body.indexOf('\n');
      if (nl >= 0 || /\}\s*$/.test(body)) {
        const line = (nl >= 0 ? body.slice(0, nl) : body).trim();
        try { this.header = this.normalize(JSON.parse(line)); } catch { if (nl >= 0) this.header = { ...this.normalize(null), invalid: true }; }
      }
    }
    return this.header;
  }
  code() {
    const at = this.text.indexOf('\n---');
    if (at < 0) return '';
    return this.text.slice(this.text.indexOf('\n', at + 1) + 1).replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  }
}

export function normalizeBackdrop(h) {
  return h && h.backdrop === true ? { backdrop: true, title: clean(h.title) } : { backdrop: false };
}
// Keep the quick library scene from repeating: a base used in the last few turns is swapped for a fresh one.
export function freshBase(base, recent, turn = 0) {
  if (!recent.includes(base)) return base;
  const unused = SCENE_BASES.filter(b => !recent.includes(b));
  return unused[turn % unused.length] || base;
}
export function normalizeHeader(h) {
  // "keep": the picture on screen still fits, so nothing new is painted.
  if (h?.visual === 'keep') return { visual: false, keep: true };
  if (!h || h.visual !== true) return { visual: false };
  const palette = (Array.isArray(h.palette) ? h.palette : []).filter(c => /^#[0-9a-f]{3,8}$/i.test(c)).slice(0, 5);
  return { visual: true, title: clean(h.title), subject: String(h.subject ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 160), composition: String(h.composition ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200), shot: clean(h.shot),
    base: SCENE_BASES.includes(h.base) ? h.base : 'field', words: (Array.isArray(h.words) ? h.words : []).map(clean).filter(Boolean).slice(0, 4), palette };
}
// Claude's scene sits above Claude in the top of its tile (landscape); backdrops fill the whole tile.
export const SCENE_SIZE = { width: 888, height: 560 }, BACKDROP_SIZE = { width: 888, height: 852 };

// Compile-only check: the code must parse and define draw(). It is never executed in the backend.
export function checkSceneCode(code) {
  if (!code || code.length > 60000) throw new Error('Scene code is empty or too large.');
  new vm.Script(code, { filename: 'scene.js' });
  if (!/function\s+draw\s*\(/.test(code) && !/\bdraw\s*=/.test(code)) throw new Error('Scene code does not define draw().');
  return code;
}

// Dimensions are read-only accessors: generated setup() functions sometimes reassign W/H.
// Ignore those assignments without aborting setup or changing the host canvas.
// The sandboxed host page for one scene. It draws into an OffscreenCanvas and posts ImageBitmaps to the
// studio page, which composites them into the recorded frame. The frame has an opaque origin and no network.
export function sceneFrameHTML({ code, style, width = 888, height = 852 }) {
  const safe = s => s.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><meta charset="utf-8"><title>scene</title>
<script>Object.defineProperties(globalThis,{W:{get:()=>${width},set:()=>{}},H:{get:()=>${height},set:()=>{}}});const STYLE=${safe(JSON.stringify(style))};
// Generated code often slips on numbers (a NaN alpha, a negative radius). These calls throw on such values and would
// stop the whole picture, so they are made forgiving: bad colours become transparent, bad numbers become 0.
(()=>{const fin=v=>Number.isFinite(+v)?+v:0,G=CanvasGradient.prototype,add=G.addColorStop;
G.addColorStop=function(o,c){o=Math.min(1,Math.max(0,fin(o)));try{add.call(this,o,c);}catch{try{add.call(this,o,'rgba(0,0,0,0)');}catch{}}};
for(const P of[OffscreenCanvasRenderingContext2D.prototype,CanvasRenderingContext2D.prototype]){
for(const m of['createLinearGradient','createRadialGradient']){const f=P[m];P[m]=function(...a){a=a.map(fin);if(m==='createRadialGradient'){a[2]=Math.abs(a[2]);a[5]=Math.abs(a[5]);}return f.apply(this,a);};}
const arc=P.arc;P.arc=function(x,y,r,...a){return arc.call(this,x,y,Math.abs(fin(r)),...a);};
const el=P.ellipse;P.ellipse=function(x,y,rx,ry,...a){return el.call(this,x,y,Math.abs(fin(rx)),Math.abs(fin(ry)),...a);};}})();</script>
<script>${safe(code)}</script>
<script>
(()=>{const cv=new OffscreenCanvas(W,H),ctx=cv.getContext('2d');let env={level:0,speaking:false},errors=0,frames=0,broken=false,busy=false,last=0;
const report=e=>{if(errors++===0)parent.postMessage({type:'scene-error',message:String(e&&e.message||e).slice(0,300)},'*');};
try{if(typeof setup==='function')setup(ctx);}catch(e){report(e);}
const t0=performance.now();
// Frames are driven by the studio page: each 'env' message (sent every display frame) draws one frame.
// Chrome throttles timers in hidden cross-origin frames to ~1 Hz, so a local timer is only a fallback.
// A frame whose draw() threw is never shown. A picture that keeps failing early is reported as broken and stops.
function frame(){if(busy||broken)return;last=performance.now();frames++;try{draw(ctx,(last-t0)/1000,env);}catch(e){report(e);
if(errors>15&&frames<90){broken=true;parent.postMessage({type:'scene-broken'},'*');}return;}
busy=true;createImageBitmap(cv).then(b=>{busy=false;parent.postMessage({type:'scene-frame',bitmap:b},'*',[b]);},()=>{busy=false;});}
addEventListener('message',e=>{if(e.data&&e.data.type==='env'){env=e.data.env;frame();}});
setInterval(()=>{if(performance.now()-last>250)frame();},100);
frame();})();
</script>`;
}

export const SCENE_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
