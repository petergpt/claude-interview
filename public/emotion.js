// Reads the feeling of words that are actually being said, so the character's face follows the conversation
// even when Claude uses no delivery cues. It is a small, transparent word list, not a model: each rule names a
// mood understood by the emotion engine (expression.js). The first matching rule wins.

// Claude's own sentence, read as it starts to play.
const SPOKEN = [
  [/^(hey|hi|hello|good (morning|afternoon|evening))\b/, 'wave'],
  [/\b(ha(ha)+|that's (hilarious|funny)|so funny|ridiculous|absurd|cheeky|you're joking|i'm joking)\b/, 'amused'],
  [/\b(oops|my mistake|i stand corrected|you're right,? i was|i was wrong|fair cop|you caught me|guilty)\b/, 'embarrassed'],
  [/\b(wait|hold on|oh!|really\?|no way|didn't expect|i had no idea|surprising(ly)?)\b/, 'surprised'],
  [/\b(i'?m (so )?sorry|that's (hard|rough|tough|sad)|sad|lonely|grief|heartbreak|painful|unfortunately|i hear you)\b/, 'sympathetic'],
  [/\b(worr(y|ied|ying)|concern(ed|ing)?|scary|frightening|dangerous|the risk)\b/, 'nervous'],
  [/\b(love|lovely|beautiful|gorgeous|wonderful|delightful|brilliant|fascinating|magic(al)?|amazing|incredible|i adore)\b/, 'delight'],
  [/\b(imagine|what if|can't wait|exciting|huge|enormous|wild|whoa)\b/, 'excited'],
  [/\b(i('m| am) not (so )?sure (that|about)|i doubt|i disagree|not convinced|i'd push back|not quite|i'm skeptical|that's a stretch|arguably)\b/, 'skeptical'],
  [/\b(i don't know|no idea|hard to say|who knows|not sure|beats me)\b/, 'uncertain'],
  [/^(exactly|absolutely|yes|yeah|right|totally|agreed|spot on|fair point|good point|true)\b/, 'agree'],
  [/\b(here's the thing|the key|the real (question|point|issue)|the point is|honestly|the trick is)\b/, 'confident'],
  [/\b(i wonder|i think|maybe|perhaps|it depends|in a sense|interesting|curious|hmm)\b/, 'curious'],
];

// What the other person says, read when their turn is committed (a quieter, listening reaction).
const HEARD = [
  [/\b(ha(ha)+|lol|\(laugh|funny|hilarious)\b/, 'laughs softly'],
  [/\b(you're (wrong|out of date|not)|that's not right|not (very )?(insightful|interesting)|come on|stop (it|with)|smart ?ass)\b/, 'embarrassed'],
  [/\b(challenge you|disagree|push back|but what about|devil's advocate)\b/, 'curious'],
  [/\b(thank(s| you)|love (it|that)|great|brilliant|spot on|exactly|nice|well done|good (answer|point))\b/, 'happy'],
  [/\b(sad|died|lost|hard time|struggling|tired|stressed|worried)\b/, 'sympathetic'],
  [/\b(guess what|you won't believe|big news|amazing|wow)\b/, 'excited'],
];

const read = (rules, text) => {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const [re, mood] of rules) if (re.test(s)) return mood;
  return null;
};
export const feelingSpoken = text => read(SPOKEN, text);
export const feelingHeard = text => read(HEARD, text);
