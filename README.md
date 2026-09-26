# Speaking to AIs

A local, recorded voice call with the AI participants you select.

- **Claude** uses your installed Claude Code CLI; **Astra** uses Codex with your ChatGPT subscription. The browser defaults to **Opus 5.5** and **GPT-6 Astra / Low**, with model and thinking controls for each.
- Each participant has its own animated avatar, voice, editable prompt, and native conversation session. They see the shared transcript and optional call images while retaining their separate context.
- Participants can answer each other without waiting for another human turn. Speak or press Interrupt to take the floor; mute only stops new microphone input.
- **ElevenLabs** supplies transcription and speech. Recording, playback, settings, and the room run locally in a small Node server and browser, with no npm dependencies.

## What you need

| | |
| --- | --- |
| Computer | macOS is the tested platform. The browser room should work on Linux and Windows with keys in `.env`; the terminal-only `talk` mode is macOS-only. |
| Browser | Chrome or another Chromium browser (camera, Web Audio, `MediaRecorder` with H.264). |
| Node.js | 22 or newer. |
| Claude | [Claude Code](https://code.claude.com/docs/en/setup) installed and signed in with a Claude plan, **or** an Anthropic API key (see [API-key mode](#api-key-mode)). |
| Astra (optional) | Codex CLI installed and signed in with `codex login` using your ChatGPT subscription. |
| ElevenLabs | An account and API key with **Text to Speech**, **Speech to Text** and **Voices: read** permissions. Real conversations use credits quickly, so a paid plan is realistic. |
| ffmpeg | Optional. Needed only for terminal `talk` mode and live streaming. |
| Headphones | Strongly recommended, so the agents' voices aren't transcribed as yours. |

## Quick start

```sh
git clone <this repository> claude-interview
cd claude-interview
./interview login        # Claude Code sign-in (skip if `claude` is already signed in)
./interview key set      # paste your ElevenLabs key into the hidden prompt (macOS Keychain)
./interview up           # start the local backend
open http://127.0.0.1:4747
```

On Linux or Windows, or if you'd rather not use Keychain, copy `.env.example` to `.env` and set `ELEVENLABS_API_KEY` there. On Windows, use `npm run interview -- up` in place of `./interview up`. On macOS, double-clicking **Start Studio.command** runs `up` and opens the page.

Choose available agents under **Participants**, select your devices, then press **Start**.

- **Agents:** model, thinking, voice previews, and a separate prompt editor for each participant.
- **Room:** devices, audio balance, topic, opening speaker, vision, and optional artwork and camera effects.
- **Streaming:** local recording, stream controls, and recovery when a save needs attention.
- **During a call:** Mute (M), Interrupt (I), Mark (K), Mirror (V), Visual (X), Transcript (T), Captions (C), Clean frame (F), and End.

**Audio balance** has a separate trim for your microphone and each agent. It applies to browser voice playback, the mixed recording, voice stems, and streaming. Peak compression and a final ceiling protect loud transients. Levels start at 0 dB and are saved only on this installation; raw camera audio and recognition input are unchanged. Set the trims for your microphone and selected voices rather than assuming every setup has the same level.

Check setup at any time with `./interview status`. It reports readiness and never prints keys.

## How it works

```
Chrome page ──16 kHz PCM, camera stills──▶ local backend ──▶ ElevenLabs Scribe (turn detection)
     ▲                            │
     │                            ├──▶ Claude Code / Codex native sessions  ──text──▶ ElevenLabs v3 ──24 kHz PCM──┐
     └──────── SSE: text, audio, captions, scenes ◀──────────────────────────────────────────────────────┘
```

- The backend owns every credential, the transcription session and turn detection. The page captures audio, plays each participant's reply through Web Audio, reports exactly how much was actually heard, and records.
- **Claude's reactions** come from real events, not a script:
  - delivery cues in its reply, and the tone of the words it's actually saying (a small, readable word list in `public/emotion.js`);
  - what you say, and your live mic;
  - being interrupted;
  - small habits between turns.

  A shared spring-based emotion engine (`public/expression.js`) turns these into faces, petals, gestures and body language.
- **Vision:** the page samples your chosen call view or camera once a second. The backend keeps a one-minute buffer and attaches selected stills to each participant's reply, with source and timing labels. Exactly those images are saved with the recording.
- **Pictures** are drawn in two passes:
  1. A quick sketch by Sonnet, started while you're still talking. It usually appears as Claude begins to answer.
  2. The finished picture by Opus, developed from that sketch and crossfaded over it about half a minute later.

  The code runs in a sandboxed frame with no network access, and the page composites it into the recorded frame.
- Your background is cut out on your machine with Google's MediaPipe selfie segmenter, bundled in `public/vendor/`.

Each spoken reply uses the selected participant's model; shared images also count toward that provider's usage. With visuals on, each new picture adds a Sonnet sketch and an Opus finishing call, and the backdrop behind you is an occasional extra call. All of these count toward your plan's usage.

## Recordings

Every call is saved under `recordings/<session-id>/`:

| File | What it is |
| --- | --- |
| `stage.webm` / `.mp4` | The composed 1920×1080 call, as seen on screen |
| `user-camera.webm` / `.mp4` | Your raw camera and microphone |
| `user-voice.wav`, `claude-voice.wav`, `codex-voice.wav` | Lossless stems on the browser audio clock: your mic (silent while muted) and each agent after audio balance. Use these for editing. |
| `user-microphone.wav` | The 16 kHz audio sent to recognition |
| `claude-<turn>.wav`, `codex-<turn>.wav` | Each generated reply. It may include an unheard ending if you interrupted. |
| `session.json`, `events.jsonl` | Transcript, model, voice, timings, interruptions, markers, and generated vs. played seconds |
| `scenes/`, `backdrops/` | The generated visual programs: each picture's quick sketch (`scene-NNN-sketch.js`) and its finished version (`scene-NNN.js`) |
| `vision/` | The stills each participant was actually shown, listed against each reply as `seen` |

If a tab closes mid-call, the browser keeps backups, and the page recovers them into the session folder the next time it opens. `./interview review <session-id>` asks Claude for proposed highlights and cuts. It writes a new `annotations-*.json` and never alters the originals.

## Command line

```
./interview up | down | status | help
./interview login                 Claude Code subscription sign-in
./interview key set               ElevenLabs key (hidden prompt → Keychain)
./interview talk [--name Ada]     Terminal-only call (macOS; mic via ffmpeg, playback via ffplay)
./interview say 'words'           Type a turn into the active call
./interview mix [user|claude|codex dB]  Inspect or change browser audio balance
./interview interrupt | mute | unmute | mark | stop
./interview sessions | session <id> | events
./interview review <id>
```

The browser and the CLI control the same backend, so you can mark or stop a browser call from a terminal.

## Configuration

All optional, in `.env` (see `.env.example`):

| Variable | Default | |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | Keychain | ElevenLabs key |
| `INTERVIEW_PORT` | `4747` | Local port |
| `INTERVIEW_USER_NAME` | none | Name for CLI calls; the browser has its own field |
| `INTERVIEW_SKETCH_MODEL` | `claude-sonnet-5` | Model for the quick first sketch of each picture |
| `INTERVIEW_SCENE_MODEL` | `claude-opus-5-5` | Model that finishes each picture (and paints your backdrop) |
| `CLAUDE_BIN`, `FFMPEG_BIN`, `FFPLAY_BIN` | from `PATH` | Tool locations |

### API-key mode

By default the backend refuses to run Claude through anything but your Claude Code login. It strips gateway and API variables from the environment it passes to Claude Code, so nothing is billed somewhere you didn't expect. To use an Anthropic API key instead, set both in `.env`:

```
INTERVIEW_CLAUDE_AUTH=api
ANTHROPIC_API_KEY=sk-ant-...
```

### Streaming to X (optional)

Settings → **Streaming → Stream to X** sends the composed frame with all selected voices over RTMPS, using ffmpeg.

- Put the stream key in the backend with `./interview stream-key set`, or `X_STREAM_KEY` in `.env`. The page never receives it.
- **Test locally** records a 12-second check to `.runtime/stream-checks/` first.
- See [SECURITY.md](SECURITY.md) for one caveat about the key while a stream is running.

## Privacy

- Your speech audio goes to ElevenLabs for transcription. Conversation text goes to Anthropic through Claude Code. Claude's reply text goes to ElevenLabs for speech.
- **Camera stills go to Anthropic** with Claude's replies while **Claude sees you** is on, which it is by default at "few". Set it to **Off** to keep your camera entirely local. The stills that were sent are saved in the session's `vision/` folder.
- Otherwise camera video, background segmentation and all recordings stay on your computer.
- The page's content security policy blocks every other connection, including MediaPipe's usage telemetry.

## Development

```sh
npm test    # node:test, no dependencies
```

- `src/` is the backend: server, Claude and ElevenLabs clients, scene director, streaming.
- `public/` is the room: stage compositor, characters and their emotion engine, audio, recording.
- `prompts/` holds participant instructions. `conversation.default.md` and `codex.default.md` are tracked; editable `conversation.md` and `codex.md` stay local.
- `public/participants.js` supplies the roster used by settings, prompt routes, turn scheduling, native context allocation, and recording channels. Adding a provider still requires its adapter, model catalogue, and avatar renderer; common flows do not assume exactly two agents.
- The API is documented in [docs/api.md](docs/api.md), and [CONTRIBUTING.md](CONTRIBUTING.md) lists the ground rules.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). "Claude" and the Clawd character are trademarks of Anthropic. The code license doesn't grant rights to those marks.

