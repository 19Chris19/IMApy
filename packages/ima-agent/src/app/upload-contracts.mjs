import { z } from 'zod';
const id = z.string().min(1).max(512).refine(v => v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v));
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const uploadPlanSchema = z.object({ requestKey: key, knowledgeBaseId: id, folderId: id.nullable().optional(),
  files: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict();
const selector = { batchId: z.string().regex(/^u_[a-f0-9]{64}$/).optional(), requestKey: key.optional() };
export const uploadSelectorSchema = z.object(selector).strict().refine(v => Boolean(v.batchId) !== Boolean(v.requestKey));
export const uploadReadSchema = z.object({ ...selector, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
  .refine(v => Boolean(v.batchId) !== Boolean(v.requestKey));
