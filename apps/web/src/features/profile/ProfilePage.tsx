import { useQuery } from '@tanstack/react-query';
import { LIMITS, displayNameSchema, usernameSchema } from '@videochat/shared';
import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Avatar, Button, Input, useToast } from '../../components/ui';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import styles from './ProfilePage.module.css';
import { checkUsernameAvailable, updateProfile, uploadAvatar } from './profileApi';

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

const ACCEPTED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function ProfilePage() {
  const auth = useAuth();
  const { user, setUser } = auth;
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Debounced username-availability check -- skipped entirely when it's unchanged from the
  // signed-in user's current username, since that's always "available" to them.
  const debouncedUsername = useDebouncedValue(username, 400);
  const usernameUnchanged = debouncedUsername === user?.username;
  const usernameValidShape = usernameSchema.safeParse(debouncedUsername).success;
  const shouldCheckAvailability = Boolean(user) && !usernameUnchanged && usernameValidShape;
  const { data: usernameIsAvailable, isFetching: checkingAvailability } = useQuery({
    queryKey: ['username-availability', debouncedUsername],
    queryFn: () => checkUsernameAvailable(debouncedUsername),
    enabled: shouldCheckAvailability,
    staleTime: 10_000,
  });
  const availability: Availability = usernameUnchanged
    ? 'idle'
    : !usernameValidShape
      ? 'invalid'
      : checkingAvailability
        ? 'checking'
        : usernameIsAvailable
          ? 'available'
          : 'taken';

  if (!user) return null;

  const displayNameChanged = displayName !== user.displayName;
  const usernameChanged = username !== user.username;
  const canSave =
    (displayNameChanged || usernameChanged) &&
    displayNameSchema.safeParse(displayName).success &&
    (usernameChanged ? username === debouncedUsername && availability === 'available' : true);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setFormError(null);
    setSaving(true);
    try {
      const input: { displayName?: string; username?: string } = {};
      if (displayNameChanged) input.displayName = displayName;
      if (usernameChanged) input.username = username;
      const updated = await withAuthRetry(auth, (token) => updateProfile(token, input));
      setUser(updated);
      toast({ title: 'Profile updated', tone: 'success' });
    } catch {
      setFormError('Could not save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      toast({ title: 'Unsupported file type', description: 'Use a JPEG, PNG or WebP image.' });
      return;
    }
    if (file.size > LIMITS.avatarMaxBytes) {
      toast({ title: 'Image too large', description: 'Avatars must be 5 MB or smaller.' });
      return;
    }
    setUploading(true);
    try {
      const updated = await withAuthRetry(auth, (token) => uploadAvatar(token, file));
      setUser(updated);
      toast({ title: 'Avatar updated', tone: 'success' });
    } catch {
      toast({ title: 'Could not upload avatar', tone: 'danger' });
    } finally {
      setUploading(false);
    }
  }

  const availabilityLabel: Record<Availability, string | null> = {
    idle: null,
    checking: 'Checking availability…',
    available: 'Username available',
    taken: 'Username already taken',
    invalid: 'Lowercase letters, digits and underscores only',
  };
  const availabilityClass: Record<Availability, string | undefined> = {
    idle: undefined,
    checking: styles.checking,
    available: styles.available,
    taken: styles.unavailable,
    invalid: styles.unavailable,
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/">← Back</Link>
        <h1>Your profile</h1>
      </header>

      <div className={styles.avatarRow}>
        <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
        <div className={styles.avatarMeta}>
          <Button
            variant="secondary"
            size="sm"
            loading={uploading}
            onClick={() => fileInput.current?.click()}
          >
            Change avatar
          </Button>
          <p>JPEG, PNG or WebP, up to 5 MB.</p>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_AVATAR_TYPES.join(',')}
            className="visually-hidden"
            onChange={handleAvatarChange}
          />
        </div>
      </div>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <Input
          label="Email"
          value={user.email}
          disabled
          hint="Contact support to change your email."
        />
        <Input
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={
            displayNameChanged && !displayNameSchema.safeParse(displayName).success
              ? 'Required'
              : undefined
          }
        />
        <Input
          label="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          hint={
            availabilityLabel[availability] && (
              <span className={availabilityClass[availability]}>
                {availabilityLabel[availability]}
              </span>
            )
          }
        />
        {formError && (
          <p role="alert" className={styles.unavailable}>
            {formError}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" disabled={!canSave} loading={saving}>
            Save changes
          </Button>
        </div>
      </form>
    </div>
  );
}