### Choose participants

Click **Participants** to select **Claude**, **Astra**, or **both**, before or during
a call. Connected agents are marked Available. The stage follows your selection,
and your choices are remembered. Keep at least one agent in an active call.
Astra defaults to **GPT-6 Astra / Low**. Change each agent’s model, thinking level,
and ElevenLabs voice in **Settings → Agents**; changes apply to the next reply. Your
existing ChatGPT subscription login powers Codex (`codex login status` should say
“Logged in using ChatGPT”). Speech and transcription still use ElevenLabs.

Selected agents receive the shared transcript. Say “Claude” or “Codex” / “Astra” to
address one; the common transcription “Astro” also reaches Astra. With both present,
they can answer each other and continue a conversation without another human prompt.
Each participant receives an opening to speak and can choose to remain silent.
Speak or press **Interrupt** to stop the exchange, including between speakers.
Default instructions describe identity, call context and speech/vision mechanics;
they do not prescribe personality, turn length, questions or disagreement. The
models choose what to say, while the app controls speaking order and playback.

The listener prepares one text reply while the current voice plays. It enters the
conversation only after confirmed playback; interrupted or outdated preparation is
discarded. Speech uses one queue and separate voice stems. Either agent can join or
leave mid-call. An Astra-only call needs no Claude login or Claude requests.

