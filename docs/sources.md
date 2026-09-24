# Official sources checked on 24 September 2026

- [Claude Code: programmatic operation](https://code.claude.com/docs/en/headless) — CLI print mode, incremental JSON events, final results, cancellation, and the fact that bare mode skips subscription OAuth.
- [Claude Code: authentication](https://code.claude.com/docs/en/authentication) — subscription login, credential precedence and gateway/API overrides.
- [ElevenLabs: model catalogue](https://elevenlabs.io/docs/overview/models) — `eleven_v3` and `eleven_v3_conversational`; provider timing figures describe the speech model, not this entire call.
- [ElevenLabs: Text to Dialogue WebSocket](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket) — v3 endpoint, voice registration, text streaming, end-of-turn/final markers, PCM and alignment.
- [ElevenLabs: realtime dialogue guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd) — supported first-message authentication, keep-alive, buffering and `close_socket`.
- [ElevenLabs: TTS vs. dialogue WebSockets](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets) — v3 must use the dialogue socket, rather than the non-v3 TTS socket.
- [ElevenLabs: audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-alpha) — emotion, delivery and reaction cues.
- [ElevenLabs: speech best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices) — pronunciation, punctuation and v3's lack of SSML break support.
- [ElevenLabs: Scribe client reference](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe) — VAD thresholds, committed transcripts and word timing.
- [ElevenLabs: client-side transcription](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming) — client microphone streaming with temporary authentication.
- [ElevenLabs: single-use tokens](https://elevenlabs.io/docs/api-reference/tokens/create) — `realtime_scribe` tokens and expiry.
- [Official ElevenLabs MCP server](https://github.com/elevenlabs/elevenlabs-mcp) — available for creative and file-oriented audio tools; not required for this studio's streaming transport.
