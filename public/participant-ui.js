import { AGENTS } from './participants.js';
// All template content comes from the local roster, never model output.
export function mountParticipantControls() {
  document.querySelector('#agent-cards').innerHTML = AGENTS.map(a => `
    <section class="agent-card ${a.id}-card">
      <div class="agent-heading"><span class="agent-symbol ${a.symbolClass}" aria-hidden="true">${a.symbol}</span><div><h3>${a.name}</h3></div><span class="member-badge" id="${a.id}-membership"></span></div>
      <p class="connection-note" id="${a.id}-status" role="status">Checking connection…</p>
      <div class="row two"><label>Model<select id="${a.controls.model}" aria-label="${a.name} model"></select></label><label>Thinking<select id="${a.controls.effort}" aria-label="${a.name} thinking level"></select></label></div>
      <div class="voice-pick"><label>Voice<select id="${a.controls.voice}" aria-label="${a.name} voice"></select></label><button type="button" class="play" id="${a.controls.sample}" title="Hear ${a.name}'s voice" aria-label="Hear ${a.name}'s voice"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button></div>
      <details class="more"><summary>Prompt</summary>
        <div class="field-head"><label class="lbl" for="prompt-${a.id}-text">${a.name}’s prompt</label><span class="prompt-actions"><button type="button" class="link" id="prompt-${a.id}-reset">Reset</button><button type="button" class="small" id="prompt-${a.id}-save" disabled>Save</button></span></div>
        <textarea class="prompt-text" id="prompt-${a.id}-text" spellcheck="true"></textarea>
      </details>
    </section>`).join('');
  document.querySelector('.participant-options').innerHTML = AGENTS.map(a => `
    <label class="participant-option" data-agent="${a.id}"><span class="agent-symbol ${a.symbolClass}" aria-hidden="true">${a.symbol}</span><span class="participant-detail"><strong>${a.name}</strong><span id="participant-${a.id}-status">Checking…</span></span><input type="checkbox" id="participant-${a.id}" aria-label="${a.name}" aria-describedby="participant-${a.id}-status"></label>`).join('');
  document.querySelector('#sel-opener').replaceChildren(...AGENTS.map(a => new Option(a.name, a.id)), new Option('Me', 'user'));
  document.querySelector('#audio-levels').innerHTML = [{ id: 'user', name: 'You' }, ...AGENTS].map(a => `
    <label class="audio-level" data-level="${a.id}"><span>${a.name}</span><input id="level-${a.id}" type="range" min="-18" max="18" step="1" value="0" aria-label="${a.name} audio level"><output for="level-${a.id}" id="level-${a.id}-value">0 dB</output></label>`).join('');
}
