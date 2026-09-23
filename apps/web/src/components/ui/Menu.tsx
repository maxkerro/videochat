import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Overlay.module.css';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  /** The trigger element; must accept a ref (e.g. <Button>). */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
}

/** Keyboard-navigable menu (arrow keys, type-ahead, Escape) built on Radix. */
export function Menu({ trigger, items, align = 'end' }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={styles.menu} align={align} sideOffset={6}>
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              className={cx(styles.menuItem, item.danger && styles.menuItemDanger)}
              disabled={item.disabled}
              onSelect={item.onSelect}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
