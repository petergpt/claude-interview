# Notes for coding agents

Read README.md, docs/api.md and CONTRIBUTING.md first. The backend is `src/` (Node 22, no dependencies); the browser room is `public/` (plain ES modules, no build step).

- Credentials only ever live in the backend (Keychain or `.env`). Never add a key field to the UI and never put a secret in a process argument you control.
- Claude runs through the user's installed Claude Code CLI (`src/claude.mjs`); keep the subscription login the default and do not extract OAuth credentials.
- Preserve raw recordings and the difference between generated and played speech.
- Run `npm test` after changing authentication, speech, interruption or recording logic. Don't claim a microphone, camera or listening check passed unless you actually ran it.
- Don't restart the backend while a call is active (`./interview status` shows `activeSession`).
