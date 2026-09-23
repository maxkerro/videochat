import { createRequire } from 'node:module';

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
