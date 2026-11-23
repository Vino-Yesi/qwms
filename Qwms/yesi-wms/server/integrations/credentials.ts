import { z } from 'zod';

/** Marketplace credential shape. Secrets are encrypted at rest, never logged. */
export const credentialsSchema = z
  .object({
    apiKey: z.string().min(8).max(512).optional(),
    clientId: z.string().min(1).max(128).optional(),
    businessId: z.string().min(1).max(64).optional(),
    campaignId: z.string().min(1).max(64).optional(),
    warehouseId: z.string().min(1).max(64).optional(),
  })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;
