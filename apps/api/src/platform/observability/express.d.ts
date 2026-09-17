declare global {
  namespace Express {
    interface Request {
      /** Set by RequestLoggingMiddleware. */
      id?: string;
    }
  }
}

export {};
