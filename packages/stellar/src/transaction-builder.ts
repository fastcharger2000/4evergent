import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  type Account,
  type Transaction,
  type OperationOptions,
} from "@stellar/stellar-sdk";
import type { PaymentIntent, TrustlineIntent, AccountSettingsIntent } from "@4evergent/shared";

export interface AssetIdentifier {
  code: string;
  issuer: string | null;
}

/**
 * Options accepted by {@link StellarTransactionBuilder.buildSetOptions}.
 *
 * Every field is optional. Omitting a field leaves the corresponding
 * account setting unchanged on-chain. This is the lower-level primitive
 * that the account-settings intent mapping table consumes.
 */
export interface SetOptionsParams {
  /** Add/update/remove a signer. Weight 0 removes the signer. */
  signer?: {
    ed25519PublicKey: string;
    weight: number;
  };
  /** Flags to set (bitwise-ORed). */
  setFlags?: number;
  /** Flags to clear (bitwise-ORed). */
  clearFlags?: number;
  /** Master key weight (0 disables master key). */
  masterWeight?: number;
  /** Low threshold. */
  lowThreshold?: number;
  /** Medium threshold. */
  medThreshold?: number;
  /** High threshold. */
  highThreshold?: number;
  /** Home domain. */
  homeDomain?: string;
  /** Inflation destination account. */
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
   * Lower-level primitive: build a transaction containing a single
   * `setOptions` operation. Every field in `params` is optional; omitting
   * a field leaves the corresponding account setting unchanged.
   *
   * @param sourceAccount - Stellar account the operation is sourced from.
   * @param params - SetOptions fields to apply.
   * @param networkPassphrase - Network passphrase (e.g. "Test SDH Network ; February 2015").
   * @param reason - Optional memo text (truncated to 28 bytes).
   * @returns A signed-ready Transaction with a single setOptions operation.
   * @throws if `params` is empty (no fields set) -- a setOptions op
   *         with no options is a no-op and would burn a fee without effect.
   */
  async buildSetOptions(
    sourceAccount: Account,
    params: SetOptionsParams,
    networkPassphrase: string,
    reason?: string
  ): Promise<Transaction> {
    const options = this.normalizeSetOptions(params);

    const setOptionsOp = Operation.setOptions(options as OperationOptions.SetOptions);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    if (reason) {
      builder.addMemo(Memo.text(truncateToMemo(reason)));
    }
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  /**
   * Validates and normalizes `SetOptionsParams` into the shape expected
   * by `Operation.setOptions`. Throws on empty options or invalid fields.
   */
  private normalizeSetOptions(params: SetOptionsParams): OperationOptions.SetOptions {
    if (!params || typeof params !== "object") {
      throw new Error("StellarTransactionBuilder: setOptions params object required");
    }

    const options: OperationOptions.SetOptions = {};
    let count = 0;

    if (params.signer !== undefined) {
      const s = params.signer;
      if (typeof s !== "object" || s === null) {
        throw new Error("StellarTransactionBuilder: signer must be { ed25519PublicKey, weight }");
      }
      if (typeof s.ed25519PublicKey !== "string" || !s.ed25519PublicKey.startsWith("G") || s.ed25519PublicKey.length !== 56) {
        throw new Error("StellarTransactionBuilder: signer.ed25519PublicKey must be a valid Stellar address (G...)");
      }
      if (typeof s.weight !== "number" || s.weight < 0 || s.weight > 255) {
        throw new Error("StellarTransactionBuilder: signer.weight must be a number between 0 and 255");
      }
      options.signer = { ed25519PublicKey: s.ed25519PublicKey, weight: s.weight };
      count++;
    }

    if (params.setFlags !== undefined) {
      this.assertFlagsValue("setFlags", params.setFlags);
      options.setFlags = params.setFlags;
      count++;
    }

    if (params.clearFlags !== undefined) {
      this.assertFlagsValue("clearFlags", params.clearFlags);
      options.clearFlags = params.clearFlags;
      count++;
    }

    if (params.masterWeight !== undefined) {
      this.assertWeight("masterWeight", params.masterWeight);
      options.masterWeight = params.masterWeight;
      count++;
    }

    if (params.lowThreshold !== undefined) {
      this.assertWeight("lowThreshold", params.lowThreshold);
      options.lowThreshold = params.lowThreshold;
      count++;
    }

    if (params.medThreshold !== undefined) {
      this.assertWeight("medThreshold", params.medThreshold);
      options.medThreshold = params.medThreshold;
      count++;
    }

    if (params.highThreshold !== undefined) {
      this.assertWeight("highThreshold", params.highThreshold);
      options.highThreshold = params.highThreshold;
      count++;
    }

    if (params.homeDomain !== undefined) {
      if (typeof params.homeDomain !== "string" || params.homeDomain.length === 0) {
        throw new Error("StellarTransactionBuilder: homeDomain must be a non-empty string");
      }
      options.homeDomain = params.homeDomain;
      count++;
    }

    if (params.inflationDest !== undefined) {
      if (typeof params.inflationDest !== "string" || !params.inflationDest.startsWith("G") || params.inflationDest.length !== 56) {
        throw new Error("StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)");
      }
      options.inflationDest = params.inflationDest;
      count++;
    }

    if (count === 0) {
      throw new Error("StellarTransactionBuilder: setOptions requires at least one option field");
    }

    return options;
  }

  private assertFlagsValue(name: string, value: number): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`StellarTransactionBuilder: ${name} must be an integer between 0 and 255`);
    }
  }

  private assertWeight(name: string, value: number): void {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`StellarTransactionBuilder: ${name} must be an integer between 0 and 255`);
    }
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

function truncateToMemo(text: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= 28) return text;
  let cutoff = 28;
  while (cutoff > 0 && (encoded[cutoff]! & 0xc0) === 0x80) cutoff--;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, cutoff));
}
