import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Marks a route as reachable without authentication. Every other route requires a
 * valid access token (the authentication guard lives in the identity module and
 * reads this key). Kept in platform/ so infrastructure routes like /health can use it.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
