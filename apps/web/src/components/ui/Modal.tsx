import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import styles from './Overlay.module.css';

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Accessible dialog: focus trap, Escape to close, focus returns to the trigger (Radix). */
export function Modal({ open, onOpenChange, title, description, children, footer }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <header className={styles.dialogHeader}>
            <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </Dialog.Close>
          </header>
          {description && (
            <Dialog.Description className={styles.dialogDescription}>
              {description}
            </Dialog.Description>
          )}
          {children && <div className={styles.dialogBody}>{children}</div>}
          {footer && <footer className={styles.dialogFooter}>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
