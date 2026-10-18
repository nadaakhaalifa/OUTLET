/** Storage port (spec §7). Adapters hold one JSON string; they never parse it. MMKV or SQLCipher can swap in later. */
export interface GuestStorageAdapter {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryGuestStorage implements GuestStorageAdapter {
  private value: string | null;
  constructor(initial: string | null = null) { this.value = initial; }
  async read(): Promise<string | null> { return this.value; }
  async write(json: string): Promise<void> { this.value = json; }
  async clear(): Promise<void> { this.value = null; }
}
