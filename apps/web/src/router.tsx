import { createBrowserRouter, type RouteObject } from 'react-router';
import { RequireAuth } from './features/auth/RequireAuth';
import { ChatPane } from './features/chat/ChatPane';
import { ProfilePage } from './features/profile/ProfilePage';
import { AppShell } from './layout/AppShell';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
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
    path: '/profile',
    element: (
      <RequireAuth>
        <ProfilePage />
      </RequireAuth>
    ),
  },
  { path: '/signup', element: <SignUpPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  {
    path: '/ui',
    // Dev-facing page: loaded on demand so it never ships in the main bundle.
    lazy: async () => ({ Component: (await import('./pages/UiGalleryPage')).UiGalleryPage }),
  },
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
