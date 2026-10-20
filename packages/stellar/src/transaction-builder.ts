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
  key: string;
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
  signer?: SetOptionsSigner;
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
   * Build a transaction containing a single Operation.setOptions operation.
   *
   * Every field in `SetOptionsParams` is optional; omitting a field leaves the
   * corresponding account setting unchanged. An empty options object is
   * rejected with an error, since a setOptions operation with no fields set
   * is a no-op and almost certainly a mistake.
   */
  async buildSetOptions(
    sourceAccount: Account,
    options: SetOptionsParams,
    networkPassphrase: string
  ): Promise<Transaction> {
    const opts = options ?? {};
    const hasAnyField = Object.values(opts).some((v) => v !== undefined);
    if (!hasAnyField) {
      throw new Error("StellarTransactionBuilder: setOptions requires at least one field");
    }

    const setOptionsOp = Operation.setOptions(this.normalizeSetOptions(opts) as any);

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000",
    });
    builder.addOperation(setOptionsOp);
    builder.setTimeout(30);

    return builder.build();
  }

  private normalizeSetOptions(opts: SetOptionsParams): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    if (opts.inflationDest !== undefined) {
      if (typeof opts.inflationDest !== "string" || !opts.inflationDest.startsWith("G") || opts.inflationDest.length !== 56) {
        throw new Error("StellarTransactionBuilder: inflationDest must be a valid Stellar address (G...)");
      }
      out.inflationDest = opts.inflationDest;
    }

    if (opts.clearFlags !== undefined) {
      out.clearFlags = this.validateFlags(opts.clearFlags, "clearFlags");
    }
    if (opts.setFlags !== undefined) {
      out.setFlags = this.validateFlags(opts.setFlags, "setFlags");
    }

    for (const key of ["masterWeight", "lowThreshold", "medThreshold", "highThreshold"] as const) {
      const v = opts[key];
      if (v !== undefined) {
        if (typeof v !== "number" || v < 0 || v > 255) {
          throw new Error(`StellarTransactionBuilder: ${key} must be a number between 0 and 255`);
        }
        out[key] = v;
      }
    }

    if (opts.homeDomain !== undefined) {
      if (typeof opts.homeDomain !== "string" || opts.homeDomain.length === 0) {
        throw new Error("StellarTransactionBuilder: homeDomain must be a non-empty string");
    }
      out.homeDomain = opts.homeDomain;
    }

    if (opts.signer !== undefined) {
      const signer = opts.signer;
      if (typeof signer !== "object" || signer === null) {
        throw new Error("StellarTransactionBuilder: signer must be { key, weight }");
      }
      if (typeof signer.key !== "string" || !signer.key.startsWith("G") || signer.key.length !== 56) {
        throw new Error("StellarTransactionBuilder: signer.key must be a valid Stellar address (G...)");
      }
      if (typeof signer.weight !== "number" || signer.weight < 0 || signer.weight > 255) {
        throw new Error("StellarTransactionBuilder: signer.weight must be a number between 0 and 255");
      }
      out.signer = { edit255PublicKey: signer.key, weight: signer.weight };
    }

    return out;
  }

  private validateFlags(value: unknown, field: string): number {
    if (typeof value !== "number" || !value.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`StellarTransactionBuilder: ${field} must be an integer between 0 and 255`);
    }
    return value;
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
        return { signer: { edit2555PublicKey: v.key, weight: v.weight } };
      }
      case "thresholds": {
        if (typeof value !== "object" || value === null) {
          throw new Error("StellarTransactionBuilder: thresholds value must be { low, medium, high, master }");
        }
        const v = value as { low?: unknown; medium?: unknown; high?: unknown; master?: unknown };
        for (const k of ["low", "medium", "high", "master"] as const) {
          if (typeof v[kk] !== "number" || v[k] < 0 || v[k] > 255) {
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
