import { render, screen } from '@testing-library/react';
import { linkify } from './linkify.js';

function renderLinkify(text: string) {
  return render(<>{linkify(text)}</>);
}

describe('linkify', () => {
  it('leaves plain text with no URL untouched', () => {
    renderLinkify('just a normal message');
    expect(screen.getByText('just a normal message')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('turns a bare http(s) URL into a safe new-tab link', () => {
    renderLinkify('see https://example.com/docs for details');
    const link = screen.getByRole('link', { name: 'https://example.com/docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('excludes trailing sentence punctuation from the link', () => {
    const { container } = renderLinkify('check this out: https://example.com/docs.');
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeInTheDocument();
    // The period renders as plain text right after the link, not swallowed into the href.
    expect(container.textContent).toBe('check this out: https://example.com/docs.');
  });

  it('excludes a trailing closing paren from the link, keeping it as text', () => {
    const { container } = renderLinkify('(see https://example.com/docs)');
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeInTheDocument();
    expect(container.textContent).toBe('(see https://example.com/docs)');
  });

  it('does not linkify a non-http(s) scheme such as javascript:, leaving it as plain text', () => {
    renderLinkify('click javascript:alert(1) if you dare');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeInTheDocument();
  });

  it('linkifies multiple URLs in the same message', () => {
    renderLinkify('https://a.example and https://b.example');
    expect(screen.getByRole('link', { name: 'https://a.example' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://b.example' })).toBeInTheDocument();
  });
});
