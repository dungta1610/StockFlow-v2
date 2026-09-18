import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppLayout } from './app-layout';
import { LoginPage } from './features/auth/login-page';
import { ensureSession } from './features/auth/session';
import { NewOrderPage } from './features/orders/new-order-page';
import { OrderDetailPage } from './features/orders/order-detail-page';
import { OrdersListPage, validateOrdersSearch } from './features/orders/orders-list-page';

// Code-based routes: a handful of screens do not need the file-route generator.

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } => ({
    // Only same-app paths, so the login page cannot be used as an open redirect.
    redirect: typeof raw.redirect === 'string' && raw.redirect.startsWith('/') && !raw.redirect.startsWith('//')
      ? raw.redirect
      : undefined,
  }),
  beforeLoad: async () => {
    if (await ensureSession()) throw redirect({ to: '/orders' });
  },
  component: LoginPage,
});

/** Everything below requires a session; a reload restores it from the refresh cookie. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ location }) => {
    if (!(await ensureSession())) throw redirect({ to: '/login', search: { redirect: location.href } });
  },
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/orders' });
  },
});

const ordersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders',
  validateSearch: validateOrdersSearch,
  component: OrdersListPage,
});

const newOrderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders/new',
  component: NewOrderPage,
});

const orderRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/orders/$orderId',
  component: OrderDetailPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([indexRoute, ordersRoute, newOrderRoute, orderRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
