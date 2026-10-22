import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { meKey } from '../api/session';
import { mockApi, renderWithProviders } from '../test/utils';
import { LocaleSync } from './LocaleSync';
import { currentLocale } from '.';

describe('LocaleSync', () => {
  it('после входа — язык пользователя, после выхода — язык гостя', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ja']);
    mockApi([{ path: '/api/auth/me', body: { id: 'u', login: 'u', role: 'user', locale: 'fr' } }]);
    const { queryClient } = renderWithProviders(<LocaleSync />);
    await waitFor(() => expect(currentLocale()).toBe('fr'));
    act(() => queryClient.setQueryData(meKey, null));
    await waitFor(() => expect(currentLocale()).toBe('ru'));
  });
});
