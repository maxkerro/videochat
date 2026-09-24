import { createRequire } from 'node:module';
import { redactUrl } from './logging.module.js';

describe('redactUrl', () => {
  it('leaves a URL with no query string alone', () => {
    expect(redactUrl('/conversations')).toBe('/conversations');
  });

  it('redacts a token query param, e.g. the realtime gateway upgrade request', () => {
    expect(redactUrl('/realtime?token=super-secret-access-token')).toBe(
      '/realtime?token=%5Bredacted%5D',
    );
  });

  it('keeps other query params while redacting token', () => {
    expect(redactUrl('/search?q=hello&token=secret')).toBe('/search?q=hello&token=%5Bredacted%5D');
  });
});

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return { ...actual, createRequire: vi.fn(actual.createRequire) };
});

const mockedCreateRequire = vi.mocked(createRequire);

describe('hasPrettyPrinter', () => {
  afterEach(() => {
    vi.resetModules();
    mockedCreateRequire.mockReset();
  });

  it('is true when pino-pretty resolves (dev dependency installed)', async () => {
    mockedCreateRequire.mockReturnValue({
      resolve: vi.fn().mockReturnValue('/path/to/pino-pretty'),
    } as never);
    const { hasPrettyPrinter } = await import('./logging.module.js');
    expect(hasPrettyPrinter()).toBe(true);
  });

  it('is false when pino-pretty cannot be resolved (e.g. a production image)', async () => {
    mockedCreateRequire.mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Cannot find module 'pino-pretty'");
      }),
    } as never);
    const { hasPrettyPrinter } = await import('./logging.module.js');
    expect(hasPrettyPrinter()).toBe(false);
  });
});
