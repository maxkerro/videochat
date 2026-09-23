import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Avatar, Button, Input, initials } from './index';

describe('Button', () => {
  it('is keyboard-activatable and defaults to type="button"', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Send</Button>);
    const btn = screen.getByRole('button', { name: 'Send' });
    expect(btn).toHaveAttribute('type', 'button');
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled and busy while loading', () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
});

describe('Input', () => {
  it('links its label and announces errors', () => {
    render(<Input label="Username" error="Use at least 3 characters." />);
    const input = screen.getByLabelText('Username');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use at least 3 characters.');
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 3 characters.');
  });
});

describe('Avatar', () => {
  it.each([
    ['Anna Schmidt', 'AS'],
    ['ben', 'B'],
    ['  Clara   Maria Novak ', 'CN'],
  ])('initials(%s) = %s', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });

  it('exposes the name and presence to assistive tech', () => {
    render(<Avatar name="Ben Okafor" online />);
    expect(screen.getByRole('img', { name: 'Ben Okafor, online' })).toBeInTheDocument();
  });
});
