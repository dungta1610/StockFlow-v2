import { z } from 'zod';
import { defineTool, toolFactory, type ToolFactory } from '../../config/types';

/** Only digits, arithmetic operators, parentheses, dot and space are allowed. */
const SAFE_EXPRESSION = /^[\d+\-*/(). ]+$/;

/**
 * Arithmetic, and the smallest possible proof that a tool is just a factory: it
 * ignores the run context entirely, which a tool reaching real data cannot.
 */
export const calculatorTool: ToolFactory = toolFactory('calculator', () =>
  defineTool({
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression using +, -, *, /, and parentheses.',
    schema: z.object({ expression: z.string().describe('e.g. "2 * (3 + 4)"') }),
    handler: async ({ expression }) => {
      const expr = expression.trim();
      // Whitelist guard: anything that is not plain arithmetic is rejected before
      // Function() sees it, so no identifier or call can ever be injected.
      if (!SAFE_EXPRESSION.test(expr)) return 'Error: only digits and + - * / ( ) . are allowed.';
      try {
        return String(Function(`"use strict"; return (${expr});`)() as unknown);
      } catch {
        return 'Error: could not evaluate expression.';
      }
    },
  }));
