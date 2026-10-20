import { z } from "zod";

/**
 * The production CSP forbids 'unsafe-eval'. Zod's JIT probes `new Function`, which is reported as a CSP violation
 * even though zod falls back. Import this module FIRST in any client bundle that builds zod schemas.
 */
z.config({ jitless: true });
