import { useEffect } from 'react';
import type { CallController } from './CallProvider';

/** Elements where typing an "m" or "v" is just typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** CHAT-042 AC: M toggles mute and V the camera, whenever a call is connecting or live --
 *  except while the person is typing (e.g. in the chat composer next to a minimised call). */
export function useCallShortcuts(
  calls: Pick<CallController, 'call' | 'toggleAudio' | 'toggleVideo'>,
) {
  const live =
    calls.call !== null &&
    (calls.call.phase === 'connecting' ||
      calls.call.phase === 'active' ||
      calls.call.phase === 'reconnecting' ||
      calls.call.phase === 'outgoing');
  const { toggleAudio, toggleVideo } = calls;
  useEffect(() => {
    if (!live) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'm') {
        event.preventDefault();
        toggleAudio();
      } else if (key === 'v') {
        event.preventDefault();
        void toggleVideo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, toggleAudio, toggleVideo]);
}
