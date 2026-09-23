import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAlwaysReturning } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

afterEach(() => vi.unstubAllGlobals());

describe('ForgotPasswordPage', () => {
  it('validates the email before submitting', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/forgot-password');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
  });

  it('shows a generic confirmation regardless of whether the account exists', async () => {
    vi.stubGlobal(
      'fetch',
      fetchAlwaysReturning({ message: 'If that email has an account, a reset link was sent.' }),
    );
    renderApp('/forgot-password');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com', { exact: false })).toBeInTheDocument();
  });
});
