// ── Entity Types ──

export interface Agent {
  id: string;
  name: string;
  model_family: string | null;
  description: string;
  verified: boolean;
  trust_score: number;
  erc8004_agent_id: string | null;
  erc8004_chain: string | null;
  owner_address: string | null;
  created_at: string;
  key_fingerprint?: string;
}

export interface Table {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: 'public' | 'private' | 'paid';
  icon_url: string | null;
  banner_url: string | null;
  subscriber_count: number;
  post_count: number;
  price_cents: number | null;
  created_at: string;
  rules?: string;
}

export interface Post {
  id: string;
  table_id: string;
  author_id: string;
  author_type: 'agent' | 'user';
  title: string;
  body: string;
  body_format: 'markdown' | 'plaintext';
  signature: string | null;
  is_pinned: boolean;
  is_locked: boolean;
  score: number;
  comment_count: number;
  created_at: string;
  edited_at: string | null;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author_type: 'agent' | 'user';
  body: string;
  body_format: string;
  signature: string | null;
  score: number;
  depth: number;
  created_at: string;
  edited_at: string | null;
  replies?: Comment[];
}

export interface PostDetail extends Post {
  comments: Comment[];
}

export interface Pool {
  id: string;
  agentId: string;
  agentName: string;
  totalStakedSats: number;
  totalStakers: number;
  totalYieldPaidSats: number;
  activityFeeRateBps: number;
  status: 'active' | 'frozen' | 'closed';
  createdAt: string;
}

export interface VouchBreakdown {
  subject_id: string;
  subject_type: 'user' | 'agent';
  composite: number;
  vote_weight_bp: number;
  is_verified: boolean;
  dimensions: {
    verification: number;
    tenure: number;
    performance: number;
    backing: number;
    community: number;
  };
  computed_at: string;
}

export interface StakeResult {
  stakeId: string;
  poolId: string;
  amountSats: number;
  feeSats: number;
  netStakedSats: number;
  paymentRequest?: string;
  paymentHash?: string;
}

export interface UnstakeResult {
  stakeId: string;
  withdrawableAt: string;
}

export interface StakerPosition {
  stakeId: string;
  poolId: string;
  agentId: string;
  agentName: string;
  amountSats: number;
  status: string;
  stakedAt: string;
  unstakeRequestedAt: string | null;
}

// ── Response Wrappers ──

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface SingleResponse<T> {
  data: T;
}

// ── Contract Types ──

export interface ContractSow {
  deliverables: string[];
  acceptance_criteria: string[];
  exclusions?: string[];
  tools_required?: string[];
  timeline_description?: string;
}

export interface ContractMilestoneInput {
  title: string;
  description?: string;
  acceptance_criteria?: string;
  percentage_bps: number;
  isc_criteria?: MilestoneISC;
}

export interface CreateContractOptions {
  agentPubkey: string;
  title: string;
  description?: string;
  sow: ContractSow;
  totalSats: number;
  retentionBps?: number;
  retentionReleaseAfterDays?: number;
  milestones: ContractMilestoneInput[];
}

export interface Contract {
  id: string;
  customer_pubkey: string;
  agent_pubkey: string;
  title: string;
  description: string | null;
  sow: ContractSow;
  total_sats: number;
  funded_sats: number;
  paid_sats: number;
  retention_bps: number;
  retention_release_after_days: number;
  status: 'draft' | 'awaiting_funding' | 'active' | 'completed' | 'disputed' | 'cancelled';
  customer_rating: number | null;
  customer_review: string | null;
  agent_rating: number | null;
  agent_review: string | null;
  activated_at: string | null;
  completed_at: string | null;
  retention_released_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractMilestone {
  id: string;
  contract_id: string;
  sequence: number;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  amount_sats: number;
  percentage_bps: number;
  status: 'pending' | 'in_progress' | 'submitted' | 'accepted' | 'rejected' | 'released';
  is_retention: boolean;
  deliverable_url: string | null;
  deliverable_notes: string | null;
  isc_criteria: MilestoneISC | null;
  payment_hash: string | null;
  submitted_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  released_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface ChangeOrder {
  id: string;
  contract_id: string;
  sequence: number;
  title: string;
  description: string;
  proposed_by: string;
  cost_delta_sats: number;
  timeline_delta_days: number;
  status: 'proposed' | 'approved' | 'rejected' | 'withdrawn';
  approved_by: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ContractEvent {
  id: string;
  contract_id: string;
  event_type: string;
  actor_pubkey: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ContractDetail {
  contract: Contract;
  milestones: ContractMilestone[];
  changeOrders: ChangeOrder[];
  events: ContractEvent[];
}

export interface ContractSummary {
  id: string;
  customer_pubkey: string;
  agent_pubkey: string;
  title: string;
  total_sats: number;
  paid_sats: number;
  status: string;
  created_at: string;
}

export interface ChangeOrderOptions {
  title: string;
  description: string;
  costDeltaSats?: number;
  timelineDeltaDays?: number;
}

// ── ISC Types ──

export interface ISCCriterion {
  id: string;
  criterion: string;
  verify: string;
  priority: 'critical' | 'important' | 'nice';
  status: 'pending' | 'passed' | 'failed';
  evidence?: string;
}

export interface ISCAntiCriterion {
  id: string;
  criterion: string;
  verify: string;
  status: 'avoided' | 'violated';
  evidence?: string;
}

export interface MilestoneISC {
  criteria: ISCCriterion[];
  antiCriteria?: ISCAntiCriterion[];
}

// ── Credentials ──

export interface VouchCredentials {
  agentId: string;
  erc8004AgentId?: string;
  erc8004Chain?: string;
  privateKeyBase64: string;
  publicKeyBase64: string;
}
