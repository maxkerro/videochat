import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Input.module.css';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  label: string;
  /** Visually hide the label but keep it for screen readers (e.g. search boxes). */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: string;
  leading?: ReactNode;
}

export function Input({
  label,
  hideLabel,
  hint,
  error,
  leading,
  className,
  id,
  ...rest
}: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={inputId} className={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      <div className={cx(styles.control, error && styles.invalid)}>
        {leading && (
          <span className={styles.leading} aria-hidden="true">
            {leading}
          </span>
        )}
        <input
          id={inputId}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
          {...rest}
        />
      </div>
      {hint && !error && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
