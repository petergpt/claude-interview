// Person segmentation for the user's background, running locally with MediaPipe's selfie segmenter
// (vendored in public/vendor; no network). Produces a soft alpha mask aligned to the camera frame.
// The raw camera recording (user-camera.webm) is never altered; only the composed frame uses the mask.

let segmenter = null, loading = null, lastTime = -1, busy = false;
const MASK = 256;
// raw: the model's confidence; mask: a feathered, higher-resolution copy used for the cut-out, so the
// 256-px mask never shows stair-stepped edges when it is enlarged to the camera frame.
const raw = document.createElement('canvas'); raw.width = raw.height = MASK;
const mctx = raw.getContext('2d'), image = mctx.createImageData(MASK, MASK);
const SOFT = 768;
export const mask = document.createElement('canvas'); mask.width = mask.height = SOFT;
const softCtx = mask.getContext('2d');
let smooth = null;
const small = document.createElement('canvas'); small.width = MASK; small.height = MASK; const sctx = small.getContext('2d', { willReadFrequently: false });                          // temporally smoothed confidence, to stop edge flicker
export let ready = false;

export function loadSegmenter() {
  return loading ||= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import('/vendor/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks('/vendor');
    const options = delegate => ({ baseOptions: { modelAssetPath: '/vendor/selfie_segmenter.tflite', delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    try { segmenter = await ImageSegmenter.createFromOptions(files, options('GPU')); }
    catch { segmenter = await ImageSegmenter.createFromOptions(files, options('CPU')); }
    return segmenter;
  })().catch(error => { loading = null; throw error; });
}

// Call once per rendered frame; it only runs when the camera has produced a new frame.
export function segmentFrame(video) {
  if (!segmenter || busy || video.readyState < 2 || video.currentTime === lastTime) return;
  lastTime = video.currentTime; busy = true;
  try {
    // the model works at 256 px; shrinking first keeps a 1080p or 4K camera cheap
    sctx.drawImage(video, 0, 0, MASK, MASK);
    segmenter.segmentForVideo(small, performance.now(), result => {
      const masks = result.confidenceMasks; if (!masks?.length) return;
      const m = masks[masks.length - 1], w = m.width, h = m.height, data = m.getAsFloat32Array();
      if (!smooth || smooth.length !== MASK * MASK) smooth = new Float32Array(MASK * MASK);
      for (let y = 0; y < MASK; y++) {
        const sy = Math.min(h - 1, Math.floor(y * h / MASK));
        for (let x = 0; x < MASK; x++) {
          const i = y * MASK + x, v = data[sy * w + Math.min(w - 1, Math.floor(x * w / MASK))];
          const s = smooth[i] = smooth[i] * 0.45 + v * 0.55;
          // a gentle curve keeps hair and edges soft but removes the grey halo of low confidence
          const a = Math.min(1, Math.max(0, (s - 0.25) / 0.5));
          image.data[i * 4 + 3] = a * a * (3 - 2 * a) * 255;
        }
      }
      mctx.putImageData(image, 0, 0);
      softCtx.clearRect(0, 0, SOFT, SOFT); softCtx.imageSmoothingEnabled = true; softCtx.imageSmoothingQuality = 'high';
      softCtx.filter = 'blur(3px)'; softCtx.drawImage(raw, 0, 0, SOFT, SOFT); softCtx.filter = 'none';
      ready = true;
    });
  } catch (error) { console.warn('Segmentation failed:', error); }
  finally { busy = false; }
}
