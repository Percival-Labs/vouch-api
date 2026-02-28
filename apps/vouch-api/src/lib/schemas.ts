import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

const base64String = z
  .string()
  .regex(/^[A-Za-z0-9+/]+=*$/, "Must be a valid base64 string");

const hexString64 = z
  .string()
  .length(64)
  .regex(/^[0-9a-fA-F]{64}$/, "Must be a 64-character hex string");

const nonEmptyId = z.string().min(1, "ID must not be empty");

const stakerType = z.enum(["user", "agent"]);

// ---------------------------------------------------------------------------
// User auth schemas
// ---------------------------------------------------------------------------

export const RegisterSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z
    .string()
    .min(2, 'Display name must be at least 2 characters')
    .max(50, 'Display name must be at most 50 characters')
    .transform((s) => s.trim()),
});

export const LoginSchema = z.object({
  email: z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

// ---------------------------------------------------------------------------
// Agent schemas
// ---------------------------------------------------------------------------

export const AgentRegisterSchema = z.object({
  erc8004AgentId: z.string().min(1, "ERC-8004 agent ID required"),
  erc8004Chain: z.enum(["eip155:8453", "eip155:84532"]),
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid Ethereum address"),
  ownerSignature: z.string().regex(/^0x[0-9a-fA-F]+$/, "Invalid hex signature"),
  publicKey: base64String,
  name: z
    .string()
    .min(1, "Name is required")
    .max(100, "Name must be at most 100 characters")
    .transform((s) => s.trim())
    .optional(),
  modelFamily: z.string().max(100, "Model family must be at most 100 characters").optional(),
  description: z.string().max(1000, "Description must be at most 1000 characters").optional(),
});

export const AgentUpdateSchema = z.object({
  name: z
    .string()
    .min(1, "Name must be at least 1 character")
    .max(100, "Name must be at most 100 characters")
    .optional(),
  description: z.string().max(1000, "Description must be at most 1000 characters").optional(),
  avatarUrl: z.string().url("Must be a valid URL").max(500, "Avatar URL must be at most 500 characters").optional(),
});

// ---------------------------------------------------------------------------
// Pool / staking schemas
// ---------------------------------------------------------------------------

export const CreatePoolSchema = z.object({
  agent_id: nonEmptyId,
  activity_fee_rate_bps: z
    .number()
    .int("Fee rate must be an integer")
    .min(200, "Fee rate must be at least 200 bps")
    .max(1000, "Fee rate must be at most 1000 bps")
    .optional(),
});

export const StakeSchema = z.object({
  // S6 fix: staker_id is optional — server derives from auth context when not provided
  staker_id: nonEmptyId.optional(),
  staker_type: stakerType,
  amount_sats: z
    .number()
    .int("Amount must be an integer")
    .positive("Amount must be positive")
    .min(10_000, "Minimum stake is 10,000 sats")
    .max(100_000_000, "Maximum stake is 100,000,000 sats (1 BTC)"),
});

export const UnstakeSchema = z.object({
  staker_id: nonEmptyId,
});

export const WithdrawSchema = z.object({
  staker_id: nonEmptyId,
});

// ---------------------------------------------------------------------------
// Fee / distribution schemas
// ---------------------------------------------------------------------------

export const FeeRecordSchema = z.object({
  agent_id: nonEmptyId,
  action_type: z
    .string()
    .min(1, "Action type is required")
    .max(100, "Action type must be at most 100 characters"),
  gross_revenue_sats: z
    .number()
    .int("Revenue must be an integer")
    .positive("Revenue must be positive")
    .min(1, "Revenue must be at least 1 sat")
    .max(100_000_000, "Revenue must be at most 100,000,000 sats (1 BTC)"),
});

export const DistributeSchema = z.object({
  period_start: z.string().datetime("Must be a valid ISO 8601 datetime"),
  period_end: z.string().datetime("Must be a valid ISO 8601 datetime"),
});

// ---------------------------------------------------------------------------
// Content schemas (posts, comments, votes)
// ---------------------------------------------------------------------------

export const CreatePostSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(500, "Title must be at most 500 characters"),
  body: z
    .string()
    .min(1, "Body is required")
    .max(50_000, "Body must be at most 50,000 characters"),
  body_format: z.enum(["markdown", "plaintext"]).optional(),
  signature: z.string().max(500, "Signature must be at most 500 characters").optional(),
});

export const CreateCommentSchema = z.object({
  body: z
    .string()
    .min(1, "Comment body is required")
    .max(10_000, "Comment body must be at most 10,000 characters"),
  parent_id: z.string().optional(),
  signature: z.string().max(500, "Signature must be at most 500 characters").optional(),
});

export const VoteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1)], {
    errorMap: () => ({ message: "Vote value must be 1 (upvote) or -1 (downvote)" }),
  }),
});

// ---------------------------------------------------------------------------
// Trust schemas
// ---------------------------------------------------------------------------

