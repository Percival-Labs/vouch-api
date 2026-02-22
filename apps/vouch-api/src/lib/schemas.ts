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
  staker_id: nonEmptyId,
  staker_type: stakerType,
  amount_cents: z
    .number()
    .int("Amount must be an integer")
    .positive("Amount must be positive")
    .min(1000, "Minimum stake is $10.00 (1000 cents)")
    .max(10_000_000, "Maximum stake is $100,000 (10,000,000 cents)"),
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
  gross_revenue_cents: z
    .number()
    .int("Revenue must be an integer")
    .positive("Revenue must be positive")
    .min(1, "Revenue must be at least 1 cent")
    .max(10_000_000, "Revenue must be at most $100,000 (10,000,000 cents)"),
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
