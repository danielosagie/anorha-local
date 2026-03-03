import type {
  WorkflowOperation,
  WorkflowStageName,
  ViewportProfile,
} from "../types.js";

export interface WorkflowPack {
  key: string;
  domains: string[];
  stagePlan: WorkflowStageName[];
  requiredFields: Record<WorkflowOperation, string[]>;
  allowedFields: Record<WorkflowOperation, string[]>;
  startUrl: string;
}

const BASE_STAGE_PLAN: WorkflowStageName[] = [
  "navigate",
  "fill_data",
  "confirm",
  "complete",
  "verify",
];

const FACEBOOK_MARKETPLACE_PRODUCT_PACK: WorkflowPack = {
  key: "facebook.marketplace.product",
  domains: ["facebook.com", "m.facebook.com"],
  stagePlan: BASE_STAGE_PLAN,
  startUrl: "https://www.facebook.com/marketplace",
  requiredFields: {
    create: ["title", "price", "condition", "description", "location"],
    read: ["externalItemId"],
    update: ["externalItemId"],
    delete: ["externalItemId"],
  },
  allowedFields: {
    create: [
      "title",
      "price",
      "condition",
      "description",
      "location",
      "category",
      "photos",
      "quantity",
      "availability",
      "brand",
      "model",
    ],
    read: ["externalItemId", "url"],
    update: [
      "externalItemId",
      "title",
      "price",
      "condition",
      "description",
      "location",
      "category",
      "photos",
      "quantity",
      "availability",
      "brand",
      "model",
      "status",
    ],
    delete: ["externalItemId", "url", "reason"],
  },
};

const PACKS: Record<string, WorkflowPack> = {
  [FACEBOOK_MARKETPLACE_PRODUCT_PACK.key]: FACEBOOK_MARKETPLACE_PRODUCT_PACK,
};

export function getWorkflowPack(key: string): WorkflowPack | null {
  return PACKS[(key || "").trim()] || null;
}

export function resolveViewportSize(profile: ViewportProfile): { width: number; height: number } {
  switch (profile) {
    case "mobile":
      return { width: 390, height: 844 };
    case "tablet":
      return { width: 768, height: 1024 };
    default:
      return { width: 1440, height: 900 };
  }
}

