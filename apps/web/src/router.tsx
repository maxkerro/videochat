import { createBrowserRouter, type RouteObject } from 'react-router';
import { ChatPane } from './features/chat/ChatPane';
import { AppShell } from './layout/AppShell';
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
    path: '/ui',
    // Dev-facing page: loaded on demand so it never ships in the main bundle.
    lazy: async () => ({ Component: (await import('./pages/UiGalleryPage')).UiGalleryPage }),
  },
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
