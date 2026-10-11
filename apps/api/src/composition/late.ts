/**
 * A dependency that exists once the Nest container has built the module that owns it. Adapters in
 * this directory are constructed at module registration time (before the container exists), so they
 * hold a `Late<T>` that `MoneyBridgeModule` fills at bootstrap. Reading an unbound one is a wiring
 * bug and throws, never returns a default.
 */
export class Late<T> {
  private value: T | undefined;

  constructor(private readonly name: string) {}

  bind(value: T): void {
    this.value = value;
  }

  get(): T {
    if (this.value === undefined) throw new Error(`composition: ${this.name} is not bound yet`);
    return this.value;
  }
}
