# Claude Interview

A hands-free, recorded video call with Claude, set up like a talk show.

- **Your camera** sits on the left.
- **Claude is the host** on the right: an animated character (a flower-headed café regular by default) that reacts as the conversation goes. It laughs, doubts, lights up, gets flustered, waves, and sips its coffee between turns.
- **Pictures of what you're talking about** are painted live on a screen on the set beside it.
- **Claude can see you** through your camera and answers in an expressive voice. You can interrupt it just by speaking.
- **Everything is recorded locally** in edit-ready form.

- **Claude** runs through your own installed [Claude Code](https://code.claude.com) CLI, signed in to your Claude plan (or an Anthropic API key, if you prefer).
- **ElevenLabs** provides speech recognition (Scribe v2 realtime) and the voice (Eleven v3 conversational).
- **Everything else is local**: a small Node server on `127.0.0.1` with no npm dependencies, and a browser room in Chrome.

## What you need

| | |
| --- | --- |
| Computer | macOS is the tested platform. The browser room should work on Linux and Windows with keys in `.env`; the terminal-only `talk` mode is macOS-only. |
| Browser | Chrome or another Chromium browser (camera, Web Audio, `MediaRecorder` with H.264). |
| Node.js | 22 or newer. |
| Claude | [Claude Code](https://code.claude.com/docs/en/setup) installed and signed in with a Claude plan, **or** an Anthropic API key (see [API-key mode](#api-key-mode)). |
| ElevenLabs | An account and API key with **Text to Speech**, **Speech to Text** and **Voices: read** permissions. Real conversations use credits quickly, so a paid plan is realistic. |
| ffmpeg | Optional. Needed only for terminal `talk` mode and live streaming. |
| Headphones | Strongly recommended, so Claude's voice isn't transcribed as yours. |

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

In the page, allow the camera and microphone, optionally type your name in **Settings**, and press **Start**. Claude greets you, then just talk. By default Claude sees a few stills from your camera with each of your turns; change that under **Settings → Claude sees you**.

- **During a call:** Mute (M), Interrupt (I), Mark a moment (K), Mirror (V), Visual (X), Transcript (T), Captions (C), Clean frame for screen capture (F), End.
- **Settings (S)**, available at any time:
  - Model and thinking level.
  - Claude's look: Café (the default), Clawd papercraft, Bloom, 8-bit, Sun, Flock, Riso or Ink.
  - Claude sees you: off, still, few, more or live. This sets how many stills from your camera go with each of your turns, from one to about one a second.
  - Generated visuals: off, when useful, or every reply.
  - Your background: camera, blur, or the conversation's own generated backdrop.
  - Voice, with samples.
  - Claude's system prompt, which you can edit.

Outside a call, Claude's eyes follow your cursor. Click on Claude and it giggles; poke it too often and it gets fed up.

Check setup at any time with `./interview status`. It reports readiness and never prints keys.

## How it works

```
Chrome page ──16 kHz PCM, camera stills──▶ local backend ──▶ ElevenLabs Scribe (turn detection)
     ▲                            │
     │                            ├──▶ claude -p (your Claude Code)  ──text──▶ ElevenLabs v3 ──24 kHz PCM──┐
     └──────── SSE: text, audio, captions, scenes ◀──────────────────────────────────────────────────────┘
```

- The backend owns every credential, the transcription session and turn detection. The page captures audio, plays Claude's reply through Web Audio, reports exactly how much was actually heard, and records.
- **Claude's reactions** come from real events, not a script:
  - delivery cues in its reply, and the tone of the words it's actually saying (a small, readable word list in `public/emotion.js`);
  - what you say, and your live mic;
  - being interrupted;
  - small habits between turns.

  A shared spring-based emotion engine (`public/expression.js`) turns these into faces, petals, gestures and body language.
- **Vision:** the page sends one small still from your camera each second, and the backend keeps the last minute in memory. When Claude replies, the stills for your chosen level go with it as images through Claude Code's streaming input.
- **Pictures** are drawn in two passes:
  1. A quick sketch by Sonnet, started while you're still talking. It usually appears as Claude begins to answer.
  2. The finished picture by Opus, developed from that sketch and crossfaded over it about half a minute later.

  The code runs in a sandboxed frame with no network access, and the page composites it into the recorded frame.
- Your background is cut out on your machine with Google's MediaPipe selfie segmenter, bundled in `public/vendor/`.

Each reply is one Claude call; at the default vision level it carries about 1,300 extra tokens of camera stills. With visuals on, each new picture adds a Sonnet sketch and an Opus finishing call, and the backdrop behind you is an occasional extra call. All of these count toward your plan's usage.

## Recordings

Every call is saved under `recordings/<session-id>/`:

| File | What it is |
| --- | --- |
| `stage.webm` / `.mp4` | The composed 1920×1080 call, as seen on screen |
| `user-camera.webm` / `.mp4` | Your raw camera and microphone |
| `user-voice.wav`, `claude-voice.wav` | Lossless 48 kHz stems on one clock: your mic as captured (silent while muted) and exactly what Claude played. Use these for editing. |
| `user-microphone.wav` | The 16 kHz audio sent to recognition |
| `claude-<turn>.wav` | Each generated reply. It may include an unheard ending if you interrupted. |
| `session.json`, `events.jsonl` | Transcript, model, voice, timings, interruptions, markers, and generated vs. played seconds |
| `scenes/`, `backdrops/` | The generated visual programs: each picture's quick sketch (`scene-NNN-sketch.js`) and its finished version (`scene-NNN.js`) |
| `vision/` | The camera stills Claude was actually shown, listed against each reply as `seen` |

If a tab closes mid-call, the browser keeps backups, and the page recovers them into the session folder the next time it opens. `./interview review <session-id>` asks Claude for proposed highlights and cuts. It writes a new `annotations-*.json` and never alters the originals.

## Command line

```
./interview up | down | status | help
./interview login                 Claude Code subscription sign-in
./interview key set               ElevenLabs key (hidden prompt → Keychain)
./interview talk [--name Ada]     Terminal-only call (macOS; mic via ffmpeg, playback via ffplay)
./interview say 'words'           Type a turn into the active call
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

Settings → **Stream to X** sends the composed frame with both voices over RTMPS, using ffmpeg.

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
- `prompts/` holds Claude's instructions. `prompts/conversation.default.md` is tracked; your edits go to the untracked `prompts/conversation.md`.
- The API is documented in [docs/api.md](docs/api.md), and [CONTRIBUTING.md](CONTRIBUTING.md) lists the ground rules.

## License

MIT, see [LICENSE](LICENSE). Bundled third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). "Claude" and the Clawd character are trademarks of Anthropic. The code license doesn't grant rights to those marks.
