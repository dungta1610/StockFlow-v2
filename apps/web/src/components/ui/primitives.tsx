import { type ComponentProps, forwardRef } from 'react';
import { cn } from '@/lib/utils';

// shadcn-style primitives: styling only, no business logic.

type ButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive';
type ButtonSize = 'default' | 'sm' | 'icon';

const buttonVariants: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border bg-background hover:bg-muted',
  ghost: 'hover:bg-muted',
  destructive: 'bg-destructive text-white hover:bg-destructive/90',
};
const buttonSizes: Record<ButtonSize, string> = {
  default: 'h-9 px-4',
  sm: 'h-8 px-3 text-xs',
  icon: 'size-9',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }
>(({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
      buttonVariants[variant],
      buttonSizes[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';

const fieldClass =
  'h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldClass, className)} {...props} />
));
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn(fieldClass, 'pr-8', className)} {...props} />
));
Select.displayName = 'Select';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium', className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-background shadow-xs', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 border-b px-4 py-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-sm font-semibold', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}

type BadgeTone = 'neutral' | 'blue' | 'green' | 'amber' | 'red';
const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

export function Badge({ className, tone = 'neutral', ...props }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', badgeTones[tone], className)}
      {...props}
    />
  );
}

/** Tables scroll inside their own box, never the page. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      className={cn('border-b px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground', className)}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('border-b px-3 py-2 align-middle', className)} {...props} />;
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
