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

export interface SetOptionsSigner {
  /** Ed25519 public key (G...) or signer key string. */
  key: string;
  /** Weight 0-255. 0 removes the signer. */
  weight: number;
}

export interface SetOptionsParams {
  inflationDest?: string;
  clearFlags?: number;
  setFlags?: number;
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  signer?: SetOptionsSigner | null;
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

function isValidAddress(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("G") && value.length === 56;
}

function isWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function truncateToMemo(reason?: string): string {
  const text = reason ?? "";
  return text.length > 28 ? text.slice(0, 28) : text;
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
   * Lower-level primitive for Stellar's `setOptions` operation.
   *
   * All fields in `SetOptionsParams` are optional; omitting a field leaves the
   * existing account setting unchanged. An empty options object is rejected
   * because the Stellar protocol requires at least one setOptions field.
   */
  async buildSetOptions(
    sourceAccount: Account,
    options: SetOptionsParams,
    networkPassphrase: string
  ): Promise<Transaction> {
    const op = this.resolveSetOptionsOperation(options);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    builder.addOperation(op);
    builder.setTimeout(30);

    return builder.build();
  }

  private resolveSetOptionsOperation(options: SetOptionsParams) {
    if (!options || typeof options !== "object") {
      throw new Error("StellarTransactionBuilder: setOptions options object required");
    }

    const resolved: Record<string, unknown> = {};
    let fieldCount = 0;

    if (options.inflationDest !== undefined) {
      if (!isValidAddress(options.inflationDest)) {
        throw new Error("StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)");
      }
      resolved.inflationDest = options.inflationDest;
      fieldCount++;
    }

    if (options.setFlags !== undefined) {
      if (!isWeight(options.setFlags)) {
        throw new Error("StellarTransactionBuilder: setFlags must be an integer between 0 and 255");
      }
      resolved.setFlags = options.setFlags;
      fieldCount++;
    }

    if (options.clearFlags !== undefined) {
      if (!isWeight(options.clearFlags)) {
        throw new Error("StellarTransactionBuilder: clearFlags must be an integer between 0 and 255");
      }
      resolved.clearFlags = options.clearFlags;
      fieldCount++;
    }

    if (options.masterWeight !== undefined) {
      if (!isWeight(options.masterWeight)) {
        throw new Error("StellarTransactionBuilder: masterWeight must be an integer between 0 and 255");
      }
      resolved.masterWeight = options.masterWeight;
      fieldCount++;
    }

    if (options.lowThreshold !== undefined) {
      if (!isWeight(options.lowThreshold)) {
        throw new Error("StellarTransactionBuilder: lowThreshold must be an integer between 0 and 255");
      }
      resolved.lowThreshold = options.lowThreshold;
      fieldCount++;
    }

    if (options.medThreshold !== undefined) {
      if (!isWeight(options.medThreshold)) {
        throw new Error("StellarTransactionBuilder: medThreshold must be an integer between 0 and 255");
      }
      resolved.medThreshold = options.medThreshold;
      fieldCount++;
    }

    if (options.highThreshold !== undefined) {
      if (!isWeight(options.highThreshold)) {
        throw new Error("StellarTransactionBuilder: highThreshold must be an integer between 0 and 255");
      }
      resolved.highThreshold = options.highThreshold;
      fieldCount++;
    }

    if (options.homeDomain !== undefined) {
      if (typeof options.homeDomain !== "string" || options.homeDomain.length === 0) {
        throw new Error("StellarTransactionBuilder: homeDomain must be a non-empty string");
      }
      resolved.homeDomain = options.homeDomain;
      fieldCount++;
    }

    if (options.signer !== undefined && options.signer !== null) {
      const signer = options.signer;
      if (typeof signer !== "object") {
        throw new Error("StellarTransactionBuilder: signer must be { key, weight }");
      }
      if (!isValidAddress(signer.key)) {
        throw new Error("StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)");
      }
      if (!isWeight(signer.weight)) {
        throw new Error("StellarTransactionBuilder: signer.weight must be an integer between 0 and 255");
      }
      resolved.signer = { ed25519PublicKey: signer.key, weight: signer.weight };
      fieldCount++;
    }

    if (fieldCount === 0) {
      throw new Error("StellarTransactionBuilder: setOptions requires at least one option field");
    }

    return Operation.setOptions(resolved as any);
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
    const setOptionsOp = Operation.setOptions(options as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  private resolveAccountSettingsOptions(intent: AccountSettingsIntent) {
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
        if (!isValidAddress(value)) {
          throw new Error("StellarTransactionBuilder: inflation_destination must be a valid Stellar address (G...)");
        }
        return { inflationDest: value };
      }
      case "signer": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: signer value must be { key, weight }");
        }
        const v = value as { key?: unknown; weight?: unknown };
        if (!isValidAddress(v.key)) {
          throw new Error("StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)");
        }
        if (!isWeight(v.weight)) {
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
          if (!isWeight(v[k])) {
            throw new Error(`StellarTransactionBuilder: thresholds.${k} must be a number between 0 and 255`);
          }
        }
        return {
          lowThreshold: v.low,
          medThreshold: v.medium,
          highThreshold: v.high,
          masterWeight: v.master,
        };
      }
      case "set_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: set_flags value must be an array of numbers");
        }
        if (!value.every((n) => isWeight(n))) {
          throw new Error("StellarTransactionBuilder: set_flags entries must be numbers between 0 and 255");
        }
        return { setFlags: value.reduce((a, b) => a | b, 0) };
      }
      case "clear_flags": {
        if (!Array.isArray(value)) {
          throw new Error("StellarTransactionBuilder: clear_flags value must be an array of numbers");
        }
        if (!value.every((n) => isWeight(n))) {
          throw new Error("StellarTransactionBuilder: clear_flags entries must be numbers between 0 and 255");
        }
        return { clearFlags: value.reduce((a, b) => a | b, 0) };
      }
      default:
        throw new Error(`StellarTransactionBuilder: unsupported account setting "${setting}"`);
    }
  }
}
