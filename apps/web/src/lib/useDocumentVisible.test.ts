import { act, renderHook } from '@testing-library/react';
import { useDocumentVisible } from './useDocumentVisible';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useDocumentVisible', () => {
  afterEach(() => setVisibility('visible'));

  it('starts visible when the document is visible', () => {
    setVisibility('visible');
    const { result } = renderHook(() => useDocumentVisible());
    expect(result.current).toBe(true);
  });

  it('flips to false when the tab is hidden, and back to true when it is shown again', () => {
    setVisibility('visible');
    const { result } = renderHook(() => useDocumentVisible());

    act(() => setVisibility('hidden'));
    expect(result.current).toBe(false);

    act(() => setVisibility('visible'));
    expect(result.current).toBe(true);
  });
});
