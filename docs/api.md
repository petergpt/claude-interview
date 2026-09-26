# Local backend API

Default origin: `http://127.0.0.1:4747` (set `INTERVIEW_PORT` to change it). Requests must stay on localhost. Cross-origin browser requests are rejected. First GET `/` obtains the HttpOnly SameSite cookie; a same-origin browser gets it automatically, and CLI clients keep that cookie in memory. There is no remote deployment or public listener.

Use `src/client.mjs` for a small Node client. No frontend secrets are required.

| Method and endpoint | Input / result |
| --- | --- |
| GET `/api/status` | Verified Claude status, whether a backend key is set, voices, active session, disk space. No keys or tokens. |
| POST `/api/settings` | CLI credential setup only: `{api_key}` validates voices and saves in Keychain (macOS; elsewhere use `ELEVENLABS_API_KEY`). `{}` loads existing backend credentials. Never add a key field to the frontend. |
| POST `/api/sessions` | `{user_name?, vision_level?, vision_source?, topic?, claude_model?, claude_effort?:"low"|"medium"|"high"|"xhigh"|"max", voice_id?:"auto", tts_model?:"eleven_v3_conversational"}` → session with UUID and recording directory |
| GET `/api/sessions/:id` | Session snapshot |
| GET `/api/sessions/:id/events` | SSE observer. Multiple observers are allowed. Audio is emitted only live. |
| GET `/api/sessions/:id/events?controller=1` | One controlling client; disconnect ends the call. Reconnect is a new session, not replayed speech. |
| POST `/api/sessions/:id/listen` | `{silence?:1.5}` establishes backend Scribe; returns only the required input audio format |
| POST `/api/sessions/:id/input-audio` | Raw mono signed little-endian 16-bit PCM at **16,000 Hz**; sequential 200ms chunks (6,400 bytes) recommended, max 320,000 bytes |
| POST `/api/sessions/:id/turn` | `{request_id:UUID, reply_id:UUID, text?, introduction?:true, client_ms?, words?}`. Introduction lets Claude choose its voice and greet you. Repeated request IDs are ignored. |
| POST `/api/sessions/:id/interrupt` | `{turn_id?, reason?}`; stop local playback immediately too |
| POST `/api/sessions/:id/config` | `{claude_model?, claude_effort?, voice_id?, topic?, user_name?, vision_level?, vision_source?, visuals?, style?, backdrops?}`; applies from the next reply, logged as `config-changed` |
| GET / POST `/api/agents/:id/prompt` | Participant prompt (`claude` or `codex`). GET returns text and defaults; POST `{text}` saves the local editable copy, `{reset:true}` restores its default. Applies from the next reply without losing native session context. |
| GET / POST `/api/prompt` | Backward-compatible alias for Claude's prompt. |
| GET / POST `/api/audio-mix` | Local browser audio balance in dB: `{user:13, claude:0, codex:-3}`. Defaults are all zero. Partial updates merge atomically; finite numbers from −18 to +18 only. Stored in `.runtime/audio-mix.json`; active calls emit `audio-mix-changed` and retain levels in `session.json`. |
| POST `/api/sessions/:id/mute` | `{muted:true|false}`; recorded/transmitted microphone samples become silence while muted |
| POST `/api/sessions/:id/event` | Playback/capture/marker evidence, below |
| POST `/api/sessions/:id/end` | `{}`; cancels generation, disconnects recognition, closes WAV recording |
| GET `/api/sessions/:id/download` | Session metadata JSON, not a media bundle |
| POST `/api/shutdown` | CLI-only lifecycle operation; ends calls and stops server |

The backend buffers final Scribe transcripts for 120ms after provider VAD, joins adjacent speech, deduplicates plain/timestamped commits, and sends the turn to the selected participant. Late word timestamps attach to the committed human turn without triggering another reply. Partial speech interrupts current output. Typed input, explicit interruption, and mute clear pending recognition so stale text cannot trigger a later reply. Clients **must not also submit automatic turns** from the same transcription. Typed turns use `/turn`.

