import { StellarTransactionBuilder } from "./transaction-builder.js";
import { StellarSimulator } from "./simulator.js";
import { StellarSubmitter } from "./submitter.js";
import type { Signer } from "./signer.js";
import { PolicyEngine } from "@4evergent/policy";
import { IntentValidator } from "@4evergent/agent-core";
import { StellarAdapter } from "@4evergent/agent-core";
import type { AgentIntent, AccountSettingsIntent, PolicyDecision, PolicyRules, ActivityRecord } from "@4evergent/shared";
import {
  createActivity,
  createApproval,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";

export interface PipelineOptions {
  horizonUrl: string;
  networkPassphrase: string;
  signer: Signer;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  policyRules?: Partial<PolicyRules>;
  approvalTtlSeconds?: number;
  /** Shared policy resolver. When provided, pipeline resolves per-agent rules at execution time. */
  policyResolver?: (agentId: string) => Promise<PolicyRules>;
}

export interface PipelineExecuteInput {
  intent: AgentIntent;
  sourceAccount: any;
  idempotencyKey?: string | null;
  /** Pre-existing activity ID to update instead of creating a new ActivityRecord. */
  activityId?: string;
  signal?: AbortSignal;
  onBeforeSubmit?: () => void | Promise<void>;
}

export class TransactionPipeline {
  private builder: StellarTransactionBuilder;
  private simulator: StellarSimulator;
  private submitter: StellarSubmitter;
  private signer: Signer;
  private policy: PolicyEngine;
  private activityStore?: ActivityStore;
  private approvalStore?: ApprovalStore;
  private approvalTtlSeconds: number;
  private horizonUrl: string;
  private policyResolver?: (agentId: string) => Promise<PolicyRules>;

  constructor(options: PipelineOptions) {
    this.builder = new StellarTransactionBuilder();
    this.simulator = new StellarSimulator(options.horizonUrl);
    this.submitter = new StellarSubmitter(options.horizonUrl);
    this.signer = options.signer;
    this.horizonUrl = options.horizonUrl;
    this.activityStore = options.activityStore;
    this.approvalStore = options.approvalStore;
    this.approvalTtlSeconds = options.approvalTtlSeconds ?? 86400;
    this.policyResolver = options.policyResolver;
    // PolicyEngine uses getRules callback for per-agent resolution; falls back to defaultRules
    this.policy = new PolicyEngine(options.policyRules, options.activityStore as any, options.policyResolver);
  }

  async execute(input: PipelineExecuteInput): Promise<PipelineOutcome> {
    const { intent, sourceAccount, idempotencyKey, activityId, signal } = input;

    const checkAbort = () => {
      if (signal?.aborted) {
        const err = new Error("Execution was cancelled");
        err.name = "AbortError";
        throw err;
      }
    };
    checkAbort();

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return {
        status: "rejected",
        message: `Intent validation failed: ${validation.error}`,
        policyDecision: { result: "deny", reason: "invalid intent", rule: "intent_validation", intent },
        simulationResult: null,
      };
    }

    const agentId = (sourceAccount as any)?.agentId ?? (sourceAccount as any)?.accountId?.() ?? "unknown";
    const ownerId = (sourceAccount as any)?.ownerId ?? "unknown";
    // Resolve policy at execution time — uses policyResolver if provided
    const decision = await this.policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "rejected";
      activity.authorizationStatus = "denied_by_policy";
      activity.error = decision.reason;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Policy denied: ${decision.reason}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: activity.id,
      };
    }

    if (decision.result === "requires_approval") {
      if (this.activityStore && this.approvalStore) {
        const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
        activity.status = "requires_approval";
        activity.authorizationStatus = "pending_approval";
        const expiresAt = new Date(Date.now() + this.approvalTtlSeconds * 1000).toISOString();
        const approval = createApproval(activity.id, agentId, ownerId, intent, decision, expiresAt);
        await this.persistActivity(activity, idempotencyKey, activityId);
        await this.approvalStore.record(approval);
        return {
          status: "requires_approval",
          message: decision.reason,
          policyDecision: decision,
          simulationResult: null,
          activityId: activity.id,
          approvalId: approval.id,
        };
      }
      return {
        status: "requires_approval",
        message: decision.reason,
        policyDecision: decision,
        simulationResult: null,
      };
    }

    checkAbort();

    let tx;
    try {
      if (intent.type === "trustline") {
        tx = await this.builder.buildTrustline(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      } else if (intent.type === "account_settings") {
        tx = await this.builder.buildAccountSettings(sourceAccount, intent as AccountSettingsIntent, this.signer.getNetworkPassphrase());
      } else {
        tx = await this.builder.buildPayment(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      }
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "rejected";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Transaction construction failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: activity.id,
      };
    }

    checkAbort();

    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.authorizationStatus = "denied_by_simulation";
      activity.error = simResult.error ?? "Simulation failed";
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    checkAbort();

    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    checkAbort();
    await input.onBeforeSubmit?.();
    checkAbort();

    // PERSIST txHash BEFORE submit to survive crash window.
    // If process crashes after submit but before we return, the txHash is already
    // in the activity record so reconciliation can detect it.
    const preSubmitHash = signedTx.hash().toString("hex");

    try {
      const result = await this.submitter.submit(signedTx, this.signer.getNetworkPassphrase());
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "submitted";
      activity.authorizationStatus = "approved";
      activity.txHash = result.hash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: result.hash,
        activityId: activity.id,
        submittedHash: result.hash,
      };
    } catch (e: any) {
      if (signal?.aborted || e?.name === "AbortError") {
        throw e;
      }
      // Submit failed — record pre-submit hash + error for recovery/reconciliation
      const activity = this.resolveActivity(activityId, agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      activity.txHash = preSubmitHash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey, activityId);
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: preSubmitHash,
        activityId: activity.id,
      };
    }
  }

  /**
   * executeApproved — re-evaluates CURRENT policy before execution.
   *
   * SECURITY: Approval does NOT bypass policy. The intent is re-evaluated against
   * the agent's CURRENT policy at execution time. If policy was tightened between
   * approval and execution, the execution is denied.
   */
  async executeApproved(approvalId: string, approver?: string): Promise<PipelineOutcome> {
    if (!this.approvalStore || !this.activityStore) {
      return {
        status: "rejected",
        message: "Pipeline not configured with approval store",
        policyDecision: { result: "deny", reason: "misconfigured", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    const approval = await this.approvalStore.get(approvalId);
    if (!approval) {
      return {
        status: "rejected",
        message: `Approval ${approvalId} not found`,
        policyDecision: { result: "deny", reason: "not found", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.status === "submitted" || approval.status === "confirmed") {
      return {
        status: "rejected",
        message: `Approval already executed with transaction ${approval.txHash ?? "unknown"}`,
        policyDecision: { result: "deny", reason: "already executed", rule: "approval", intent: approval.intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    if (approval.status !== "approved") {
      return {
        status: "rejected",
        message: `Approval is ${approval.status}, not approved`,
        policyDecision: { result: "deny", reason: approval.status, rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await this.approvalStore.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      return {
        status: "rejected",
        message: "Approval has expired",
        policyDecision: { result: "deny", reason: "expired", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    // CRITICAL: Re-evaluate CURRENT policy at execution time.
    // Approval does NOT grant a bypass — if policy was tightened since approval,
    // the intent must be denied.
    // skipReservation: daily spending was already reserved at intent-creation time.
    // Re-evaluating here must NOT double-reserve.
    const currentDecision = await this.policy.evaluate(approval.intent, approval.agentId, { skipReservation: true });
    if (currentDecision.result === "deny") {
      await this.approvalStore.update(approvalId, { status: "failed", error: `Policy re-evaluation denied: ${currentDecision.reason}` });
      return {
        status: "rejected",
        message: `Policy re-evaluation denied: ${currentDecision.reason}`,
        policyDecision: currentDecision,
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    await this.approvalStore.update(approvalId, { status: "executing" });

    const intent = approval.intent;
    const adapter = new StellarAdapter(this.horizonUrl);

    let sourceAccount;
    try {
      sourceAccount = await adapter.getAccount(approval.agentId);
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: `Account load failed: ${e.message}` });
      return {
        status: "rejected",
        message: `Account load failed: ${e.message}`,
        policyDecision: currentDecision,
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    const outcome = await this.execute({
      intent,
      sourceAccount,
      activityId: approval.activityId,
    });

    if (outcome.status === "submitted") {
      await this.approvalStore.update(approvalId, { status: "submitted", txHash: outcome.txHash });
    } else {
      await this.approvalStore.update(approvalId, { status: "failed", error: outcome.message });
    }

    return outcome;
  }

  private resolveActivity(
    activityId: string | undefined,
    agentId: string,
    ownerId: string,
    intent: AgentIntent,
    decision: PolicyDecision,
    idempotencyKey?: string | null
  ): ActivityRecord {
    if (activityId) {
      return {
        id: activityId,
        agentId,
        ownerId,
        intent,
        policyDecision: decision,
        status: "pending",
        authorizationStatus: "pending",
        createdAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey ?? null,
      } as ActivityRecord;
    }
    return createActivity(agentId, ownerId, intent, decision, idempotencyKey);
  }

  private async persistActivity(activity: ActivityRecord, idempotencyKey?: string | null, existingId?: string): Promise<void> {
    if (!this.activityStore) return;
    if (existingId) {
      await this.activityStore.update(existingId, activity);
    } else {
      await this.activityStore.record(activity);
    }
  }
}

export interface PipelineOutcome {
  status: "submitted" | "rejected" | "requires_approval" | "simulation_failed";
  message: string;
  policyDecision: PolicyDecision;
  simulationResult: any;
  txHash?: string;
  activityId?: string;
  approvalId?: string;
  submittedHash?: string;
}