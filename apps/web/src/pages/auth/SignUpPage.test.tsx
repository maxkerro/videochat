import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchAlwaysReturning } from '../../test/mockFetch';
import { renderApp } from '../../test/renderApp';

afterEach(() => vi.unstubAllGlobals());

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
  await userEvent.type(screen.getByLabelText('Username'), 'ada');
  await userEvent.type(screen.getByLabelText('Display name'), 'Ada Lovelace');
  await userEvent.type(screen.getByLabelText('Password'), 'a-strong-password');
}

describe('SignUpPage', () => {
  it('shows validation errors instead of submitting when the form is invalid', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'no cookie' }, 401));
    renderApp('/signup');
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText(/at least/i)).toBeInTheDocument();
  });

  it('signs up and shows the check-your-email panel', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Account created.' }, 201));
    renderApp('/signup');
    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText('ada@example.com', { exact: false })).toBeInTheDocument();
  });

  it('shows the server error message on a duplicate account', async () => {
    vi.stubGlobal('fetch', fetchAlwaysReturning({ message: 'Email already in use' }, 409));
    renderApp('/signup');
    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    expect(await screen.findByText('Email already in use')).toBeInTheDocument();
  });
});
