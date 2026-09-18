import { describe, expect, it } from 'vitest';
import { buildSearchSelectItems } from '../src/components/ui/search-select';

// A prior version of SearchSelect had no way to clear a selection back to '' once
// something was picked (the wave 2-4 inventory/new-price-list pickers regressed
// their "All products"/"Default (all buyers)" choice). The fix is that a clear row
// is always item 0 of the rendered list, so Enter (which defaults to highlight 0)
// or a click on it always reaches onChange('') — this is the pure logic behind that.

describe('buildSearchSelectItems — the clear/"All"/"Default" row', () => {
  it('is just the options when there is nothing to clear back to', () => {
    const options = [{ id: 'a', label: 'A' }];
    expect(buildSearchSelectItems(options)).toEqual(options);
  });

  it('puts a clearing row with id "" first when emptyOption is set', () => {
    const options = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const items = buildSearchSelectItems(options, 'All products');
    expect(items[0]).toEqual({ id: '', label: 'All products' });
    expect(items.slice(1)).toEqual(options);
  });

  it('the clear row survives even when a search narrows every real option away', () => {
    const items = buildSearchSelectItems([], 'All products');
    expect(items).toEqual([{ id: '', label: 'All products' }]);
  });

  it('an empty label is still a valid clear row (falsy strings are not "no emptyOption")', () => {
    const items = buildSearchSelectItems([{ id: 'a', label: 'A' }], '');
    expect(items[0]).toEqual({ id: '', label: '' });
  });
});