SSE events include `connected`, `stt-connected`, `partial-transcript`, `user-turn`, `turn-start`, `model`, `voice`, `text`, `audio`, `alignment`, `turn-done`, `interrupted`, `mic-muted`, `mic-unmuted`, `error`, and `session-ended`. `audio` contains `{turn_id,audio:<base64 PCM>,sample_rate:24000,offset_seconds,duration_seconds}`. Schedule its buffers in order; ignore stale/interrupted turns. `alignment` contains `{turn_id,offset_seconds,alignment:{chars,char_start_times_ms,char_durations_ms}}` for the most recent audio chunk; character times are relative to that chunk's `offset_seconds`. The browser uses it to caption only what has actually played. `text` contains Claude-authored delivery tags; hide square-bracket tags only for the display, never rewrite the synthesis text.

`turn-done` means generation ended, **not playback**. Report `/event` with `type:"audio-playback"` or `"playback-complete"`, `turn_id`, and `played_seconds`. Mark estimates with `estimated:true`. For an interrupted turn, report playback then call `/interrupt`; the transcript will distinguish generated from heard content. `type:"marker", label` records an edit marker.

Browser capture can reuse `clients/browser/recording.js` and the PCM worklet. Media uploads use POST `/media?name=user-camera.webm&seq=0` (or `.mp4`, `user-microphone`, `stage`), raw body, ordered integer sequence. Immediate duplicate retry is idempotent; preserve IndexedDB backups until `media-complete` is confirmed. Send `media-start` / `media-complete` events with name and MIME type. Native clients write to the returned local recording directory and report matching media events.

The native CLI records microphone PCM continuously and optionally camera `.mov`. The browser client sends microphone PCM to `/input-audio`, so recognition and all provider authentication remain server-side. Do not reintroduce an ElevenLabs WebSocket or token into the browser.

Only one active session is allowed. Error JSON is `{error:"message"}`. Retain source recordings after failures. The current server keeps live session control in memory; after a restart, old sessions are read from disk via `./interview session UUID` and cannot resume.

## Visuals while Claude talks

