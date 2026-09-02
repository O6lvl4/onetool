import { describe, expect, it } from "vitest";
import { Policy } from "../src/index.js";

const ref = (name: string, namespace = "petstore") => ({ namespace, name });

describe("Policy", () => {
  it("guided mode allows reads and confirms writes", () => {
    const p = new Policy();
    expect(p.decide(ref("listPets"), "read").verdict).toBe("allow");
    expect(p.decide(ref("createPet"), "write").verdict).toBe("confirm");
    expect(p.decide(ref("getSecret"), "sensitive").verdict).toBe("confirm");
  });

  it("strict mode denies anything not explicitly allowed", () => {
    const p = new Policy({ mode: "strict", allow: ["petstore:list*"] });
    expect(p.decide(ref("listPets"), "read").verdict).toBe("allow");
    expect(p.decide(ref("getPet"), "read").verdict).toBe("deny");
  });

  it("applies deny > allow > confirm and ignores case, hyphens and underscores", () => {
    const p = new Policy({ allow: ["*:*"], deny: ["pet-store:delete_*"], confirm: ["petstore:createPet"] });
    expect(p.decide(ref("deletePet"), "write").verdict).toBe("deny");
    expect(p.decide(ref("createPet"), "write").verdict).toBe("allow");
    expect(p.decide(ref("LIST_PETS"), "write").verdict).toBe("allow");
    const q = new Policy({ confirm: ["*:create*"], deny: ["other:*"] });
    expect(q.decide(ref("createPet"), "read").verdict).toBe("confirm");
    expect(q.decide(ref("listPets", "other"), "read").verdict).toBe("deny");
  });

  it("marks sensitive patterns", () => {
    const p = new Policy({ sensitive: ["vault:get*"] });
    expect(p.isSensitive(ref("getSecret", "vault"))).toBe(true);
    expect(p.isSensitive(ref("listSecrets", "vault"))).toBe(false);
  });
});