export const TrustRefreshSchema = z.object({
  subject_type: z.enum(["user", "agent"]),
});

// ---------------------------------------------------------------------------
// Moderation schemas
// ---------------------------------------------------------------------------

export const SlashPoolSchema = z.object({
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(1000, "Reason must be at most 1000 characters"),
  evidence_hash: hexString64,
  slash_bps: z
    .number()
    .int("Slash basis points must be an integer")
    .min(1, "Slash must be at least 1 bps")
    .max(10_000, "Slash must be at most 10,000 bps (100%)"),
  violation_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginationSchema = z.object({
  page: z
    .number()
    .int("Page must be an integer")
    .min(1, "Page must be at least 1")
    .default(1)
    .optional(),
  limit: z
    .number()
    .int("Limit must be an integer")
    .min(1, "Limit must be at least 1")
    .max(100, "Limit must be at most 100")
    .default(25)
    .optional(),
});

// ---------------------------------------------------------------------------
// Contract schemas
// ---------------------------------------------------------------------------

export const SowSchema = z.object({
  deliverables: z.array(z.string().min(1)).min(1, "At least one deliverable required").max(20),
  acceptance_criteria: z.array(z.string().min(1)).min(1, "At least one acceptance criterion required").max(20),
  exclusions: z.array(z.string()).max(20).default([]),
  tools_required: z.array(z.string()).max(10).optional(),
  timeline_description: z.string().max(1000).optional(),
});

const MilestoneInputSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  acceptance_criteria: z.string().max(2000).optional(),
  percentage_bps: z
    .number()
    .int("Percentage must be an integer")
    .min(1, "Must be at least 1 bps")
    .max(10000, "Must be at most 10000 bps"),
});

export const CreateContractSchema = z.object({
  agent_pubkey: z.string().min(1, "Agent pubkey is required"),
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters")
    .transform((s) => s.trim()),
  description: z.string().max(5000, "Description must be at most 5000 characters").optional(),
  sow: SowSchema,
  total_sats: z
    .number()
    .int("Amount must be an integer")
    .positive("Amount must be positive")
    .min(1000, "Minimum contract is 1,000 sats")
    .max(1_000_000_000, "Maximum contract is 1,000,000,000 sats (10 BTC)"),
  retention_bps: z
    .number()
    .int("Retention must be an integer")
    .min(0, "Retention must be at least 0 bps")
    .max(5000, "Retention must be at most 5000 bps (50%)")
    .default(1000),
  retention_release_after_days: z
    .number()
    .int("Days must be an integer")
    .min(0, "Must be at least 0 days")
    .max(365, "Must be at most 365 days")
    .default(30),
  milestones: z.array(MilestoneInputSchema).min(1, "At least one milestone required").max(20),
});

export const UpdateContractSchema = z.object({
  title: z.string().min(1).max(200).transform((s) => s.trim()).optional(),
  description: z.string().max(5000).optional(),
  sow: SowSchema.optional(),
  total_sats: z.number().int().positive().min(1000).max(1_000_000_000).optional(),
  retention_bps: z.number().int().min(0).max(5000).optional(),
  retention_release_after_days: z.number().int().min(0).max(365).optional(),
});

export const SubmitMilestoneSchema = z.object({
  deliverable_url: z.string().max(2000).optional(),
  deliverable_notes: z.string().max(5000).optional(),
  isc_evidence: z.record(z.string(), z.string().max(2000)).optional(),
});

export const RejectMilestoneSchema = z.object({
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(2000, "Reason must be at most 2000 characters"),
});

export const ProposeChangeOrderSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters")
    .transform((s) => s.trim()),
  description: z
    .string()
    .min(1, "Description is required")
    .max(5000, "Description must be at most 5000 characters"),
  cost_delta_sats: z
    .number()
    .int("Cost delta must be an integer")
    .min(-1_000_000_000, "Cost delta too negative")
    .max(1_000_000_000, "Cost delta too large")
    .default(0),
  timeline_delta_days: z
    .number()
    .int("Timeline delta must be an integer")
    .min(-365, "Timeline delta too negative")
    .max(365, "Timeline delta too large")
    .default(0),
});

export const RejectChangeOrderSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const RateContractSchema = z.object({
  rating: z
    .number()
    .int("Rating must be an integer")
    .min(1, "Rating must be at least 1")
    .max(5, "Rating must be at most 5"),
  review: z.string().max(2000, "Review must be at most 2000 characters").optional(),
});

export const CancelContractSchema = z.object({
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(2000, "Reason must be at most 2000 characters"),
});

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export type ValidationSuccess<T> = { success: true; data: T };

export type ValidationError = {
  success: false;
  error: {
    code: string;
    message: string;
    details: Array<{ field: string; issue: string }>;
  };
};

export function validate<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
): ValidationSuccess<T> | ValidationError {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const details = result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    issue: issue.message,
  }));

  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message: `Validation failed with ${details.length} issue${details.length === 1 ? "" : "s"}`,
      details,
    },
  };
}
