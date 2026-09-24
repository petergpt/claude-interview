# Security

The studio is a local tool. The backend listens only on `127.0.0.1`, and requests are rejected unless all three hold:

- the `Host` is `127.0.0.1` or `localhost` on its port, which blocks DNS rebinding;
- the request is not cross-site;
- it carries the HttpOnly `SameSite=Strict` cookie the page receives when it loads.

## Where secrets live

| Secret | Stored | Never |
| --- | --- | --- |
| ElevenLabs API key | macOS Keychain (`claude-interview.elevenlabs`) or `ELEVENLABS_API_KEY` in `.env` | in the page, recordings, logs, prompts or command arguments |
| Realtime transcription tokens | backend memory only | returned to any client |
| Claude login | Claude Code's own credential store. The studio runs `claude`; it never reads or forwards OAuth tokens. | copied anywhere |
| Anthropic API key (optional API mode) | `ANTHROPIC_API_KEY` in `.env`, passed only to the `claude` process | anywhere else |
| X stream key (optional) | Keychain (`claude-interview.x-stream-key`) or `X_STREAM_KEY` | in the page or logs (redacted from ffmpeg output) |

**Known limitation:** ffmpeg takes the RTMPS destination, which includes the stream key, as a command-line argument. While a stream is running, other accounts on the same computer can see it in the process list. Use a single-user machine for streaming, and reset the key in X if in doubt.

## Generated code

Scene and backdrop programs written by Claude run in a sandboxed frame. The frame has an opaque origin, allows scripts only, and its content security policy is `connect-src 'none'`: no network, no storage, no access to the studio page. Code is compile-checked before it is served.

## Reporting a vulnerability

Please open a private security advisory on the repository, rather than a public issue.
