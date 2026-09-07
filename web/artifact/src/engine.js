// The prompt engine. In the artifact there is no server: the published page
// asks Claude directly through the `sample` capability, on the viewer's own
// account, and streams the JavaScript back as it is written.

// One brief, shared with the local server build, which reads the same file as
// its system prompt. esbuild inlines it at build time.
import brief from '../../prompts/system.md';

export const BRIEF = brief;

const HISTORY_TURNS = 4;
const HISTORY_CODE_CHARS = 3000;

// `sample` takes at most 64 KiB of input, and the brief is most of a turn's
// weight already — so history is capped rather than trusted to stay small.
export function buildInput({ prompt, scene, history }) {
  const turns = [{ role: 'user', content: BRIEF }];

  for (const turn of history.slice(-HISTORY_TURNS)) {
    turns.push({ role: 'user', content: turn.prompt });
    const code = turn.code || '';
    turns.push({
      role: 'assistant',
      content:
        code.length > HISTORY_CODE_CHARS
          ? `${code.slice(0, HISTORY_CODE_CHARS)}\n// ... (truncated)`
          : code || '// (no code)',
    });
  }

  turns.push({ role: 'user', content: `${prompt}\n\n${scene}`.trim() });
  return turns;
}

// The model is told to emit raw JS, but one stray fence would turn the whole
// build into a syntax error.
export function stripFences(text) {
  let out = String(text).trim();
  const open = out.match(/^```[a-zA-Z]*\s*\n/);
  if (open) {
    out = out.slice(open[0].length);
    const close = out.lastIndexOf('```');
    if (close !== -1) out = out.slice(0, close);
  }
  return out.trim();
}

// There is no reasoning stream here — so the narration comes out of the code
// itself. Every world.log('...') Claude writes is surfaced the moment it is
// written, which is a truer account of the build than a summary would be.
export function makeLogScanner(emit) {
  const pattern = /world\.log\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;
  let consumed = 0;
  return (text) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index < consumed) continue;
      consumed = match.index + match[0].length;
      const line = match[2].replace(/\\(['"`\\])/g, '$1').trim();
      if (line) emit(line);
    }
  };
}

const MESSAGES = {
  not_granted: 'sampling declined — reload the page to be asked again',
  sampling_disabled: 'sampling is turned off for this artifact',
  not_declared: 'this page cannot reach Claude',
  capability_disabled: 'sampling is unavailable right now',
  capability_removed: 'sampling was withdrawn mid-build',
  session_expired: 'session expired — reload the page',
  rate_limited: 'too many builds too fast — wait a moment',
  prompt_too_large: 'the scene has outgrown the prompt — try "start over"',
  refused: 'Claude declined this one — try a different prompt',
  empty_completion: 'Claude returned nothing — try rephrasing',
  upstream_error: 'the model call failed — try again',
  queue_overflow: 'too many builds queued — wait a moment',
  cancelled: 'stopped',
};

export const describe = (error) =>
  MESSAGES[error?.code] || error?.message || 'the build failed';

// True when nothing the viewer does will make sampling work in this view.
export const isTerminal = (code) =>
  ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'session_expired'].includes(code);
