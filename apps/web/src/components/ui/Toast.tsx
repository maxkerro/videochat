import * as RadixToast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Overlay.module.css';

export type ToastTone = 'neutral' | 'success' | 'danger';

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  toast: (t: { title: string; description?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

/** Toasts are announced to screen readers and dismiss after 5 s (paused on hover/focus). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastApi['toast']>(({ title, description, tone = 'neutral' }) => {
    setItems((prev) => [...prev.slice(-2), { id: nextId++, title, description, tone }]);
  }, []);
  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            className={cx(styles.toast, styles[`toast_${t.tone}`])}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((x) => x.id !== t.id));
            }}
          >
            <RadixToast.Title className={styles.toastTitle}>{t.title}</RadixToast.Title>
            {t.description && (
              <RadixToast.Description className={styles.toastDescription}>
                {t.description}
              </RadixToast.Description>
            )}
            <RadixToast.Close className={styles.close} aria-label="Dismiss">
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </RadixToast.Close>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className={styles.toastViewport} />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
