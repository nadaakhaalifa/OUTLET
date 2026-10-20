import { describeFamilyStoreContract, describeStudentStoreContract, type FamilyFixture } from "./store-contract";
import { InMemoryFamilyStore, InMemoryStudentStore } from "./in-memory";

const open = async (): Promise<FamilyFixture> => {
  const family = new InMemoryFamilyStore();
  const students = new InMemoryStudentStore();
  return {
    family,
    students,
    seedOwner: async (n) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    ensureUser: async () => undefined,
    eventTypes: async () => [...family.events, ...students.events].map((e) => e.type),
  };
};

describeFamilyStoreContract("in-memory", open);
describeStudentStoreContract("in-memory", open);
