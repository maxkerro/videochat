import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  circle?: boolean;
  className?: string;
}

/** Placeholder shimmer while content loads. Hidden from assistive tech; pair with aria-busy. */
export function Skeleton({ width = '100%', height = 12, circle, className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(styles.skeleton, circle && styles.circle, className)}
      style={{ width, height }}
    />
  );
}
