const KEY = 'relay.muted.v1';

/**
 * Message sounds, carried over from the original project.
 *
 * Deliberately forgiving: browsers reject playback before a user gesture, the
 * files may 404, and some environments have no audio at all. None of that should
 * ever surface as an error in a chat app, so every path fails silently.
 */

let muted = read();
const cache = new Map();

function read() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // Preference simply won't survive a reload.
  }
}

function play(file, volume) {
  if (muted) return;

  try {
    let audio = cache.get(file);
    if (!audio) {
      audio = new Audio(file);
      audio.preload = 'auto';
      cache.set(file, audio);
    }

    audio.volume = volume;
    audio.currentTime = 0;
    // Rejects until the user has interacted with the page. Expected, not an error.
    audio.play?.().catch(() => {});
  } catch {
    // No audio available.
  }
}

// Quieter than incoming: you already know you sent it.
export const playSend = () => play('/outgoing.mp3', 0.25);
export const playReceive = () => play('/incoming.mp3', 0.4);
