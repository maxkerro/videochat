import { Link, useNavigate } from 'react-router';
import { Avatar, Menu } from '../../components/ui';
import { useAuth } from './AuthContext';
import styles from './AccountMenu.module.css';

/** Sidebar-footer account control (CHAT-010/011): a login link when signed out, or the user's
 *  avatar with a profile/logout menu when signed in. */
export function AccountMenu() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();

  if (status === 'loading') return null;

  if (status === 'anonymous') {
    return (
      <Link to="/login" className={styles.loginLink}>
        Log in
      </Link>
    );
  }

  return (
    <Menu
      align="start"
      trigger={
        <button
          type="button"
          className={styles.trigger}
          aria-label={`Account: ${user!.displayName}`}
        >
          <Avatar name={user!.displayName} src={user!.avatarUrl} size="sm" />
        </button>
      }
      items={[
        { label: 'Profile', onSelect: () => void navigate('/profile') },
        {
          label: 'Log out',
          danger: true,
          onSelect: () => {
            void logout().then(() => navigate('/login'));
          },
        },
      ]}
    />
  );
}
