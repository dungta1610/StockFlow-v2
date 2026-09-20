import { Outlet, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppLayout } from './app-layout';
import { LoginPage } from './features/auth/login-page';
import { canManageUsers, ensureSession, isOps, isOpsAdmin } from './features/auth/session';
import { getSession } from './lib/auth-store';
import { NewProductPage } from './features/catalog/new-product-page';
import { NewWarehousePage } from './features/catalog/new-warehouse-page';
import { ProductDetailPage } from './features/catalog/product-detail-page';
import { ProductsListPage, validateProductsSearch } from './features/catalog/products-list-page';
import { WarehouseDetailPage } from './features/catalog/warehouse-detail-page';
import { WarehousesListPage, validateWarehousesSearch } from './features/catalog/warehouses-list-page';
import { CopilotPage } from './features/copilot/copilot-page';
import { InventoryDetailPage } from './features/inventory/inventory-detail-page';
import { InventoryListPage, validateInventorySearch } from './features/inventory/inventory-list-page';
import { NewOrderPage } from './features/orders/new-order-page';
import { OrderDetailPage } from './features/orders/order-detail-page';
import { OrdersListPage, validateOrdersSearch } from './features/orders/orders-list-page';
import { ReservationsListPage, validateReservationsSearch } from './features/orders/reservations-list-page';
import { NewOrganizationPage } from './features/orgs/new-organization-page';
import { OrganizationDetailPage } from './features/orgs/organization-detail-page';
import { OrganizationsListPage, validateOrganizationsSearch } from './features/orgs/organizations-list-page';
import { NewPriceListPage } from './features/pricing/new-price-list-page';
import { PriceListDetailPage } from './features/pricing/price-list-detail-page';
import { PriceListsListPage, validatePriceListsSearch } from './features/pricing/price-lists-list-page';
import { NewUserPage } from './features/users/new-user-page';
import { UserDetailPage } from './features/users/user-detail-page';
import { UsersListPage, validateUsersSearch } from './features/users/users-list-page';

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

const reservationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/reservations',
  validateSearch: validateReservationsSearch,
  // Ops only. A pasted URL for a buyer bounces to their own orders instead of
  // flashing a screen the API would 403 every request on.
  beforeLoad: () => {
    const session = getSession();
    if (session && !isOps(session)) throw redirect({ to: '/orders' });
  },
  component: ReservationsListPage,
});

const copilotRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/copilot',
  // Ops only, same as /reservations: a buyer pasting the URL lands on their own
  // orders instead of a screen every request would 403.
  beforeLoad: () => {
    const session = getSession();
    if (session && !isOps(session)) throw redirect({ to: '/orders' });
  },
  component: CopilotPage,
});

const inventoryRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/inventory',
  validateSearch: validateInventorySearch,
  component: InventoryListPage,
});

const inventoryDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/inventory/$inventoryId',
  component: InventoryDetailPage,
});

const productsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/products',
  validateSearch: validateProductsSearch,
  component: ProductsListPage,
});

const newProductRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/products/new',
  beforeLoad: () => {
    const session = getSession();
    if (session && !isOpsAdmin(session)) throw redirect({ to: '/catalog/products' });
  },
  component: NewProductPage,
});

const productDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/products/$productId',
  component: ProductDetailPage,
});

const warehousesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/warehouses',
  validateSearch: validateWarehousesSearch,
  component: WarehousesListPage,
});

const newWarehouseRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/warehouses/new',
  beforeLoad: () => {
    const session = getSession();
    if (session && !isOpsAdmin(session)) throw redirect({ to: '/catalog/warehouses' });
  },
  component: NewWarehousePage,
});

const warehouseDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/catalog/warehouses/$warehouseId',
  component: WarehouseDetailPage,
});

const priceListsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/price-lists',
  validateSearch: validatePriceListsSearch,
  component: PriceListsListPage,
});

const newPriceListRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/price-lists/new',
  beforeLoad: () => {
    const session = getSession();
    // Unlike /catalog/products and /organizations, GET /price-lists is itself
    // ops-only — bouncing a buyer to /price-lists would just trade one 403 for
    // another, so send them to a screen they can actually see instead.
    if (session && !isOpsAdmin(session)) throw redirect({ to: isOps(session) ? '/price-lists' : '/orders' });
  },
  component: NewPriceListPage,
});

const priceListDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/price-lists/$priceListId',
  component: PriceListDetailPage,
});

const organizationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/organizations',
  validateSearch: validateOrganizationsSearch,
  component: OrganizationsListPage,
});

const newOrganizationRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/organizations/new',
  beforeLoad: () => {
    const session = getSession();
    if (session && !isOpsAdmin(session)) throw redirect({ to: '/organizations' });
  },
  component: NewOrganizationPage,
});

const organizationDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/organizations/$orgId',
  component: OrganizationDetailPage,
});

const usersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/users',
  validateSearch: validateUsersSearch,
  component: UsersListPage,
});

const newUserRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/users/new',
  beforeLoad: () => {
    const session = getSession();
    if (session && !canManageUsers(session)) throw redirect({ to: '/users' });
  },
  component: NewUserPage,
});

const userDetailRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/users/$userId',
  component: UserDetailPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    indexRoute,
    ordersRoute,
    newOrderRoute,
    orderRoute,
    reservationsRoute,
    copilotRoute,
    inventoryRoute,
    inventoryDetailRoute,
    productsRoute,
    newProductRoute,
    productDetailRoute,
    warehousesRoute,
    newWarehouseRoute,
    warehouseDetailRoute,
    priceListsRoute,
    newPriceListRoute,
    priceListDetailRoute,
    organizationsRoute,
    newOrganizationRoute,
    organizationDetailRoute,
    usersRoute,
    newUserRoute,
    userDetailRoute,
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