Astra is a blue, cloud-shaped storybook character based on the original
[Codex app identity](https://openai.com/codex/get-started/), with ink outlines,
pencil texture, expressive eyes, speech-driven mouth shapes, and spring-driven
hands. All participant names sit above their tiles. Jessica, ElevenLabs' female
conversational voice, is the default; saved voice choices are retained.

With **Room → Conversation visuals** on, Astra paints her own animated setting
through the selected Codex model and thinking level. It runs independently of
speech, keeps the current setting when it fits, and considers a change at most
once a minute. The illustrated observatory is visible immediately while the first
painting arrives. Generated backgrounds count toward the Codex subscription.
Turning visuals off or removing Astra stops her painter. The human's camera
background remains a separate control.

In **Room → Share with the agents**, choose the call view (the human and avatars)
or just the camera. **Still** shares one image per reply by default; **Off** shares
none. Both agents receive the labelled conversation and current call context. They
know avatars are illustrations, and that they receive snapshots rather than
continuous vision. The shared call canvas includes no desktop or settings UI.
Camera backgrounds default to the original camera; optional effects are tucked
under **Camera effects & resolution**.

Settings are grouped into **Agents**, **Room** (devices, appearance and call
behavior), and **Streaming** (recordings and broadcast). For a keyboard-only call,
choose **No microphone · type instead** and **No camera**, then Start.

CLI: `./interview talk --codex --codex-model gpt-6-astra --codex-effort low`.
Use `./interview codex on` or `./interview codex off` for an active call.
The integration uses [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
with a private native conversation for each participant in each call. Claude Code
resumes Claude's session; Codex resumes Astra's thread. Each retains its own history,
observations and provider-managed reasoning state, with native context compaction
on long calls. New room speech and playback corrections are added as incremental
updates. Reasoning and unspoken drafts are never shared with the other participant
or included in captions, speech or the recording transcript.

The participants run in separate, dedicated working directories with tools,
plugins, MCP, project instructions and unrelated personal memories disabled.
The providers keep their native session files; the recording folder stores only
the session IDs under `agent-sessions/`. Calls start separate sessions, and leaving
and rejoining the same call preserves that participant's session. Background
visual and voice-selection helpers remain one-off requests. This reuses CLI authentication;
it does not extract credentials, alter Codex settings, or fall back to API billing.
