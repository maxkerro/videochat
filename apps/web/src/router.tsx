import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RequireAuth } from './features/auth/RequireAuth';
import { ChatPane } from './features/chat/ChatPane';
import { ProfilePage } from './features/profile/ProfilePage';
import { AppShell } from './layout/AppShell';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { LoginLinkPage } from './pages/auth/LoginLinkPage';
import { LoginPage } from './pages/auth/LoginPage';
import { ResetPasswordPage } from './pages/auth/ResetPasswordPage';
import { SignUpPage } from './pages/auth/SignUpPage';
import { VerifyEmailPage } from './pages/auth/VerifyEmailPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'c/:conversationId', element: <ChatPane /> },
    ],
  },
  {
    // CHAT-037: profile and every other setting on one page.
    path: '/settings',
    element: (
      <RequireAuth>
        <ProfilePage />
      </RequireAuth>
    ),
  },
  { path: '/profile', element: <Navigate to="/settings" replace /> },
  {
    // CHAT-077: moderators only (the API enforces it); loaded on demand. Not "/moderation": that
    // prefix is the API's (render.yaml rewrites /moderation/* to it).
    path: '/moderate',
    lazy: async () => {
      const { ModerationPage } = await import('./features/moderation/ModerationPage');
      return {
        Component: () => (
          <RequireAuth>
            <ModerationPage />
          </RequireAuth>
        ),
      };
    },
  },
  { path: '/signup', element: <SignUpPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  // CHAT-081: the emailed sign-in link.
  { path: '/login-link', element: <LoginLinkPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/ui',
    // Dev-facing page: loaded on demand so it never ships in the main bundle.
    lazy: async () => ({ Component: (await import('./pages/UiGalleryPage')).UiGalleryPage }),
  },
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
