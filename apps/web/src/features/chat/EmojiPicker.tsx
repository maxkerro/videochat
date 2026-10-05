import { QUICK_REACTIONS } from '@videochat/shared';
import { Modal } from '../../components/ui';
import styles from './ChatPane.module.css';

/** A compact set to pick from beyond the quick reactions (no search needed at this size). */
export const PICKER_EMOJI: ReadonlyArray<readonly [string, string]> = [
  ['👍', 'thumbs up'],
  ['👎', 'thumbs down'],
  ['❤️', 'red heart'],
  ['🔥', 'fire'],
  ['😂', 'tears of joy'],
  ['🤣', 'rolling on the floor laughing'],
  ['😊', 'smiling'],
  ['😍', 'heart eyes'],
  ['🥰', 'smiling with hearts'],
  ['😘', 'blowing a kiss'],
  ['😎', 'sunglasses'],
  ['🤔', 'thinking'],
  ['🤨', 'raised eyebrow'],
  ['😐', 'neutral'],
  ['🙄', 'eye roll'],
  ['😮', 'surprised'],
  ['😱', 'screaming'],
  ['😢', 'crying'],
  ['😭', 'sobbing'],
  ['😡', 'angry'],
  ['🤯', 'mind blown'],
  ['🥳', 'party face'],
  ['😴', 'sleeping'],
  ['🤢', 'nauseated'],
  ['🤗', 'hug'],
  ['🫡', 'salute'],
  ['🙏', 'folded hands'],
  ['👏', 'clapping'],
  ['🙌', 'raising hands'],
  ['💪', 'flexed biceps'],
  ['👀', 'eyes'],
  ['👋', 'waving'],
  ['🤝', 'handshake'],
  ['✌️', 'victory'],
  ['👌', 'OK hand'],
  ['🤞', 'fingers crossed'],
  ['💯', 'hundred'],
  ['✅', 'check mark'],
  ['❌', 'cross mark'],
  ['⭐', 'star'],
  ['✨', 'sparkles'],
  ['🎉', 'party popper'],
  ['🎂', 'birthday cake'],
  ['🍕', 'pizza'],
  ['☕', 'coffee'],
  ['🍻', 'clinking beers'],
  ['🚀', 'rocket'],
  ['💡', 'light bulb'],
  ['📌', 'pushpin'],
  ['⏰', 'alarm clock'],
  ['💔', 'broken heart'],
  ['💙', 'blue heart'],
  ['💚', 'green heart'],
  ['💜', 'purple heart'],
  ['🌞', 'sun'],
  ['🌧️', 'rain'],
  ['❄️', 'snowflake'],
  ['🌈', 'rainbow'],
  ['🐶', 'dog'],
  ['🐱', 'cat'],
  ['🙈', 'see-no-evil monkey'],
  ['🤷', 'shrug'],
];

/** CHAT-033: the full reaction picker -- a grid of buttons, so it's fully keyboard reachable. */
export function EmojiPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
}) {
  const quick = new Set<string>(QUICK_REACTIONS);
  const rest = PICKER_EMOJI.filter(([e]) => !quick.has(e));
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add a reaction" footer={null}>
      <div className={styles.emojiGrid} role="group" aria-label="Reactions">
        {[
          ...QUICK_REACTIONS.map(
            (e) => [e, PICKER_EMOJI.find(([x]) => x === e)?.[1] ?? e] as const,
          ),
          ...rest,
        ].map(([emoji, name]) => (
          <button
            key={emoji}
            type="button"
            className={styles.emojiButton}
            aria-label={`React with ${name}`}
            title={name}
            onClick={() => {
              onPick(emoji);
              onOpenChange(false);
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </Modal>
  );
}
