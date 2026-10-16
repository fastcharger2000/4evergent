import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentIntent, TrustlineIntent, AccountSettingsIntent } from "@4evergent/shared";

export interface AssetIdentifier {
  code: string;
  issuer: string | null;
}

/**
 * Options accepted by `buildSetOptions`. Every field is optional;
 * omitting a field leaves the existing account setting unchanged.
 */
export interface SetOptionsParams {
  /** Add/update/remove a signer. Weight 0 removes the signer. */
  signer?: {
    ed25519PublicKey: string;
    weight: number;
  };
  /** Flags to set (auth required, revocable, clawback). */
  setFlags?: number;
  /** Flags to clear. */
  clearFlags?: number;
  /** Master key weight (0-255). */
  masterWeight?: number;
  /** Low threshold (0-255). */
  lowThreshold?: number;
  /** Medium threshold (0-255). */
  medThreshold?: number;
  /** High threshold (0-255). */
  highThreshold?: number;
  /** Home domain (up to 32 characters). */
  homeDomain?: string;
  /** Inflation destination (deprecated on Stellar but still supported). */
  inflationDest?: string;
}

function parseAssetInput(input: { asset?: string; assetDetails?: { code: string; issuer: string | null } }): AssetIdentifier {
  if (input.assetDetails) {
    return { code: input.assetDetails.code, issuer: input.assetDetails.issuer };
  }
  if (input.asset === "XLM") return { code: "XLM", issuer: null };
  return { code: input.asset ?? "XLM", issuer: null };
}

function toStellarAsset(id: AssetIdentifier): Asset {
  if (id.code === "XLM" || !id.issuer) return Asset.native();
  return new Asset(id.code, id.issuer);
}

export class StellarTransactionBuilder {
  async buildPayment(
    sourceAccount: Account,
    intent: PaymentIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "payment") {
      throw new Error(`StellarTransactionBuilder: expected payment intent, got ${intent.type}`);
    }

