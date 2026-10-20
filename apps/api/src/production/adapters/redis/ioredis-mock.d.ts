/** Minimal declaration for the test-only ioredis-mock package (no @types install). */
declare module "ioredis-mock" {
  export default class RedisMock {
    constructor(options?: Record<string, unknown>);
    defineCommand(name: string, def: { numberOfKeys: number; lua: string }): void;
    flushall(): Promise<unknown>;
    keys(pattern: string): Promise<string[]>;
  }
}
