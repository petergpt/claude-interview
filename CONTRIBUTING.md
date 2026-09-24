# Contributing

Issues and pull requests are welcome. Run `npm test` before sending a change. Ground rules that keep the project what it is:

- **No dependencies without a strong reason.** The backend uses only Node's standard library. Anything vendored goes in `public/vendor/` with an entry in `THIRD_PARTY_NOTICES.md`.
- **Secrets stay in the backend.** No key or token fields in the page, no secrets in command arguments, logs or recordings.
- **Recordings are evidence.** Never rewrite source media. New edits, annotations or pickups are new files.
- **Generated is not heard.** Keep the distinction between audio that was generated and audio that was actually played.
- **The CLI can do everything.** New features must be controllable through `./interview` or the local API.
- **Test what you claim.** Say plainly what was checked with a real microphone, camera or listener and what wasn't.
