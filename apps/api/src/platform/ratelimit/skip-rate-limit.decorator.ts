import { SetMetadata } from '@nestjs/common';

export const SKIP_RATE_LIMIT = 'skipRateLimit';

/** Excludes a route from the global limiter (StockFlow exempted /health). */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