Sessions accept `visuals: "off" | "useful" | "always"` (default `off`, so CLI calls don't spend extra requests) and `style` (one of the looks in `/api/status` → `scene_styles`, e.g. `"cafe"`, `"clawd"`, `"riso"`); both can change via `/config`. Pictures are drawn in two passes by parallel Claude calls that never delay speech (prompt in `prompts/scene.md`):

1. **Sketch** (`claude-sonnet-5`, effort `low`, override with `INTERVIEW_SKETCH_MODEL`). It decides whether a new picture is wanted: `scene-keep` means keep the one on screen and `scene-none` means no picture. If a new picture is wanted, it streams a header (`scene-base` `{scene_id: "scene-NNN-sketch", title, subject, composition, shot, base, palette}`) and then short canvas code (`scene-ready`). It starts while the person is still speaking, once about 3 s and 8 words of live transcript are in, so it is usually ready as Claude starts to answer. A turn whose speech already started a picture doesn't start another.
2. **Finished picture** (`claude-opus-5-5`, effort `low`, override with `INTERVIEW_SCENE_MODEL`). It is given the sketch's header and code to develop, waiting up to 10 s for the turn to finish first. It is announced with `scene-base` `{scene_id: "scene-NNN", refine: true}` and `scene-ready`, and the page crossfades it over the sketch.

Code is compile-checked and saved as `recordings/<id>/scenes/scene-NNN-sketch.js` and `scene-NNN.js`. The session's `scenes` list keeps the finished picture, with `sketch_file`. `scene-error` (`sketch: true` for the first pass) keeps whatever is showing; a failed sketch with nothing on screen gets a library stand-in until the finished picture arrives. One picture is in progress at a time: a new turn queues one follow-up and never cancels. `/scene-frame/<session>/<scene>` serves the code in a sandboxed page (opaque origin, `connect-src 'none'`) that posts ImageBitmaps to the studio page, which composites them into the recorded frame.


With `backdrops: true`, a third low-effort call (`prompts/backdrop.md`) paints a quiet backdrop for the person's side, announced as `backdrop-ready` and served from the same sandboxed frame route.

`user_name` is optional display text (at most 40 characters). When set, one line naming the person is appended to each participant's system prompt for that call only; the prompt files never contain it.

## Vision (shared call or camera)

`vision_source: "camera" | "room"` is accepted at session creation and by `/config`.
API clients default to `camera` for compatibility. The browser defaults to `room`,
which captures only the recorded call canvas, including the avatars and the
human's camera or camera-off tile. It excludes browser controls and other apps.
Camera-only frames are raw and unmirrored; call frames preserve visible camera
effects and mirroring.

`vision_level: "off" | "still" | "few" | "more" | "live"` controls frames per reply:
0, 1, up to 3, 8, or 40. API default is `few`; a new browser defaults to `still`.
Existing saved browser choices are kept. `vision: false` still means off.

POST `/api/sessions/:id/frame?source=camera|room` with a JPEG (maximum 1.5 MB).
Omitted source means `camera`. The backend rejects unknown sources, ignores
frames for the inactive source or when vision is off, and clears the buffer when
source changes. The browser samples once a second at 1280 px for the call view
(960 at live), or 768 px for camera-only (512 at live). The buffer covers at most
60 seconds and a latest frame older than 10 seconds is not used.

Both providers receive images in chronological order with source/timing labels.
Claude uses image blocks and Codex uses CLI `--image` attachments plus ordered
labels. The prompt explicitly says whether images are present, identifies the
call participants and selected models, and distinguishes avatars from cameras.
Exactly the selected images are saved as `vision/<reply-id>-N.jpg`, listed in
`turn.seen` as `{file, at_ms, source}`, and logged with `vision-sent`. History does
not replay old image attachments; the current short buffer may supply the same
fresh still to more than one reply. Switching vision off clears that buffer.

## Streaming (optional)

| Method and endpoint | Input / result |
| --- | --- |
| GET `/api/broadcast/status` | `{state, mode, frames, fps, seconds, bytes, error, key_set}`; never the key |
| POST `/api/broadcast/start` | `{mode:"test"|"x", url?}`. `test` writes a local MP4 to `.runtime/stream-checks/`. `x` needs an RTMPS address from X (or `X_STREAM_URL`) and a key set in the backend (`./interview stream-key set` or `X_STREAM_KEY`); a key in the request body is ignored. |
| POST `/api/broadcast/chunk?id=&seq=` | Ordered WebM chunks from the page's `MediaRecorder` |
| POST `/api/broadcast/stop` | Stops the encoder and returns the final status |

## Participant selection

`POST /api/sessions` accepts `claude_enabled` (default `true`),
`codex_enabled` (default `false`), `codex_model`
(default `gpt-6-astra`), `codex_effort` (default `low`), and `codex_voice_id`.
The same fields work on `POST /api/sessions/:id/config`, including joining and
leaving during a call. `/api/status` includes `codex.ready`, the installed CLI's
model catalogue and supported effort levels. Unsupported choices fail explicitly.
At least one agent must be selected. Only selected agents require their subscription
login and receive replies or painting requests. Removing either agent cancels their
active speech, pending contributions, and painters, and clears stale call-view frames.
The remaining agents retain the shared conversation history.
Codex uses the existing `codex login` ChatGPT subscription; there is no API-key fallback.

`POST .../turn` optionally accepts `speaker: "claude" | "codex"`. Otherwise a name
in the human turn chooses a selected speaker (a direct address takes priority over an earlier mention), and unaddressed turns rotate through the selected roster. An explicit unselected speaker is rejected. With one agent, every
turn goes to that agent and no peer contribution runs.
`turn-start`, `text`, `audio`, `alignment`, `model`, and `turn-done` carry `speaker`.
Clients must serialize playback and report `playback-complete` only when the
actual audio has finished. With multiple agents present, the next listener can prepare one
text response as soon as the current speaker's complete text is known, overlapping synthesis and playback. No `turn-start`, text, speech connection, or audio
is released for that response before the playback report. After each completed turn,
the next participant can respond. There is no fixed two-reply limit.
`turn-skipped` means the listener chose to leave the floor open (`[[pass]]`), without audio or captions. The next eligible listener is offered a turn. If every listener passes, the exchange rests until a new human turn.

`conversation-state` carries `continuing: boolean`. Keep Interrupt available while
true, including pauses between speakers. An explicit `interrupt` without a `turn_id`
stops both current speech and prepared continuation. Human speech, participant changes,
and ending also discard preparation. Model, prompt, or visual-context changes refresh
it. Prepared text is not included in shared history. Private `reply-preparing` and
`reply-prepared` and `text-done` events preserve timing evidence; promoted turns may include
`prepared_at_ms`, while `at_ms` remains when the turn took the floor.

Sessions include `codex_voice`, `actual_codex_model`, and turns labelled `codex`.
Per-reply files are `codex-<turn-id>.wav`; the browser also records a separate
`codex-voice.wav` stem on the same clock as the other voices and full frame.
`media` and `recover` accept `codex-voice.pcm` using the existing PCM contract.

Each participant owns a separate native provider session for the duration of a call:
Claude Code uses `--resume`, and Astra uses `codex exec resume`. Follow-ups append
room updates to that participant's existing history, preserving native reasoning
state and images rather than rebuilding from a bounded shared transcript. The CLI
manages context limits and compaction; this is not unlimited verbatim memory.
No custom 120,000-character window is applied to participant requests. One-off
helpers such as voice selection still use a bounded transcript.
The system prompt stays fixed within each native session so earlier signed
reasoning remains valid. Current room and vision notes are appended in the input;
editing or resetting the conversation prompt appends an `instruction_update`.

Room updates contain `context_mode: "initial" | "updates"` and speaker-labelled
`conversation` entries keyed by `turn_id`. A later entry for the same ID supersedes
its earlier delivery status. After an interruption, the next update includes only
the aligned words that actually played. Native history can retain an earlier
expected ending or the agent's own unspoken response, so delivery corrections
explicitly distinguish private preparation from what the room heard. A cancelled
preparation that never entered the room also receives a `previous_reply` receipt.
Only public speech crosses between provider sessions; private reasoning is never
extracted into the app transcript, speech, captions, events or the peer's input.

Calls get independent session IDs. Removing and rejoining a participant within the
same call retains its native session and catches it up on new room speech. Requests
for a participant are serialized through cancellation and process exit before
resuming, avoiding concurrent writes to native history. A resume failure is shown
as an error, never silently replaced by a fresh context. Native session files remain
in their providers' usual storage; `agent-sessions/<speaker>/session.json` stores
only that participant's native session ID, outside the public session payload.

Higher thinking
levels can increase response latency. Codex CLI emits complete answer messages;
speech synthesis starts when its answer arrives. This is turn-based voice, not a
native realtime audio model. The participant cannot execute tools or edit files.

Agent replies in the shared history include `visual_context: {frames, source?, captured_at_ms?}`. This records the image input available on that past reply, without sharing local file paths. Current vision being off does not erase that historical provenance.

### Astra settings

When `codex_enabled` is true and `visuals` is not `off`, a separate Codex request
using the selected model and effort paints Astra's background. It uses
`prompts/codex-backdrop.md`, the recent shared transcript, and previous setting
titles. Requests are coalesced and limited to at most one start per minute.
It never writes speech or holds the conversational floor.

`backdrop-ready` and `backdrop-error` now include `speaker` (`user` or `codex`).
The human's `backdrops` archive is unchanged. Astra's archive is
`codex_backdrops`, with files `backdrops/codex-backdrop-NNN.js` and the same
`/scene-frame/:session/:id` renderer, at 700 × 1030. Each entry includes its model
and effort. The frame is sandboxed with no network access; the client waits for
a valid image before crossfading. Off, leave, and end abort painting and discard
late results. The viewer releases its bitmaps and iframe when stopped.

### Muting and speech finalization

Mute stops new microphone input. An utterance captured before the click is still
allowed to finish recognition and commit once, even if its final transcript arrives
after mute or during the commit debounce. Muting does not cancel agent speech,
preparation, or the current exchange. Explicit Interrupt and a new typed turn still
replace pending recognition. The adjusted microphone mix is also silenced while
muted; changing a trim never unmutes it.

The status response includes `agents` metadata and `audio_mix`; session responses
include normalized `participants` alongside the existing configuration fields.
Each participant owns a separate native session directory. The spoken transcript
and delivery receipts are shared; provider reasoning is not copied between them.
