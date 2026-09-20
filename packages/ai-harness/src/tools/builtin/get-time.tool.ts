import { z } from 'zod';
import { defineTool, toolFactory, type ToolFactory } from '../../config/types';

/** The current time. Zero dependencies — the template for a new builtin tool. */
export const getTimeTool: ToolFactory = toolFactory('get_current_time', () =>
  defineTool({
    name: 'get_current_time',
    description: 'Get the current date and time. Optionally in a specific IANA timezone.',
    schema: z.object({
      timezone: z.string().optional().describe('IANA timezone, e.g. "Asia/Ho_Chi_Minh". Omit for UTC.'),
    }),
    handler: async ({ timezone }) => {
      const now = new Date();
      if (!timezone) return now.toISOString();
      try {
        return now.toLocaleString('en-US', { timeZone: timezone });
      } catch {
        return `Invalid timezone "${timezone}". Current UTC: ${now.toISOString()}`;
      }
    },
  }));
