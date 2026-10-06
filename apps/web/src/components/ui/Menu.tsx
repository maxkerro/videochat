import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Overlay.module.css';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Runs once the menu has closed, instead of focus returning to the trigger -- for an action
   *  that moves focus elsewhere (e.g. "Reply" focuses the composer). */
  afterClose?: () => void;
}

export interface MenuProps {
  /** The trigger element; must accept a ref (e.g. <Button>). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
}

/** Keyboard-navigable menu (arrow keys, type-ahead, Escape) built on Radix. */
export function Menu({ trigger, items, align = 'end' }: MenuProps) {
  const pendingAfterClose = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.menu}
          align={align}
          sideOffset={6}
          onCloseAutoFocus={(event) => {
            const afterClose = pendingAfterClose.current;
            pendingAfterClose.current = null;
            if (!afterClose) return;
            event.preventDefault();
            afterClose();
          }}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              className={cx(styles.menuItem, item.danger && styles.menuItemDanger)}
              disabled={item.disabled}
              onSelect={() => {
                pendingAfterClose.current = item.afterClose ?? null;
                item.onSelect();
              }}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
