# Third-party notices

This project has no npm dependencies. The following files are bundled unmodified in `public/vendor/`:

| Files | Project | Version | License |
| --- | --- | --- | --- |
| `vision_bundle.mjs`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, `tasks-vision-package.json` | [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision`), Google LLC and the MediaPipe Authors | 1.0.1 | Apache License 2.0 |
| `selfie_segmenter.tflite` (SHA-256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`) | [MediaPipe selfie segmentation model](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) | — | Apache License 2.0 |

The full Apache License 2.0 text is in [`public/vendor/LICENSE-Apache-2.0.txt`](public/vendor/LICENSE-Apache-2.0.txt).

MediaPipe's library tries to send usage telemetry. The studio page's content security policy (`connect-src 'self'`) blocks it.

## Services

The studio calls the following services under your own accounts and their terms. It bundles none of their code.

- [Claude Code](https://code.claude.com) (Anthropic)
- [ElevenLabs](https://elevenlabs.io) (speech recognition and synthesis)
- Optionally, X (live streaming)

The recommended voices are ElevenLabs' stock voices, and their preview clips are fetched from ElevenLabs when you play them.

"Claude" and the Clawd character are trademarks of Anthropic.


## Codex identity

OpenAI and Codex marks belong to OpenAI. This project's MIT license covers its
code and original character artwork; it does not grant rights to those marks.
The mark identifies the Codex subscription integration.

`public/codex-brand.png` is the unmodified original blue Codex branding from
https://openai.com/codex/get-started/ (retrieved 2026-09-26). The app icon is framed
from this artwork using CSS. Source asset:
https://images.ctfassets.net/kftzwdyauwt9/4qyHvm6xZ6G2r2VawnGJgd/f52eeb2debad385ebe0d381d6dde5970/codex-seo-image.png?fit=fill&h=900&w=1600

Astra is original animated character art inspired by the cloud silhouette and
blue palette of that Codex identity; she is not an official OpenAI mascot.