    const amount = intent.amount.trim();
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      throw new Error("StellarTransactionBuilder: amount must be a positive number");
    }

    const destination = intent.destination.trim();
    if (!destination || !destination.startsWith("G")) {
      throw new Error("StellarTransactionBuilder: destination must be a valid Stellar account");
    }

    const assetId = parseAssetInput(intent);
    if (assetId.code !== "XLM" && !assetId.issuer) {
      throw new Error("StellarTransactionBuilder: non-XLM asset requires issuer");
    }
    const stellarAsset = toStellarAsset(assetId);

    const paymentOp = Operation.payment({
      destination,
      asset: stellarAsset,
      amount,
    });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(paymentOp);
    builder.setTimeout(30);

    return builder.build();
  }

  async buildTrustline(
    sourceAccount: Account,
    intent: TrustlineIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "trustline") {
      throw new Error(`StellarTransactionBuilder: expected trustline intent, got ${intent.type}`);
    }

    if (!intent.assetCode || intent.assetCode.length < 1) {
      throw new Error("StellarTransactionBuilder: assetCode required");
    }
    if (intent.assetCode === "XLM") {
      throw new Error("StellarTransactionBuilder: XLM is native and cannot be used as a trustline");
    }
    if (!intent.issuer || !intent.issuer.startsWith("G")) {
      throw new Error("StellarTransactionBuilder: issuer must be a valid Stellar account");
    }

    const asset = new Asset(intent.assetCode, intent.issuer);
    const limit = intent.limit && parseFloat(intent.limit) >= 0 ? intent.limit : undefined;

    const changeTrustOp = limit !== undefined
      ? Operation.changeTrust({ asset, limit })
      : Operation.changeTrust({ asset });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(changeTrustOp);
    builder.setTimeout(30);

    return builder.build();
  }

  /**
   * Build a transaction containing a single `setOptions` operation.
   *
   * This is the low-level primitive for account-settings changes:
   * signer management, thresholds, flags, and home domain. Every field in
   * `setOptions` is optional; omitting a field leaves the existing setting
   * unchanged.
   *
   * An empty options object is rejected with an error — a noop
   * `setOptions` operation would burn a fee and consume a sequence number
   * without changing anything, which is almost certainly a caller bug.
   */
  async buildSetOptions(
    sourceAccount: Account,
    options: SetOptionsParams,
    networkPassphrase: string,
    memo?: string
  ): Promise<Transaction> {
    const normalized = this.normalizeSetOptions(options);

    const setOptionsOp = Operation.setOptions(normalized as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    if (memo !== undefined) {
      builder.addMemo(Memo.text(truncateToMemo(memo)));
    }
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  /**
   * Validate and normalize the caller's `setOptions` params into the shape
   * `Operation.setOptions` expects. Throws on invalid input and on an
   * empty options object.
   */
  private normalizeSetOptions(options: SetOptionsParams) {
    if (options === null || typeof options !== "object") {
      throw new Error("StellarTransactionBuilder: options object required");
    }

    const normalized: Record<string, unknown> = {};

    if (options.signer !== undefined) {
      const signer = options.signer;
      if (typeof signer !== "object" || signer === null) {
        throw new Error("StellarTransactionBuilder: signer must be { ed25519PublicKey, weight }");
      }
      if (typeof signer.ed25519PublicKey !== "string" || !signer.ed25519PublicKey.startsWith("G") || signer.ed25519PublicKey.length !== 56) {
        throw new Error("StellarTransactionBuilder: signer.ed25519PublicKey must be a valid Stellar address (G...)");
      }
      if (typeof signer.weight !== "number" || signer.weight < 0 || signer.weight > 255) {
        throw new Error("StellarTransactionBuilder: signer.weight must be a number between 0 and 255");
      }
      normalized.signer = {
        ed25519PublicKey: signer.ed25519PublicKey,
        weight: signer.weight,
      };
    }

    if (options.setFlags !== undefined) {
      normalized.setFlags = assertUint8(options.setFlags, "setFlags");
    }
    if (options.clearFlags !== undefined) {
      normalized.clearFlags = assertUint8(options.clearFlags, "clearFlags");
    }
    if (options.masterWeight !== undefined) {
      normalized.masterWeight = assertUint8(options.masterWeight, "masterWeight");
    }
    if (options.lowThreshold !== undefined) {
      normalized.lowThreshold = assertUint8(options.lowThreshold, "lowThreshold");
    }
    if (options.medThreshold !== undefined) {
      normalized.medThreshold = assertUint8(options.medThreshold, "medThreshold");
    }
    if (options.highThreshold !== undefined) {
      normalized.highThreshold = assertUint8(options.highThreshold, "highThreshold");
    }
    if (options.homeDomain !== undefined) {
      if (typeof options.homeDomain !== "string" || options.homeDomain.length === 0) {
        throw new Error("StellarTransactionBuilder: homeDomain must be a non-empty string");
      }
      if (options.homeDomain.length > 32) {
        throw new Error("StellarTransactionBuilder: homeDomain must be at most 32 characters");
      }
      normalized.homeDomain = options.homeDomain;
    }
    if (options.inflationDest !== undefined) {
      if (typeof options.inflationDest !== "string" || !options.inflationDest.startsWith("G") || options.inflationDest.length !== 56) {
        throw new Error("StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)");
      }
      normalized.inflationDest = options.inflationDest;
    }

    if (Object.keys(normalized).length === 0) {
      throw new Error("StellarTransactionBuilder: setOptions requires at least one option");
    }

    return normalized;
  }

  async buildAccountSettings(
    sourceAccount: Account,
    intent: AccountSettingsIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "account_settings") {
      throw new Error(`StellarTransactionBuilder: expected account_settings intent, got ${intent.type}`);
    }
    if (!intent.setting || intent.setting.trim().length === 0) {
      throw new Error("StellarTransactionBuilder: setting field required");
    }

    const options = this.resolveAccountSettingsOptions(intent);
    return this.buildSetOptions(sourceAccount, options, networkPassphrase, intent.reason);
  }

  private resolveAccountSettingsOptions(intent: AccountSettingsIntent): SetOptionsParams {
    const setting = intent.setting.trim().toLowerCase();
    const value = intent.value;

    switch (setting) {
      case "home_domain": {
        if (typeof value !== "string" || value.length === 0) {
          throw new Error("StellarTransactionBuilder: home_domain value must be a non-empty string");
        }
        return { homeDomain: value };
      }
      case "inflation_destination": {
        if (typeof value !== "string" || !value.startsWith("G") || value.length !== 56) {
          throw new Error("StellarTransactionBuilder: inflation_destination must be a valid Stellar address (G...)");
        }
        return { inflationDest: value };
      }
      case "signer": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: signer value must be { key, weight }");
        }
        const v = value as { key?: unknown; weight?: unknown };
        if (typeof v.key !== "string" || !v.key.startsWith("G") || v.key.length !== 56) {
          throw new Error("StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)");
        }
        if (typeof v.weight !== "number" || v.weight < 0 || v.weight > 255) {
          throw new Error("StellarTransactionBuilder: signer.weight must be a number between 0 and 255");
        }
        return { signer: { ed25519PublicKey: v.key, weight: v.weight } };
      }
      case "thresholds": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: thresholds value must be { low, medium, high, master }");
        }
        const v = value as { low?: unknown; medium?: unknown; high?: unknown; master?: unknown };
        for (const k of ["low", "medium", "high", "master"] as const) {
          if (typeof v[k] !== "number" || v[k] < 0 || v[k] > 255) {
            throw new Error(`StellarTransactionBuilder: thresholds.${k} must be a number between 0 and 255`);
          }
        }
        return {
          lowThreshold: v.low as number,
          medThreshold: v.medium as number,
          highThreshold: v.high as number,
          masterWeight: v.master as number,
        };
      }
      case "set_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: set_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: set_flags entries must be numbers between 0 and 255");
        }
        return { setFlags: value.reduce((a, b) => a | b, 0) };
      }
      case "clear_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: clear_flags value must be an array of numbers");
        }
        if (!value.every((n) => typeof n === "number" && n >= 0 && n <= 255)) {
          throw new Error("StellarTransactionBuilder: clear_flags entries must be numbers between 0 and 255");
        }
        return { clearFlags: value.reduce((a, b) => a | b, 0) };
      }
      default:
        throw new Error(`StellarTransactionBuilder: unknown account_settings type: ${intent.setting}`);
    }
  }
}

function assertUint8(value: number, name: string): number {
  if (typeof value !== "number" || !integer(value) || value < 0 || value > 255) {
    throw new Error(`StellarTransactionBuilder: ${name} must be an integer between 0 and 255`);
  }
  return value;
}

function integer(value: number): boolean {
  return Number.isInteger(value);
}

function truncateToMemo(text: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= 28) return text;
  let cutoff = 28;
  while (cutoff > 0 && (encoded[cutoff]! & 0xc0) === 0x80) cutoff--;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, cutoff));
}
