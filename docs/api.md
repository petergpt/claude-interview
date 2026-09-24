# Local backend API

Default origin: `http://127.0.0.1:4747` (set `INTERVIEW_PORT` to change it). Requests must stay on localhost. Cross-origin browser requests are rejected. First GET `/` obtains the HttpOnly SameSite cookie; a same-origin browser gets it automatically, and CLI clients keep that cookie in memory. There is no remote deployment or public listener.

Use `src/client.mjs` for a small Node client. No frontend secrets are required.

| Method and endpoint | Input / result |
| --- | --- |
| GET `/api/status` | Verified Claude status, whether a backend key is set, voices, active session, disk space. No keys or tokens. |
| POST `/api/settings` | CLI credential setup only: `{api_key}` validates voices and saves in Keychain (macOS; elsewhere use `ELEVENLABS_API_KEY`). `{}` loads existing backend credentials. Never add a key field to the frontend. |
| POST `/api/sessions` | `{user_name?, topic?, claude_model?, claude_effort?:"low"|"medium"|"high"|"xhigh"|"max", voice_id?:"auto", tts_model?:"eleven_v3_conversational"}` → session with UUID and recording directory |
| GET `/api/sessions/:id` | Session snapshot |
| GET `/api/sessions/:id/events` | SSE observer. Multiple observers are allowed. Audio is emitted only live. |
| GET `/api/sessions/:id/events?controller=1` | One controlling client; disconnect ends the call. Reconnect is a new session, not replayed speech. |
| POST `/api/sessions/:id/listen` | `{silence?:1.5}` establishes backend Scribe; returns only the required input audio format |
| POST `/api/sessions/:id/input-audio` | Raw mono signed little-endian 16-bit PCM at **16,000 Hz**; sequential 200ms chunks (6,400 bytes) recommended, max 320,000 bytes |
| POST `/api/sessions/:id/turn` | `{request_id:UUID, reply_id:UUID, text?, introduction?:true, client_ms?, words?}`. Introduction lets Claude choose its voice and greet you. Repeated request IDs are ignored. |
| POST `/api/sessions/:id/interrupt` | `{turn_id?, reason?}`; stop local playback immediately too |
| POST `/api/sessions/:id/config` | `{claude_model?, claude_effort?, voice_id?, topic?, user_name?, visuals?, style?, backdrops?}`; applies from the next reply, logged as `config-changed` |
| GET / POST `/api/prompt` | Claude's conversation prompt. POST `{text}` saves `prompts/conversation.md`, `{reset:true}` restores `prompts/conversation.default.md`. Applies from the next reply; each session keeps a copy as `system-prompt.md`. |
| POST `/api/sessions/:id/mute` | `{muted:true|false}`; recorded/transmitted microphone samples become silence while muted |
| POST `/api/sessions/:id/event` | Playback/capture/marker evidence, below |
| POST `/api/sessions/:id/end` | `{}`; cancels generation, disconnects recognition, closes WAV recording |
| GET `/api/sessions/:id/download` | Session metadata JSON, not a media bundle |
| POST `/api/shutdown` | CLI-only lifecycle operation; ends calls and stops server |

The backend buffers final Scribe transcripts for 400ms, joins adjacent speech, deduplicates plain/timestamped commits, and sends the turn to Claude. Partial speech interrupts current output. Clients **must not also submit automatic turns** from the same transcription. Typed turns use `/turn`.

SSE events include `connected`, `stt-connected`, `partial-transcript`, `user-turn`, `turn-start`, `model`, `voice`, `text`, `audio`, `alignment`, `turn-done`, `interrupted`, `mic-muted`, `mic-unmuted`, `error`, and `session-ended`. `audio` contains `{turn_id,audio:<base64 PCM>,sample_rate:24000,offset_seconds,duration_seconds}`. Schedule its buffers in order; ignore stale/interrupted turns. `alignment` contains `{turn_id,offset_seconds,alignment:{chars,char_start_times_ms,char_durations_ms}}` for the most recent audio chunk; character times are relative to that chunk's `offset_seconds`. The browser uses it to caption only what has actually played. `text` contains Claude-authored delivery tags; hide square-bracket tags only for the display, never rewrite the synthesis text.

`turn-done` means generation ended, **not playback**. Report `/event` with `type:"audio-playback"` or `"playback-complete"`, `turn_id`, and `played_seconds`. Mark estimates with `estimated:true`. For an interrupted turn, report playback then call `/interrupt`; the transcript will distinguish generated from heard content. `type:"marker", label` records an edit marker.

Browser capture can reuse `clients/browser/recording.js` and the PCM worklet. Media uploads use POST `/media?name=user-camera.webm&seq=0` (or `.mp4`, `user-microphone`, `stage`), raw body, ordered integer sequence. Immediate duplicate retry is idempotent; preserve IndexedDB backups until `media-complete` is confirmed. Send `media-start` / `media-complete` events with name and MIME type. Native clients write to the returned local recording directory and report matching media events.

The native CLI records microphone PCM continuously and optionally camera `.mov`. The browser client sends microphone PCM to `/input-audio`, so recognition and all provider authentication remain server-side. Do not reintroduce an ElevenLabs WebSocket or token into the browser.

Only one active session is allowed. Error JSON is `{error:"message"}`. Retain source recordings after failures. The current server keeps live session control in memory; after a restart, old sessions are read from disk via `./interview session UUID` and cannot resume.

## Visuals while Claude talks

Sessions accept `visuals: "off" | "useful" | "always"` (default `off`, so CLI calls don't spend extra requests) and `style` (one of the looks in `/api/status` → `scene_styles`, e.g. `"clawd"`, `"bloom"`, `"riso"`); both can change via `/config`. On each user turn the backend runs a second Claude call in parallel with the spoken reply (`claude-opus-5-5`, effort `low`, override with `INTERVIEW_SCENE_MODEL`; prompt in `prompts/scene.md`). It streams a one-line header first, emitted as `scene-base` `{scene_id,title,base,words,palette}` so the page can draw a pre-built library scene at once, then canvas code that is compile-checked, saved as `recordings/<id>/scenes/scene-NNN.js`, and announced as `scene-ready` `{scene_id,url}`. `scene-none` means no picture was wanted; `scene-error` keeps the library scene. `/scene-frame/<session>/<scene>` serves the code in a sandboxed page (opaque origin, `connect-src 'none'`) that posts ImageBitmaps to the studio page, which composites them into the recorded frame.


With `backdrops: true`, a third low-effort call (`prompts/backdrop.md`) paints a quiet backdrop for the person's side, announced as `backdrop-ready` and served from the same sandboxed frame route.

`user_name` is optional display text (at most 40 characters). When set, one line naming the person is appended to Claude's system prompt for that call only; the prompt files never contain it.

## Streaming (optional)

| Method and endpoint | Input / result |
| --- | --- |
| GET `/api/broadcast/status` | `{state, mode, frames, fps, seconds, bytes, error, key_set}`; never the key |
| POST `/api/broadcast/start` | `{mode:"test"|"x", url?}`. `test` writes a local MP4 to `.runtime/stream-checks/`. `x` needs an RTMPS address from X (or `X_STREAM_URL`) and a key set in the backend (`./interview stream-key set` or `X_STREAM_KEY`); a key in the request body is ignored. |
| POST `/api/broadcast/chunk?id=&seq=` | Ordered WebM chunks from the page's `MediaRecorder` |
| POST `/api/broadcast/stop` | Stops the encoder and returns the final status |
