import { InMemorySettingsRepository } from "./in-memory";
import { describeSettingsRepository } from "../test/repository-contract";

describeSettingsRepository("in-memory", async () => new InMemorySettingsRepository());
