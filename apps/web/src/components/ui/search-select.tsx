import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from './primitives';

export interface SearchSelectOption {
  id: string;
  label: string;
}

export interface SearchSelectProps {
  id?: string;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** The chosen option's id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  /** Shown when the field is not focused and nothing has been typed. */
  selectedLabel?: string;
  /** The text currently typed; the parent owns it so it can debounce a server query. */
  query: string;
  onQueryChange: (query: string) => void;
  options: SearchSelectOption[];
  loading?: boolean;
  /**
   * When set, shown as a permanent first row that clears the selection back to `''`
   * (e.g. "All products", "Default (all buyers)"). Omit for fields where a choice is
   * required, so there is nothing to clear back to.
   */
  emptyOption?: string;
}

/**
 * The flattened list a SearchSelect renders and navigates: the clear row (if any)
 * always first, so there is always a way back to `''` regardless of what the current
 * search narrowed `options` down to. Pulled out as a pure function so the fix for
 * "SearchSelect cannot clear a selection" is testable without mounting the component
 * (see test/search-select.spec.ts).
 */
export function buildSearchSelectItems(options: SearchSelectOption[], emptyOption?: string): SearchSelectOption[] {
  return emptyOption !== undefined ? [{ id: '', label: emptyOption }, ...options] : options;
}

/**
 * A type-as-you-search picker: the parent supplies already-filtered `options` (from a
 * server query or a local filter — this component has no fetch logic of its own, so
 * it stays a styling-only primitive). Replaces a plain `<select>` for reference lists
 * too long to load unpaged (see the phase-09 review's dropdown-cap finding).
 */
export function SearchSelect({
  id,
  ariaLabel,
  placeholder,
  disabled,
  value,
  onChange,
  selectedLabel,
  query,
  onQueryChange,
  options,
  loading,
  emptyOption,
}: SearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // The clear row, when present, is item 0 — keyboard nav and picking treat it like
  // any other option, so there is no special-cased index math.
  const items = buildSearchSelectItems(options, emptyOption);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Keeps the highlighted row valid as the option list changes size (e.g. a search
  // narrows the results while a later index was highlighted).
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(items.length - 1, 0)));
  }, [items.length]);

  const pick = (option: SearchSelectOption) => {
    onChange(option.id);
    onQueryChange('');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        autoComplete="off"
        placeholder={
          open
            ? (placeholder ?? 'Type to search…')
            : value
              ? selectedLabel
              : (emptyOption ?? placeholder ?? 'Type to search…')
        }
        disabled={disabled}
        value={open ? query : (selectedLabel ?? '')}
        onFocus={() => setOpen(true)}
        // A pick keeps the input focused (its mousedown preventDefault below stops
        // the browser's default blur-on-click-elsewhere), so a second click to
        // reopen is not itself a focus transition and onFocus would not fire again.
        onClick={() => setOpen(true)}
        onBlur={() => {
          // Deferred so a click/mousedown on a row (which calls preventDefault, but
          // still fires blur first in some browsers) can still register as a pick.
          setTimeout(() => setOpen(false), 100);
        }}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const option = items[highlight];
            if (option) pick(option);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          role="listbox"
          id={id ? `${id}-listbox` : undefined}
          className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-background text-sm shadow-md"
        >
          {emptyOption !== undefined && (
            <li
              key=""
              role="option"
              aria-selected={value === ''}
              className={cn('cursor-pointer px-3 py-1.5 text-muted-foreground', highlight === 0 && 'bg-muted')}
              onMouseEnter={() => setHighlight(0)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick({ id: '', label: emptyOption });
              }}
            >
              {emptyOption}
            </li>
          )}
          {loading ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">No matches</li>
          ) : (
            options.map((option, i) => {
              const itemIndex = emptyOption !== undefined ? i + 1 : i;
              return (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={option.id === value}
                  className={cn('cursor-pointer px-3 py-1.5', itemIndex === highlight && 'bg-muted')}
                  onMouseEnter={() => setHighlight(itemIndex)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(option);
                  }}
                >
                  {option.label}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
