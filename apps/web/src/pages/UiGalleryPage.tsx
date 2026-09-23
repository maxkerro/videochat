import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar, Button, Input, Menu, Modal, Skeleton, useToast } from '../components/ui';
import { ThemeMenu } from '../features/system/ThemeMenu';
import styles from './pages.module.css';

const TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-surface-sunken',
  '--color-text',
  '--color-text-muted',
  '--color-border',
  '--color-accent',
  '--color-accent-soft',
  '--color-bubble-own',
  '--color-danger',
  '--color-success',
  '--color-warning',
];

/**
 * Living documentation for the design system (CHAT-006 acceptance criterion).
 * Every base component in both themes, with realistic states. Route: /ui
 */
export function UiGalleryPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  return (
    <div className={styles.gallery}>
      <header className={styles.galleryHeader}>
        <div>
          <h1>UI kit</h1>
          <p>
            Base components and tokens. Switch the theme to check both.{' '}
            <Link to="/">Back to app</Link>
          </p>
        </div>
        <ThemeMenu />
      </header>

      <section className={styles.section}>
        <h2>Color tokens</h2>
        <div className={styles.swatches}>
          {TOKENS.map((t) => (
            <div key={t} className={styles.swatch}>
              <span style={{ background: `var(${t})` }} />
              <span>{t.replace('--color-', '')}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2>Button</h2>
        <p>
          Variants: primary, secondary, ghost, danger. Sizes: sm, md, icon. Loading disables the
          button.
        </p>
        <div className={styles.row}>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Button size="sm">Small</Button>
          <Button disabled>Disabled</Button>
          <Button
            loading={loading}
            onClick={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 1500);
            }}
          >
            {loading ? 'Saving…' : 'Click to load'}
          </Button>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Input</h2>
        <div className={styles.grid}>
          <Input
            label="Display name"
            defaultValue="Anna Schmidt"
            hint="Shown to people you chat with."
          />
          <Input label="Username" defaultValue="An" error="Use at least 3 characters." />
          <Input label="Email" type="email" placeholder="you@example.com" />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Avatar</h2>
        <p>Initials and color are derived from the name; the dot shows presence.</p>
        <div className={styles.row}>
          <Avatar name="Anna Schmidt" size="sm" />
          <Avatar name="Ben Okafor" online />
          <Avatar name="Clara Novak" size="lg" />
          <Avatar name="Project Relay" />
        </div>
      </section>

      <section className={styles.section}>
        <h2>Modal, menu and toast</h2>
        <div className={styles.row}>
          <Button variant="secondary" onClick={() => setModalOpen(true)}>
            Open modal
          </Button>
          <Menu
            align="start"
            trigger={<Button variant="secondary">Open menu</Button>}
            items={[
              { label: 'Reply', onSelect: () => toast({ title: 'Reply selected' }) },
              { label: 'Copy text', onSelect: () => toast({ title: 'Copied', tone: 'success' }) },
              { label: 'Edit (disabled)', onSelect: () => undefined, disabled: true },
              {
                label: 'Delete',
                onSelect: () => toast({ title: 'Deleted', tone: 'danger' }),
                danger: true,
              },
            ]}
          />
          <Button
            variant="secondary"
            onClick={() =>
              toast({ title: 'Message sent', description: 'Delivered to Ben.', tone: 'success' })
            }
          >
            Show toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                title: 'Couldn’t send',
                description: 'Check your connection and try again.',
                tone: 'danger',
              })
            }
          >
            Show error toast
          </Button>
        </div>
      </section>

      <section className={styles.section} aria-busy="true">
        <h2>Skeleton</h2>
        {[0, 1].map((i) => (
          <div key={i} className={styles.skeletonRow}>
            <Skeleton circle width={40} height={40} />
            <div className={styles.skeletonLines}>
              <Skeleton width="40%" />
              <Skeleton width="75%" />
            </div>
          </div>
        ))}
      </section>

      <Modal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title="Leave “Project Relay”?"
        description="You’ll stop receiving messages from this group. You can be added back by an admin."
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => setModalOpen(false)}>
              Leave group
            </Button>
          </>
        }
      />
    </div>
  );
}
