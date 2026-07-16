import { StringDecoder } from 'node:string_decoder';

const UTF8_LOCALE_CANDIDATES = ['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8'] as const;

/**
 * Runs inside the requested Pod shell before replacing itself with the
 * interactive shell. All capability probes are silent so they cannot pollute
 * the terminal's first prompt.
 */
const POD_EXEC_SHELL_BOOTSTRAP = `
_sm_shell_exe=$(readlink /proc/$$/exe 2>/dev/null || :)
case "\${1-0}:$_sm_shell_exe" in
  0:*/dash)
    # dash can accept an emacs option while still being built without a line
    # editor. The final explicitly degraded attempt opts back in after every
    # preferred interactive-shell candidate has failed.
    exit 126
    ;;
esac

_sm_charmap=$(locale charmap 2>/dev/null || :)
case "$_sm_charmap" in
  UTF-8|utf-8|UTF8|utf8)
    ;;
  *)
    _sm_utf8_locale=
    for _sm_locale in ${UTF8_LOCALE_CANDIDATES.join(' ')}; do
      _sm_candidate_charmap=$(
        (
          unset LC_ALL
          LC_CTYPE=$_sm_locale
          export LC_CTYPE
          locale charmap
        ) 2>/dev/null
      ) || _sm_candidate_charmap=
      case "$_sm_candidate_charmap" in
        UTF-8|utf-8|UTF8|utf8)
          _sm_utf8_locale=$_sm_locale
          break
          ;;
      esac
    done
    if [ -n "$_sm_utf8_locale" ]; then
      unset LC_ALL
      LC_CTYPE=$_sm_utf8_locale
      export LC_CTYPE
    fi
    ;;
esac

case "\${TERM-}" in
  ''|dumb)
    if command -v infocmp >/dev/null 2>&1 && infocmp xterm-256color >/dev/null 2>&1; then
      TERM=xterm-256color
    elif command -v tput >/dev/null 2>&1 && TERM=xterm-256color tput colors >/dev/null 2>&1; then
      TERM=xterm-256color
    else
      TERM=xterm
    fi
    export TERM
    ;;
esac

stty iutf8 >/dev/null 2>&1 || :
exec "$0" -i
`.trim();

/**
 * Builds a shell-only Kubernetes Exec command without interpolating the shell
 * name into script text. The fourth argv entry becomes `$0` for `-c`, so even
 * an unusual but valid shell path remains data rather than executable script.
 * The fifth entry becomes `$1` and explicitly controls the final degraded dash
 * attempt without interpolating that control into the script either.
 */
export const buildPodExecCommand = (shell: string, allowDegradedDash = false): string[] => [
  shell,
  '-c',
  POD_EXEC_SHELL_BOOTSTRAP,
  shell,
  allowDegradedDash ? '1' : '0',
];

export interface Utf8ChunkDecoder {
  write(chunk: Uint8Array): string;
  end(chunk?: Uint8Array): string;
}

const asBuffer = (chunk: Uint8Array): Buffer =>
  Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

/**
 * Incrementally decodes one terminal byte stream. stdout and stderr must own
 * separate instances because either stream can end between UTF-8 code units.
 */
export const createUtf8ChunkDecoder = (): Utf8ChunkDecoder => {
  const decoder = new StringDecoder('utf8');
  let ended = false;

  return {
    write: (chunk) => {
      if (ended) {
        return '';
      }
      return decoder.write(asBuffer(chunk));
    },
    end: (chunk) => {
      if (ended) {
        return '';
      }
      ended = true;
      return chunk === undefined
        ? decoder.end()
        : decoder.end(asBuffer(chunk));
    },
  };
};
